from __future__ import annotations

import csv
import json
import math
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import colormaps
from matplotlib.colors import Normalize

from get_data import fetch, format_lap_time, parse_utc
from plot_gg_diagram import paired_accelerations
from tyre_allocations import allocation_for, allocation_sources_for


YEAR = 2024
CIRCUIT = "Sakhir"
SESSION_NAME = "Race"
DRIVER_NUMBER = 63
ELLIPSE_COVERAGE = 0.95

OUTPUT_PATH = Path("2024_bahrain_russell_tyre_performance.png")
CSV_PATH = Path("2024_bahrain_russell_ellipse_by_lap.csv")
JSON_PATH = Path("tyre-analysis-data.json")

COMPOUND_COLORS = {
    "SOFT": "#e13b35",
    "MEDIUM": "#d1a900",
    "HARD": "#59636e",
    "INTERMEDIATE": "#159447",
    "WET": "#2474d2",
    "UNKNOWN": "#7b7282",
}


def compound_label(item: dict) -> str:
    construction = item.get("construction")
    return f"{item.get('compound', 'UNKNOWN')} · {construction}" if construction else item.get("compound", "UNKNOWN")


def seconds_since_epoch(value: str) -> float:
    return parse_utc(value).timestamp()


def indexed_records(records: list[dict]) -> tuple[list[float], list[dict]]:
    ordered = sorted(records, key=lambda record: record["date"])
    return [seconds_since_epoch(record["date"]) for record in ordered], ordered


def records_between(
    index: tuple[list[float], list[dict]],
    start: datetime,
    end: datetime,
    padding_seconds: float = 0.0,
) -> list[dict]:
    times, records = index
    low = bisect_left(times, start.timestamp() - padding_seconds)
    high = bisect_right(times, end.timestamp() + padding_seconds)
    return records[low:high]


def fit_axis_aligned_envelope(
    points: list[dict], coverage: float = ELLIPSE_COVERAGE
) -> dict:
    """Fit the smallest-area axis-aligned ellipse covering a data percentile.

    The fitted vehicle-acceleration envelope is

        (a_x / A_x)^2 + (a_y / A_y)^2 <= 1

    where A_x and A_y are the longitudinal and lateral semi-axes.  A robust
    coverage target is used because the differentiated OpenF1 channels contain
    occasional spikes and because most samples are inside, rather than on, the
    observed boundary.
    """
    lateral = np.abs(
        np.asarray([point["lateral_mps2"] for point in points], dtype=float)
    )
    longitudinal = np.abs(
        np.asarray([point["longitudinal_mps2"] for point in points], dtype=float)
    )
    finite = np.isfinite(lateral) & np.isfinite(longitudinal)
    lateral = lateral[finite]
    longitudinal = longitudinal[finite]
    if lateral.size < 30:
        raise ValueError("At least 30 paired acceleration samples are required.")

    required_count = max(1, math.ceil(coverage * lateral.size))
    lateral_floor = max(float(np.quantile(lateral, coverage)), 0.05)
    lateral_ceiling = max(
        lateral_floor * 3.0,
        float(np.quantile(lateral, 0.999)) * 1.15,
        float(lateral.max()) * 1.02,
    )
    candidates = np.geomspace(lateral_floor * 1.0001, lateral_ceiling, 900)

    best: tuple[float, float, float, float] | None = None
    for lateral_axis in candidates:
        remainder = 1.0 - np.square(lateral / lateral_axis)
        required_longitudinal = np.full(lateral.size, np.inf)
        valid = remainder > 0
        required_longitudinal[valid] = longitudinal[valid] / np.sqrt(remainder[valid])
        ordered = np.sort(required_longitudinal)
        longitudinal_axis = float(ordered[required_count - 1])
        if not math.isfinite(longitudinal_axis) or longitudinal_axis <= 0:
            continue
        score = lateral_axis * longitudinal_axis
        enclosed = float(
            np.mean(
                np.square(lateral / lateral_axis)
                + np.square(longitudinal / longitudinal_axis)
                <= 1.0 + 1e-12
            )
        )
        if enclosed + 1e-12 < coverage:
            continue
        if best is None or score < best[0]:
            best = (score, longitudinal_axis, lateral_axis, enclosed)

    if best is None:
        raise ValueError("Could not fit a finite acceleration envelope.")

    _, longitudinal_axis, lateral_axis, enclosed = best
    return {
        "longitudinal_axis_mps2": longitudinal_axis,
        "lateral_axis_mps2": lateral_axis,
        "coverage": enclosed,
        "sample_count": int(lateral.size),
        "area_proxy": math.pi * longitudinal_axis * lateral_axis,
    }


def find_stint(lap_number: int, stints: list[dict]) -> dict | None:
    return next(
        (
            stint
            for stint in reversed(stints)
            if stint["lap_start"] <= lap_number <= stint["lap_end"]
        ),
        None,
    )


def clean_stint(stint: dict) -> dict:
    return {
        "stint_number": int(stint["stint_number"]),
        "lap_start": int(stint["lap_start"]),
        "lap_end": int(stint["lap_end"]),
        "compound": stint.get("compound") or "UNKNOWN",
        "tyre_age_at_start": int(stint.get("tyre_age_at_start") or 0),
    }


def format_elapsed(seconds: float) -> str:
    hours, remainder = divmod(int(seconds), 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}"


def representative_lap_cutoff(
    laps: list[dict],
    pit_lap_numbers: set[int],
    standing_start_session: bool,
) -> float:
    durations = np.asarray(
        [
            float(lap["lap_duration"])
            for lap in laps
            if not bool(lap.get("is_pit_out_lap"))
            and int(lap["lap_number"]) not in pit_lap_numbers
            and not (standing_start_session and int(lap["lap_number"]) == 1)
        ],
        dtype=float,
    )
    if not durations.size:
        return math.inf

    median_duration = float(np.median(durations))
    mad = float(np.median(np.abs(durations - median_duration)))
    robust_upper = median_duration + max(5.0, 3.0 * 1.4826 * mad)
    pace_upper = float(durations.min()) * 1.12
    return min(robust_upper, pace_upper)


def fetch_analysis(
    session_key: int | None = None,
    driver_number: int = DRIVER_NUMBER,
) -> dict:
    sessions = (
        fetch("sessions", session_key=session_key)
        if session_key is not None
        else fetch(
            "sessions",
            year=YEAR,
            circuit_short_name=CIRCUIT,
            session_name=SESSION_NAME,
        )
    )
    if not sessions:
        raise RuntimeError("The requested session was not found.")
    session = sessions[0]
    session_key = session["session_key"]
    session_name = session.get("session_name") or session.get("session_type") or "Session"

    meetings = fetch("meetings", meeting_key=session["meeting_key"])
    meeting = meetings[0] if meetings else {}
    tyre_allocation = allocation_for(
        session.get("year"), session.get("circuit_short_name")
    )

    drivers = fetch(
        "drivers", session_key=session_key, driver_number=driver_number
    )
    if not drivers:
        raise RuntimeError("The requested driver was not found.")
    driver = drivers[0]

    laps = sorted(
        [
            lap
            for lap in fetch(
                "laps", session_key=session_key, driver_number=driver_number
            )
            if lap.get("date_start") and lap.get("lap_duration") is not None
        ],
        key=lambda lap: lap["lap_number"],
    )
    stints = sorted(
        [
            clean_stint(stint)
            for stint in fetch(
                "stints", session_key=session_key, driver_number=driver_number
            )
        ],
        key=lambda stint: stint["stint_number"],
    )
    if not laps:
        raise RuntimeError("No timed laps were found for the requested driver.")
    if not stints:
        stints = [
            {
                "stint_number": 1,
                "lap_start": int(laps[0]["lap_number"]),
                "lap_end": int(laps[-1]["lap_number"]),
                "compound": "UNKNOWN",
                "tyre_age_at_start": 0,
            }
        ]

    for stint in stints:
        stint["construction"] = (
            tyre_allocation.get(stint["compound"]) if tyre_allocation else None
        )

    try:
        pit_records = fetch(
            "pit", session_key=session_key, driver_number=driver_number
        )
    except HTTPError as exc:
        if exc.code != 404:
            raise
        # Some older OpenF1 sessions expose laps/stints/telemetry but not pit.
        # Stint boundaries below still identify the tyre-change lap.
        pit_records = []

    car_index = indexed_records(
        fetch("car_data", session_key=session_key, driver_number=driver_number)
    )
    location_index = indexed_records(
        fetch("location", session_key=session_key, driver_number=driver_number)
    )

    first_lap_start = parse_utc(laps[0]["date_start"])
    laps_by_number = {int(lap["lap_number"]): lap for lap in laps}
    for stint in stints:
        pit = next(
            (
                record
                for record in pit_records
                if int(record["lap_number"])
                in {stint["lap_start"] - 1, stint["lap_start"]}
            ),
            None,
        )
        stint["pit_event"] = (
            {
                "lap_number": int(pit["lap_number"]),
                "date": pit["date"],
                "race_elapsed_seconds": (
                    parse_utc(pit["date"]) - first_lap_start
                ).total_seconds(),
                "lane_duration_seconds": pit.get("lane_duration"),
            }
            if pit
            else None
        )
        if not stint["pit_event"] and stint["stint_number"] > 1:
            first_stint_lap = laps_by_number.get(stint["lap_start"])
            if first_stint_lap:
                change_date = first_stint_lap["date_start"]
                stint["pit_event"] = {
                    "lap_number": stint["lap_start"] - 1,
                    "date": change_date,
                    "race_elapsed_seconds": (
                        parse_utc(change_date) - first_lap_start
                    ).total_seconds(),
                    "lane_duration_seconds": None,
                    "inferred_from_stint": True,
                }

    pit_lap_numbers = {int(record["lap_number"]) for record in pit_records}
    pit_lap_numbers.update(stint["lap_start"] - 1 for stint in stints[1:])
    standing_start_session = session_name in {"Race", "Sprint"}
    slow_lap_cutoff = representative_lap_cutoff(
        laps, pit_lap_numbers, standing_start_session
    )

    lap_rows = []
    for lap in laps:
        lap_number = int(lap["lap_number"])
        stint = find_stint(lap_number, stints)
        if stint is None:
            continue

        lap_duration = float(lap["lap_duration"])
        is_pit_out = bool(lap.get("is_pit_out_lap"))
        is_pit_in = lap_number in pit_lap_numbers and not is_pit_out
        is_start_lap = standing_start_session and lap_number == 1
        is_slow_lap = (
            not is_pit_out
            and not is_pit_in
            and not is_start_lap
            and lap_duration > slow_lap_cutoff
        )
        excluded_reasons = []
        if is_start_lap:
            excluded_reasons.append("standing start")
        if is_pit_in:
            excluded_reasons.append("pit-in lap")
        if is_pit_out:
            excluded_reasons.append("pit/out lap")
        if is_slow_lap:
            excluded_reasons.append("abnormally slow lap")

        lap_start = parse_utc(lap["date_start"])
        points: list[dict] = []
        ellipse = None
        fit_error = None
        if not excluded_reasons:
            lap_end = lap_start + timedelta(seconds=lap_duration)
            trace = records_between(car_index, lap_start, lap_end)
            location = records_between(location_index, lap_start, lap_end, 1.5)
            try:
                points = paired_accelerations(trace, location, lap)
                ellipse = fit_axis_aligned_envelope(points)
            except (RuntimeError, ValueError) as exc:
                fit_error = str(exc)
                excluded_reasons.append("insufficient telemetry")

        clean_lap = not excluded_reasons and ellipse is not None
        tyre_age = stint["tyre_age_at_start"] + lap_number - stint["lap_start"]

        lap_rows.append(
            {
                "lap_number": lap_number,
                "lap_duration": lap_duration,
                "lap_time": format_lap_time(lap_duration),
                "lap_start": lap["date_start"],
                "race_elapsed_seconds": (lap_start - first_lap_start).total_seconds(),
                "stint_number": stint["stint_number"],
                "compound": stint["compound"],
                "construction": stint.get("construction"),
                "tyre_age_at_start": stint["tyre_age_at_start"],
                "tyre_age_laps": tyre_age,
                "is_pit_in_lap": is_pit_in,
                "is_pit_out_lap": is_pit_out,
                "is_start_lap": is_start_lap,
                "is_slow_lap": is_slow_lap,
                "clean_lap": clean_lap,
                "excluded_reasons": excluded_reasons,
                "ellipse": ellipse,
                "fit_error": fit_error,
                "points": [
                    [
                        round(point["lateral_mps2"], 3),
                        round(point["longitudinal_mps2"], 3),
                    ]
                    for point in points
                ],
            }
        )

    return {
        "metadata": {
            "year": session.get("year"),
            "meeting_name": meeting.get("meeting_name")
            or f"{session.get('country_name') or session.get('circuit_short_name')} Grand Prix",
            "country": session.get("country_name") or session.get("circuit_short_name"),
            "circuit": session.get("circuit_short_name"),
            "session": session_name,
            "session_key": session_key,
            "meeting_key": session.get("meeting_key"),
            "driver_number": driver_number,
            "driver_name": driver["full_name"].title(),
            "team_name": driver.get("team_name"),
            "slow_lap_cutoff_seconds": (
                slow_lap_cutoff if math.isfinite(slow_lap_cutoff) else None
            ),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "equation": "(a_x / A_x)^2 + (a_y / A_y)^2 <= 1",
            "fit_method": "Minimum-area axis-aligned ellipse covering at least 95% of each lap's derived acceleration samples",
            "fit_coverage_target": ELLIPSE_COVERAGE,
            "source": "OpenF1 laps, stints, pit, car_data, and location endpoints",
            "tyre_allocation": tyre_allocation,
            "tyre_allocation_sources": allocation_sources_for(session.get("year")),
            "compound_scope": (
                "OpenF1 supplies the event-relative compound. The tyre lab joins a "
                "reviewed weekend allocation catalogue to show C1-C6 when known."
            ),
        },
        "stints": stints,
        "laps": lap_rows,
    }


def save_outputs(data: dict) -> None:
    JSON_PATH.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    fieldnames = [
        "lap_number",
        "lap_duration",
        "stint_number",
        "compound",
        "construction",
        "tyre_age_at_start",
        "tyre_age_laps",
        "clean_lap",
        "is_pit_in_lap",
        "is_pit_out_lap",
        "is_slow_lap",
        "excluded_reasons",
        "longitudinal_axis_mps2",
        "lateral_axis_mps2",
        "coverage",
        "sample_count",
        "area_proxy",
    ]
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for lap in data["laps"]:
            ellipse = lap["ellipse"] or {}
            writer.writerow(
                {
                    "lap_number": lap["lap_number"],
                    "lap_duration": lap["lap_duration"],
                    "stint_number": lap["stint_number"],
                    "compound": lap["compound"],
                    "construction": lap.get("construction"),
                    "tyre_age_at_start": lap["tyre_age_at_start"],
                    "tyre_age_laps": lap["tyre_age_laps"],
                    "clean_lap": lap["clean_lap"],
                    "is_pit_in_lap": lap["is_pit_in_lap"],
                    "is_pit_out_lap": lap["is_pit_out_lap"],
                    "is_slow_lap": lap["is_slow_lap"],
                    "excluded_reasons": "; ".join(lap["excluded_reasons"]),
                    "longitudinal_axis_mps2": ellipse.get(
                        "longitudinal_axis_mps2"
                    ),
                    "lateral_axis_mps2": ellipse.get("lateral_axis_mps2"),
                    "coverage": ellipse.get("coverage"),
                    "sample_count": ellipse.get("sample_count"),
                    "area_proxy": ellipse.get("area_proxy"),
                }
            )


def plot_analysis(data: dict, selected_stint_number: int = 2) -> None:
    laps = data["laps"]
    stints = data["stints"]
    metadata = data["metadata"]
    selected_stint = next(
        stint
        for stint in stints
        if stint["stint_number"] == selected_stint_number
    )
    selected_laps = [
        lap
        for lap in laps
        if lap["stint_number"] == selected_stint_number and lap["clean_lap"]
    ]

    fig, (time_axis, ellipse_axis) = plt.subplots(
        2, 1, figsize=(14.0, 12.0), dpi=180, gridspec_kw={"height_ratios": [0.9, 1.15]}
    )
    fig.patch.set_facecolor("#f3f1ed")
    for axis in (time_axis, ellipse_axis):
        axis.set_facecolor("#fffdf9")
        axis.grid(True, color="#dcd7cf", linewidth=0.8, alpha=0.75)

    for stint in stints:
        stint_laps = [lap for lap in laps if lap["stint_number"] == stint["stint_number"]]
        color = COMPOUND_COLORS.get(stint["compound"], COMPOUND_COLORS["UNKNOWN"])
        clean = [lap for lap in stint_laps if lap["clean_lap"]]
        trend = np.polyfit(
            np.array([lap["lap_number"] for lap in clean], dtype=float),
            np.array([lap["lap_duration"] for lap in clean], dtype=float),
            1,
        ) if len(clean) >= 3 else None
        time_axis.plot(
            [lap["lap_number"] for lap in clean],
            [lap["lap_duration"] for lap in clean],
            color=color,
            linewidth=1.15,
            alpha=0.42,
        )
        time_axis.scatter(
            [lap["lap_number"] for lap in clean],
            [lap["lap_duration"] for lap in clean],
            color=color,
            edgecolor="#fffdf9",
            linewidth=0.7,
            s=43,
            zorder=3,
            label=(
                f"Stint {stint['stint_number']} · {compound_label(stint)} · "
                f"L{stint['lap_start']}–{stint['lap_end']} · start age "
                f"{stint['tyre_age_at_start']} lap"
                + (f" · trend {trend[0]:+.3f} s/lap" if trend is not None else "")
            ),
        )
        if trend is not None:
            x = np.array([lap["lap_number"] for lap in clean], dtype=float)
            slope, intercept = trend
            time_axis.plot(
                [x.min(), x.max()],
                [slope * x.min() + intercept, slope * x.max() + intercept],
                color=color,
                linewidth=2.25,
            )

    for stint in stints[1:]:
        change_x = stint["lap_start"] - 0.5
        pit = stint.get("pit_event")
        pit_label = (
            f"T+{format_elapsed(pit['race_elapsed_seconds'])} · lane {pit['lane_duration_seconds']:.1f} s"
            if pit and pit.get("lane_duration_seconds") is not None
            else (
                f"T+{format_elapsed(pit['race_elapsed_seconds'])} · change inferred from stint"
                if pit
                else "Pit time unavailable"
            )
        )
        time_axis.axvline(change_x, color="#272320", linestyle=(0, (4, 4)), linewidth=1.0)
        time_axis.text(
            change_x + 0.35,
            0.98,
            f"Change before L{stint['lap_start']}\n{compound_label(stint)}, age {stint['tyre_age_at_start']}\n{pit_label}",
            transform=time_axis.get_xaxis_transform(),
            ha="left",
            va="top",
            fontsize=8.5,
            color="#4f4944",
        )

    time_axis.set_xlim(0.3, max(lap["lap_number"] for lap in laps) + 0.7)
    time_axis.set_xlabel("Race lap")
    time_axis.set_ylabel("Lap time (s)")
    time_axis.set_title("Lap time and tyre stints", loc="left", fontsize=15, pad=12)
    time_axis.legend(
        loc="upper right",
        fontsize=8.3,
        frameon=True,
        facecolor="#fffdf9",
        edgecolor="#cec8c0",
    )
    time_axis.text(
        0.0,
        -0.19,
        (
            "Only representative clean laps set the plot scale and stint trends. Excluded: "
            + ", ".join(
                f"L{lap['lap_number']} ({'/'.join(lap['excluded_reasons'])})"
                for lap in laps
                if not lap["clean_lap"]
            )
        ),
        transform=time_axis.transAxes,
        fontsize=8.8,
        color="#635c56",
    )

    ages = np.array([lap["tyre_age_laps"] for lap in selected_laps], dtype=float)
    normalizer = Normalize(vmin=float(ages.min()), vmax=float(ages.max()))
    color_map = colormaps["viridis"]
    theta = np.linspace(0, 2 * math.pi, 500)
    for lap in selected_laps:
        ellipse = lap["ellipse"]
        color = color_map(normalizer(lap["tyre_age_laps"]))
        ellipse_axis.plot(
            ellipse["lateral_axis_mps2"] * np.cos(theta),
            ellipse["longitudinal_axis_mps2"] * np.sin(theta),
            color=color,
            alpha=0.62,
            linewidth=1.35,
        )

    for lap, alignment in ((selected_laps[0], "left"), (selected_laps[-1], "right")):
        ellipse = lap["ellipse"]
        color = color_map(normalizer(lap["tyre_age_laps"]))
        ellipse_axis.plot(
            ellipse["lateral_axis_mps2"] * np.cos(theta),
            ellipse["longitudinal_axis_mps2"] * np.sin(theta),
            color=color,
            linewidth=3.0,
        )
        x = ellipse["lateral_axis_mps2"] * (0.78 if alignment == "left" else -0.78)
        ellipse_axis.text(
            x,
            ellipse["longitudinal_axis_mps2"] * 0.64,
            f"L{lap['lap_number']} · age {lap['tyre_age_laps']}",
            color=color,
            ha=alignment,
            fontsize=9,
            fontweight="bold",
        )

    maximum = max(
        max(lap["ellipse"]["lateral_axis_mps2"] for lap in selected_laps),
        max(lap["ellipse"]["longitudinal_axis_mps2"] for lap in selected_laps),
    )
    extent = math.ceil(maximum * 1.12 / 5) * 5
    ellipse_axis.set_xlim(-extent, extent)
    ellipse_axis.set_ylim(-extent, extent)
    ellipse_axis.set_aspect("equal", adjustable="box")
    ellipse_axis.axhline(0, color="#8b837c", linewidth=1.0)
    ellipse_axis.axvline(0, color="#8b837c", linewidth=1.0)
    ellipse_axis.set_xlabel("Lateral acceleration, $a_y$ (m/s²)")
    ellipse_axis.set_ylabel("Longitudinal acceleration, $a_x$ (m/s²)")
    ellipse_axis.set_title(
        (
            f"Lap-by-lap 95% acceleration envelopes · Stint {selected_stint_number} "
            f"{compound_label(selected_stint)}"
        ),
        loc="left",
        fontsize=15,
        pad=12,
    )
    colorbar = fig.colorbar(
        plt.cm.ScalarMappable(norm=normalizer, cmap=color_map),
        ax=ellipse_axis,
        pad=0.035,
        fraction=0.04,
    )
    colorbar.set_label("Tyre age at lap start (laps)")
    ellipse_axis.text(
        0.0,
        -0.13,
        (
            r"Envelope equation: $(a_x/A_x)^2 + (a_y/A_y)^2 \leq 1$. "
            "Each line is the minimum-area axis-aligned ellipse covering at least 95% of that lap's samples."
        ),
        transform=ellipse_axis.transAxes,
        fontsize=8.8,
        color="#635c56",
    )

    fig.suptitle(
        f"{metadata['driver_name']} · {metadata['year']} {metadata['country']} GP tyre-performance study",
        x=0.08,
        ha="left",
        fontsize=20,
        fontweight="bold",
    )
    fig.text(
        0.08,
        0.015,
        (
            "OpenF1-derived vehicle accelerations. The ellipses are observed usage envelopes—not isolated tyre friction limits. "
            "Fuel, aero load, traffic, track evolution, weather, and driver input remain confounding variables."
        ),
        fontsize=8.6,
        color="#635c56",
    )
    fig.subplots_adjust(left=0.08, right=0.92, top=0.93, bottom=0.08, hspace=0.43)
    fig.savefig(OUTPUT_PATH, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def main() -> None:
    data = fetch_analysis()
    save_outputs(data)
    plot_analysis(data)
    fitted = sum(lap["ellipse"] is not None for lap in data["laps"])
    print(
        f"Saved {OUTPUT_PATH}, {CSV_PATH}, and {JSON_PATH} for "
        f"{data['metadata']['driver_name']} ({fitted}/{len(data['laps'])} laps fitted)."
    )


if __name__ == "__main__":
    main()
