from __future__ import annotations

import csv
import math
from datetime import timedelta
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

from get_data import (
    fetch,
    find_driver,
    find_matching_lap,
    format_lap_time,
    parse_utc,
    qualifying_best_duration,
)


# Standalone example requested for the first G-G investigation. This does not
# change the dashboard UI and does not treat the observed data as a tyre limit.
YEAR = 2024
CIRCUIT = "Silverstone"
SESSION_NAME = "Qualifying"
MAX_ACCELERATION_MPS2 = 100
OUTPUT_PATH = Path("2024_british_gp_pole_gg_diagram.png")
CSV_PATH = Path("2024_british_gp_pole_gg_points.csv")


def interpolate(points: list[dict], target: float, value_key: str) -> float:
    """Linearly interpolate one time-indexed field at an elapsed time."""
    if target <= points[0]["elapsed"]:
        return float(points[0][value_key])
    if target >= points[-1]["elapsed"]:
        return float(points[-1][value_key])

    low = 0
    high = len(points) - 1
    while low < high:
        middle = (low + high) // 2
        if points[middle]["elapsed"] < target:
            low = middle + 1
        else:
            high = middle

    following = points[low]
    previous = points[low - 1]
    span = following["elapsed"] - previous["elapsed"]
    ratio = 0.0 if span == 0 else (target - previous["elapsed"]) / span
    return float(
        previous[value_key]
        + (following[value_key] - previous[value_key]) * ratio
    )


def interpolated_track_point(points: list[dict], elapsed: float) -> dict:
    return {
        "elapsed": elapsed,
        "x": interpolate(points, elapsed, "x"),
        "y": interpolate(points, elapsed, "y"),
    }


def normalize_track(points: list[dict], lap_duration: float) -> list[dict]:
    points = sorted(points, key=lambda point: point["elapsed"])
    inside = [point for point in points if 0 < point["elapsed"] < lap_duration]
    return [
        interpolated_track_point(points, 0.0),
        *inside,
        interpolated_track_point(points, lap_duration),
    ]


def smooth_track(points: list[dict], radius: int = 2) -> list[dict]:
    result = []
    for index, point in enumerate(points):
        samples = points[
            max(0, index - radius) : min(len(points), index + radius + 1)
        ]
        result.append(
            {
                "elapsed": point["elapsed"],
                "x": sum(sample["x"] for sample in samples) / len(samples),
                "y": sum(sample["y"] for sample in samples) / len(samples),
            }
        )
    return result


def wrapped_angle(angle: float) -> float:
    while angle > math.pi:
        angle -= 2 * math.pi
    while angle < -math.pi:
        angle += 2 * math.pi
    return angle


def derive_longitudinal_acceleration(
    speed_points: list[dict], radius: int = 2
) -> list[dict]:
    """Calculate ax in m/s² from the local slope of speed versus time."""
    result = []
    for index, point in enumerate(speed_points):
        samples = speed_points[
            max(0, index - radius) : min(len(speed_points), index + radius + 1)
        ]
        if len(samples) < 3:
            continue

        times = np.array([sample["elapsed"] for sample in samples])
        speeds = np.array([sample["speed_kmh"] / 3.6 for sample in samples])
        centered_time = times - times.mean()
        denominator = float(np.dot(centered_time, centered_time))
        if denominator <= 0:
            continue

        slope = float(np.dot(centered_time, speeds - speeds.mean()) / denominator)
        if math.isfinite(slope) and abs(slope) <= MAX_ACCELERATION_MPS2:
            result.append({"elapsed": point["elapsed"], "mps2": slope})
    return result


def derive_lateral_acceleration(
    speed_points: list[dict], track_points: list[dict], radius: int = 2
) -> list[dict]:
    """Calculate ay in m/s² from vehicle speed times the track-heading rate."""
    smoothed = smooth_track(track_points)
    result = []
    for index in range(radius, len(smoothed) - radius):
        previous = smoothed[index - radius]
        current = smoothed[index]
        following = smoothed[index + radius]
        incoming_heading = math.atan2(
            current["y"] - previous["y"], current["x"] - previous["x"]
        )
        outgoing_heading = math.atan2(
            following["y"] - current["y"], following["x"] - current["x"]
        )
        heading_time = (following["elapsed"] - previous["elapsed"]) / 2
        if heading_time <= 0:
            continue

        speed_kmh = interpolate(speed_points, current["elapsed"], "speed_kmh")
        turn_rate = wrapped_angle(outgoing_heading - incoming_heading) / heading_time
        acceleration = (speed_kmh / 3.6) * turn_rate
        if math.isfinite(acceleration) and abs(acceleration) <= MAX_ACCELERATION_MPS2:
            result.append({"elapsed": current["elapsed"], "mps2": acceleration})
    return result


def paired_accelerations(
    trace: list[dict], location: list[dict], lap: dict
) -> list[dict]:
    lap_start = parse_utc(lap["date_start"])
    lap_duration = float(lap["lap_duration"])
    speed_points = sorted(
        [
            {
                "elapsed": (parse_utc(point["date"]) - lap_start).total_seconds(),
                "speed_kmh": float(point["speed"]),
            }
            for point in trace
            if point.get("speed") is not None
        ],
        key=lambda point: point["elapsed"],
    )
    raw_track = sorted(
        [
            {
                "elapsed": (parse_utc(point["date"]) - lap_start).total_seconds(),
                "x": float(point["x"]),
                "y": float(point["y"]),
            }
            for point in location
            if point.get("x") is not None and point.get("y") is not None
        ],
        key=lambda point: point["elapsed"],
    )
    if len(speed_points) < 5 or len(raw_track) < 5:
        raise RuntimeError("Not enough OpenF1 samples to derive accelerations.")

    longitudinal = derive_longitudinal_acceleration(speed_points)
    lateral = derive_lateral_acceleration(
        speed_points, normalize_track(raw_track, lap_duration)
    )
    return [
        {
            "elapsed": point["elapsed"],
            "lateral_mps2": point["mps2"],
            "longitudinal_mps2": interpolate(longitudinal, point["elapsed"], "mps2"),
        }
        for point in lateral
    ]


def observed_p99_limits(points: list[dict]) -> tuple[float, float, float]:
    lateral = np.array([point["lateral_mps2"] for point in points])
    longitudinal = np.array([point["longitudinal_mps2"] for point in points])
    lateral_limit = float(np.quantile(np.abs(lateral), 0.99))
    acceleration_limit = float(np.quantile(longitudinal[longitudinal > 0], 0.99))
    braking_limit = float(np.quantile(-longitudinal[longitudinal < 0], 0.99))
    return lateral_limit, acceleration_limit, braking_limit


def fetch_example() -> tuple[dict, dict, dict, list[dict], list[dict]]:
    sessions = fetch(
        "sessions",
        year=YEAR,
        circuit_short_name=CIRCUIT,
        session_name=SESSION_NAME,
    )
    if not sessions:
        raise RuntimeError("The example qualifying session was not found.")
    session = sessions[0]

    results = fetch("session_result", session_key=session["session_key"], position=1)
    if not results:
        raise RuntimeError("The pole result was not found.")
    pole = results[0]
    q3_duration = qualifying_best_duration(pole)
    lap = find_matching_lap(
        session["session_key"], pole["driver_number"], q3_duration
    )
    driver = find_driver(session["session_key"], pole["driver_number"])

    lap_start = parse_utc(lap["date_start"])
    lap_end = lap_start + timedelta(seconds=lap["lap_duration"])
    trace = fetch(
        "car_data",
        session_key=session["session_key"],
        driver_number=pole["driver_number"],
        **{
            "date>": lap_start.isoformat().replace("+00:00", "Z"),
            "date<": lap_end.isoformat().replace("+00:00", "Z"),
        },
    )
    location = fetch(
        "location",
        session_key=session["session_key"],
        driver_number=pole["driver_number"],
        **{
            "date>": (lap_start - timedelta(seconds=1.5))
            .isoformat()
            .replace("+00:00", "Z"),
            "date<": (lap_end + timedelta(seconds=1.5))
            .isoformat()
            .replace("+00:00", "Z"),
        },
    )
    return session, driver, lap, trace, location


def plot_gg(driver: dict, lap: dict, points: list[dict]) -> None:
    elapsed = np.array([point["elapsed"] for point in points])
    lateral = np.array([point["lateral_mps2"] for point in points])
    longitudinal = np.array([point["longitudinal_mps2"] for point in points])
    lateral_limit, acceleration_limit, braking_limit = observed_p99_limits(points)

    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["elapsed", "lateral_mps2", "longitudinal_mps2"]
        )
        writer.writeheader()
        writer.writerows(points)

    fig, axis = plt.subplots(figsize=(10.8, 9.0), dpi=180)
    fig.patch.set_facecolor("#f5f2ee")
    axis.set_facecolor("#fffdf9")
    scatter = axis.scatter(
        lateral,
        longitudinal,
        c=elapsed,
        cmap="turbo",
        s=28,
        alpha=0.82,
        linewidths=0,
        zorder=3,
    )

    # This is deliberately labelled as a visual guide. The three radii are
    # observed P99 values from different moments, not mu*Fz tyre limits.
    theta = np.linspace(0, 2 * np.pi, 500)
    vertical_radius = np.where(
        np.sin(theta) >= 0, acceleration_limit, braking_limit
    )
    axis.plot(
        lateral_limit * np.cos(theta),
        vertical_radius * np.sin(theta),
        color="#302b27",
        linewidth=2,
        linestyle=(0, (6, 5)),
        label="Observed P99 guide — not a tyre limit",
        zorder=2,
    )

    maximum = max(
        np.quantile(np.abs(lateral), 0.995),
        np.quantile(np.abs(longitudinal), 0.995),
    )
    extent = max(1.5, math.ceil(maximum * 1.2 * 2) / 2)
    axis.set_xlim(-extent, extent)
    axis.set_ylim(-extent, extent)
    axis.set_aspect("equal", adjustable="box")
    axis.axhline(0, color="#8b837c", linewidth=1.1, zorder=1)
    axis.axvline(0, color="#8b837c", linewidth=1.1, zorder=1)
    axis.grid(True, color="#ded8d1", linewidth=0.8, alpha=0.82)
    axis.set_xlabel("Lateral acceleration, $a_y$ (m/s²)", fontsize=12, fontweight="bold")
    axis.set_ylabel(
        "Longitudinal acceleration, $a_x$ (m/s²)", fontsize=12, fontweight="bold"
    )
    axis.set_title(
        f"{driver['full_name'].title()} — {YEAR} British GP Q3 pole lap",
        fontsize=18,
        loc="left",
        pad=18,
    )
    axis.text(
        0,
        1.015,
        f"Lap {lap['lap_number']} · {format_lap_time(lap['lap_duration'])} · telemetry-derived G–G diagram",
        transform=axis.transAxes,
        fontsize=11,
        color="#625b55",
        va="bottom",
    )
    axis.legend(loc="lower right", facecolor="#fffdf9", edgecolor="#cfc7bf")
    colorbar = fig.colorbar(scatter, ax=axis, pad=0.035, fraction=0.045)
    colorbar.set_label("Elapsed lap time (s)", fontsize=10, fontweight="bold")
    fig.text(
        0.12,
        0.03,
        (
            f"Observed P99 axes: |lateral| {lateral_limit:.2f} m/s² · acceleration "
            f"{acceleration_limit:.2f} m/s² · braking {braking_limit:.2f} m/s². "
            "The dashed curve is not calculated from μ or Fz."
        ),
        fontsize=9.2,
        color="#625b55",
    )
    fig.subplots_adjust(left=0.11, right=0.89, top=0.88, bottom=0.13)
    fig.savefig(OUTPUT_PATH, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def main() -> None:
    session, driver, lap, trace, location = fetch_example()
    points = paired_accelerations(trace, location, lap)
    plot_gg(driver, lap, points)
    print(
        f"Saved {OUTPUT_PATH} and {CSV_PATH} for {driver['full_name']} "
        f"lap {lap['lap_number']} ({format_lap_time(lap['lap_duration'])}, "
        f"session_key={session['session_key']}, {len(points)} paired samples)."
    )


if __name__ == "__main__":
    main()
