# F1 Dashboard

## Run the GUI

- Double-click `launch_gui.pyw` to open the dashboard without a terminal window.
- Or run `python server.py` from a terminal or IDE.

Close the dashboard window to stop its local server. To run only the server, use
`python server.py --server-only`.

## Standalone G-G example

Run `python plot_gg_diagram.py` to fetch the 2024 British GP Q3 pole lap and
create `2024_british_gp_pole_gg_diagram.png` plus its paired acceleration CSV.
The dots are telemetry-derived vehicle accelerations. The optional dashed P99
guide is an observed visual reference and is not a calculated tyre limit.

The dashboard also includes a linked G-G panel. After plotting a lap, hover or
click the track map to highlight the matching lateral/longitudinal acceleration
sample. The panel displays measured vehicle acceleration and does not infer a
tyre friction limit. Both acceleration axes and readouts use SI units (m/s²).

## Tyre performance study

Run `python plot_tyre_performance.py` to fetch George Russell's 2024 Bahrain GP
race data and generate:

- `2024_bahrain_russell_tyre_performance.png` — lap-time/stint and lap-by-lap
  acceleration-envelope plots.
- `2024_bahrain_russell_ellipse_by_lap.csv` — the fitted `A_x` and `A_y`
  semi-axes for every lap.
- `tyre-analysis-data.json` — the data used by the separate interactive page.

Open `tyre-analysis.html` through the local server, or use the **Open tyre
performance lab** link in the main dashboard header. Click a clean lap in the
lap-time chart to highlight its ellipse, switch between stints, or compare the
median fitted ellipse for all stints. Tyre changes are annotated with the pit
event's elapsed race time and pit-lane duration from OpenF1.

The tyre lab has its own year, Grand Prix, session, and driver selectors. Race,
sprint, and practice sessions are grouped first; qualifying sessions are kept
in a separate short-run group. Standing starts, pit/out laps, and automatically
detected slow laps appear in an excluded-laps strip instead of changing the
lap-time chart scale.

Use **Load as base** for the reference driver/session, then change any of the
four selectors and use **Add comparison**. Up to four selections can be loaded.
The lap-time chart only overlays selections from the same circuit and the same
session name as the base (for example, Race vs Race at Silverstone); other
selections stay available for the median-ellipse comparison. Use Session lap
to compare drivers in one event, or Tyre age to align degradation within each
stint across drivers or years. Each comparison card chooses which stint/tyre is
used in the loaded-selection ellipse overlay.

The fitted equation is `(a_x / A_x)^2 + (a_y / A_y)^2 <= 1`. Each fit is the
minimum-area axis-aligned ellipse covering at least 95% of that lap's derived
vehicle-acceleration samples. This is an observed vehicle-usage envelope, not a
direct tyre friction limit. OpenF1 reports event-relative compound labels such
as SOFT/HARD. The lab joins those labels to its reviewed 2023-2025 weekend
allocation catalogue, so the interface shows labels such as `MEDIUM · C2`.
When an allocation is not in the catalogue, the C-number is shown as
unavailable rather than inferred.

The allocation catalogue is kept in `tyre_allocations.py` and links its Pirelli
press-release sources in the interface. It includes the completed 2023-2025
calendars; later seasons stay unmapped until their weekend choices are reviewed.
