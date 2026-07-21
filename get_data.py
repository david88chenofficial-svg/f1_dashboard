from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

os.environ.setdefault("MPLCONFIGDIR", str(Path(".matplotlib-cache").resolve()))
os.environ.setdefault("XDG_CACHE_HOME", str(Path(".cache").resolve()))

import matplotlib.pyplot as plt


BASE_URL = "https://api.openf1.org/v1"
YEAR = 2026
CIRCUIT = "Silverstone"
SESSION_NAME = "Qualifying"
OUTPUT_PATH = Path("2026_british_gp_pole_speed_trace.png")


def fetch(endpoint: str, **params):
    url = f"{BASE_URL}/{endpoint}?{urlencode(params)}"
    for attempt in range(5):
        try:
            time.sleep(0.4)
            with urlopen(url, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 4:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def format_lap_time(seconds: float) -> str:
    minutes, remainder = divmod(seconds, 60)
    return f"{int(minutes)}:{remainder:06.3f}"


def find_british_gp_qualifying() -> dict:
    sessions = fetch(
        "sessions",
        year=YEAR,
        circuit_short_name=CIRCUIT,
        session_name=SESSION_NAME,
    )
    if not sessions:
        raise RuntimeError(f"No {YEAR} {CIRCUIT} {SESSION_NAME} session found.")
    return sessions[0]


def find_pole_sitter(session_key: int) -> dict:
    results = fetch("session_result", session_key=session_key, position=1)
    if not results:
        raise RuntimeError(f"No pole result found for session_key={session_key}.")
    return results[0]


def qualifying_best_duration(result: dict) -> float:
    duration = result["duration"]
    if isinstance(duration, list):
        valid_durations = [value for value in duration if value is not None]
        if not valid_durations:
            raise RuntimeError("Pole result has no valid qualifying durations.")
        return valid_durations[-1]
    return duration


def find_matching_lap(session_key: int, driver_number: int, target_duration: float) -> dict:
    laps = fetch("laps", session_key=session_key, driver_number=driver_number)
    timed_laps = [
        lap
        for lap in laps
        if lap.get("date_start")
        and lap.get("lap_duration") is not None
        and not lap.get("is_pit_out_lap")
    ]
    if not timed_laps:
        raise RuntimeError(f"No timed laps found for driver {driver_number}.")

    return min(timed_laps, key=lambda lap: abs(lap["lap_duration"] - target_duration))


def find_driver(session_key: int, driver_number: int) -> dict:
    drivers = fetch("drivers", session_key=session_key, driver_number=driver_number)
    if not drivers:
        raise RuntimeError(f"No driver record found for driver {driver_number}.")
    return drivers[0]


def fetch_speed_trace(session_key: int, driver_number: int, lap: dict) -> list[dict]:
    lap_start = parse_utc(lap["date_start"])
    lap_end = lap_start + timedelta(seconds=lap["lap_duration"])
    trace = fetch(
        "car_data",
        session_key=session_key,
        driver_number=driver_number,
        **{
            "date>": lap_start.isoformat().replace("+00:00", "Z"),
            "date<": lap_end.isoformat().replace("+00:00", "Z"),
        },
    )
    if not trace:
        raise RuntimeError("No car_data points found for the pole lap window.")
    return trace


def plot_speed_trace(session: dict, driver: dict, lap: dict, trace: list[dict]) -> None:
    lap_start = parse_utc(lap["date_start"])
    elapsed = [
        (parse_utc(point["date"]) - lap_start).total_seconds()
        for point in trace
    ]
    speeds = [point["speed"] for point in trace]
    team_colour = f"#{driver.get('team_colour') or '00D7B6'}"

    plt.style.use("dark_background")
    fig, ax = plt.subplots(figsize=(12, 6.75))
    ax.plot(elapsed, speeds, color=team_colour, linewidth=2.2)
    ax.fill_between(elapsed, speeds, min(speeds) - 8, color=team_colour, alpha=0.16)

    title = (
        f"{YEAR} British GP Pole Lap Speed Trace\n"
        f"{driver['full_name']} ({driver['team_name']}) - "
        f"Lap {lap['lap_number']} - {format_lap_time(lap['lap_duration'])}"
    )
    ax.set_title(title, fontsize=16, pad=16)
    ax.set_xlabel("Elapsed lap time (s)")
    ax.set_ylabel("Speed (km/h)")
    ax.set_xlim(0, max(elapsed))
    ax.set_ylim(max(0, min(speeds) - 15), max(speeds) + 15)
    ax.grid(True, color="white", alpha=0.15, linewidth=0.8)

    session_start = parse_utc(session["date_start"]).strftime("%Y-%m-%d %H:%M UTC")
    ax.text(
        0.99,
        0.02,
        f"OpenF1 session_key={session['session_key']} | qualifying start {session_start}",
        transform=ax.transAxes,
        ha="right",
        va="bottom",
        fontsize=9,
        color="#c9c9c9",
    )

    fig.tight_layout()
    fig.savefig(OUTPUT_PATH, dpi=180)
    plt.close(fig)


def main() -> None:
    session = find_british_gp_qualifying()
    pole = find_pole_sitter(session["session_key"])
    driver_number = pole["driver_number"]
    best_duration = qualifying_best_duration(pole)
    lap = find_matching_lap(session["session_key"], driver_number, best_duration)
    driver = find_driver(session["session_key"], driver_number)
    trace = fetch_speed_trace(session["session_key"], driver_number, lap)

    plot_speed_trace(session, driver, lap, trace)
    print(
        f"Saved {OUTPUT_PATH} for {driver['full_name']} lap {lap['lap_number']} "
        f"({format_lap_time(lap['lap_duration'])}, {len(trace)} telemetry points)."
    )


if __name__ == "__main__":
    main()
