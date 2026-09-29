const API_BASE = "/api/openf1";
const YEARS = [2026, 2025, 2024, 2023];
const SESSION_ORDER = [
  "Practice 1",
  "Practice 2",
  "Practice 3",
  "Sprint Qualifying",
  "Sprint",
  "Qualifying",
  "Race",
];
const SERIES_COLORS = ["#e10600", "#008c95", "#6f42c1", "#f59e0b", "#111827", "#1d9a4a"];
const MARKER_COLORS = ["#1261a0", "#b14900"];
const CHART_PAD = { top: 28, right: 24, bottom: 54, left: 72 };
const GG_PAD = { top: 22, right: 24, bottom: 56, left: 66 };
const PANEL_GAP = 42;
const MIN_PANEL_HEIGHT = 100;
const MAX_ACCELERATION_MPS2 = 100;
const MAP_SPEED_NEUTRAL_THRESHOLD = 1;
const MAP_SPEED_NEUTRAL_COLOR = "#8f8880";
const METRICS = [
  { key: "speed", label: "Speed", unit: "km/h", minZero: true },
  {
    key: "longitudinal_acceleration",
    label: "Longitudinal acceleration",
    unit: "m/s²",
    derived: true,
    symmetric: true,
    help: "Estimated from the rate of change in speed. Positive is acceleration; negative is braking.",
  },
  {
    key: "lateral_acceleration",
    label: "Lateral acceleration",
    unit: "m/s²",
    derived: true,
    symmetric: true,
    needsLocation: true,
    help: "Estimated from speed and change in direction. Positive and negative values are opposite turning directions.",
  },
  { key: "throttle", label: "Throttle", unit: "%", min: 0, max: 100 },
  { key: "brake", label: "Brake", unit: "%", min: 0, max: 100 },
  { key: "rpm", label: "RPM", unit: "rpm", minZero: true },
  { key: "n_gear", label: "Gear", unit: "gear", min: 1, max: 8, discrete: true },
  { key: "drs", label: "DRS", unit: "state", minZero: true },
];
const SPEED_METRIC = METRICS.find((metric) => metric.key === "speed");
const LONGITUDINAL_ACCELERATION_METRIC = METRICS.find((metric) => metric.key === "longitudinal_acceleration");
const LATERAL_ACCELERATION_METRIC = METRICS.find((metric) => metric.key === "lateral_acceleration");

const state = {
  rows: [],
  cache: new Map(),
  plotted: [],
  hover: null,
  cursor: null,
  markers: [],
  zoom: null,
  interactionFrame: null,
  pendingCursor: null,
  boundsCache: new Map(),
  timeBounds: null,
  trackBounds: null,
  tracePan: null,
  suppressTraceClick: false,
};

const metricOptions = document.querySelector("#metric-options");
const trackMapToggle = document.querySelector("#track-map-toggle");
const dataDeltaToggle = document.querySelector("#data-delta-toggle");
const mapSpeedDeltaToggle = document.querySelector("#map-speed-delta-toggle");
const ggToggle = document.querySelector("#gg-toggle");
const axisModeInputs = [...document.querySelectorAll('input[name="axis-mode"]')];
const comparisonList = document.querySelector("#comparison-list");
const comparisonTemplate = document.querySelector("#comparison-template");
const addButton = document.querySelector("#add-comparison");
const addButtonBottom = document.querySelector("#add-comparison-bottom");
const plotButton = document.querySelector("#plot-button");
const zoomOutButton = document.querySelector("#zoom-out");
const zoomInButton = document.querySelector("#zoom-in");
const resetZoomButton = document.querySelector("#reset-zoom");
const clearMarkersButton = document.querySelector("#clear-markers");
const canvas = document.querySelector("#trace-canvas");
const mapPanel = document.querySelector("#track-map-panel");
const mapCanvas = document.querySelector("#track-map-canvas");
const mapSpeedLegend = document.querySelector("#map-speed-legend");
const ggPanel = document.querySelector("#gg-panel");
const ggCanvas = document.querySelector("#gg-canvas");
const ggStatus = document.querySelector("#gg-status");
const emptyState = document.querySelector("#empty-state");
const legend = document.querySelector("#legend");
const deltaReadout = document.querySelector("#delta-readout");
const statusNode = document.querySelector("#status");
const plotTitle = document.querySelector("#plot-title");
const plotSubtitle = document.querySelector("#plot-subtitle");
const axisStatus = document.querySelector("#axis-status");
const markerStatus = document.querySelector("#marker-status");
const ctx = canvas.getContext("2d");
const mapCtx = mapCanvas.getContext("2d");
const ggCtx = ggCanvas.getContext("2d");

function initMetricOptions() {
  metricOptions.innerHTML = "";
  for (const metric of METRICS) {
    const label = document.createElement("label");
    label.className = "metric-pill";
    if (metric.help) label.title = metric.help;
    label.innerHTML = `
      <input type="checkbox" name="metric" value="${metric.key}" ${metric.key === "speed" ? "checked" : ""}>
      <span>${metric.label}</span>
    `;
    metricOptions.append(label);
  }
}

function selectedMetrics() {
  const keys = [...metricOptions.querySelectorAll('input[name="metric"]:checked')].map((input) => input.value);
  return METRICS.filter((metric) => keys.includes(metric.key));
}

function selectedAxisMode() {
  return axisModeInputs.find((input) => input.checked)?.value ?? "track";
}

function updateAxisStatus() {
  const trackMode = selectedAxisMode() === "track";
  const zoom = state.zoom?.mode === selectedAxisMode() ? state.zoom : null;
  if (trackMode) {
    axisStatus.textContent = zoom
      ? `X-axis: track position (${zoom.minX.toFixed(1)}% to ${zoom.maxX.toFixed(1)}%)`
      : "X-axis: track position (0% to 100%)";
  } else {
    axisStatus.textContent = zoom
      ? `X-axis: elapsed time (${zoom.minX.toFixed(2)}s to ${zoom.maxX.toFixed(2)}s)`
      : "X-axis: elapsed lap time (seconds)";
  }
  axisStatus.classList.toggle("track-axis", trackMode);
}

function cacheKey(endpoint, params) {
  return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

async function openf1(endpoint, params = {}) {
  const key = cacheKey(endpoint, params);
  if (state.cache.has(key)) return state.cache.get(key);

  const url = `${API_BASE}/${endpoint}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenF1 ${endpoint} failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  state.cache.set(key, data);
  return data;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}

function clearOptions(select, placeholder) {
  select.innerHTML = "";
  const option = new Option(placeholder, "");
  option.selected = true;
  select.append(option);
  select.disabled = true;
}

function setOptions(select, items, placeholder = "Select") {
  select.innerHTML = "";
  const prompt = new Option(items.length ? placeholder : "No data", "");
  prompt.disabled = items.length > 0;
  prompt.selected = true;
  select.append(prompt);
  if (!items.length) {
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const item of items) {
    select.append(new Option(item.label ?? placeholder, item.value));
  }
}

function formatLapTime(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${rest}`;
}

function parseDate(value) {
  return new Date(value).getTime();
}

function uniqueDrivers(drivers) {
  const seen = new Map();
  for (const driver of drivers) {
    if (!seen.has(driver.driver_number)) seen.set(driver.driver_number, driver);
  }
  return [...seen.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

function normalizeMeetings(meetings) {
  return meetings
    .filter((meeting) => meeting.meeting_name && !meeting.is_cancelled)
    .sort((a, b) => parseDate(a.date_start) - parseDate(b.date_start));
}

function normalizeSessions(sessions) {
  return sessions
    .filter((session) => SESSION_ORDER.includes(session.session_name) && !session.is_cancelled)
    .sort((a, b) => {
      const orderDiff = SESSION_ORDER.indexOf(a.session_name) - SESSION_ORDER.indexOf(b.session_name);
      return orderDiff || parseDate(a.date_start) - parseDate(b.date_start);
    });
}

function timedLaps(laps) {
  return laps
    .filter((lap) => lap.date_start && Number.isFinite(lap.lap_duration) && !lap.is_pit_out_lap)
    .sort((a, b) => a.lap_number - b.lap_number);
}

function fastestLap(laps) {
  return laps.reduce((best, lap) => {
    if (!best || lap.lap_duration < best.lap_duration) return lap;
    return best;
  }, null);
}

function selectedLapNumbers(row) {
  const select = field(row, "lap");
  return [...select.options]
    .filter((option) => option.selected && option.value)
    .map((option) => Number(option.value))
    .filter(Number.isFinite);
}

function setLapOptions(select, laps) {
  select.innerHTML = "";
  if (!laps.length) {
    const option = new Option("No timed laps", "");
    option.disabled = true;
    select.append(option);
    select.disabled = true;
    return;
  }

  const best = fastestLap(laps);
  for (const lap of laps) {
    const fastestLabel = best?.lap_number === lap.lap_number ? " · fastest" : "";
    select.append(new Option(
      `L${lap.lap_number} - ${formatLapTime(lap.lap_duration)}${fastestLabel}`,
      String(lap.lap_number)
    ));
  }
  select.disabled = false;
}

function enableMultiLapClick(row) {
  const select = field(row, "lap");
  const restoreLapScroll = () => {
    if (!row.lapScrollAnchor) return;

    const restore = () => {
      select.scrollTop = row.lapScrollAnchor.laps;
      comparisonList.scrollTop = row.lapScrollAnchor.comparisons;
    };

    // Chrome may scroll a multi-select to its first selected option after the
    // mouse handler has completed. Restore after that native work as well as
    // immediately so selecting a later lap does not jump back to an early lap.
    restore();
    queueMicrotask(restore);
    setTimeout(restore, 0);
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  };

  select.addEventListener("mousedown", (event) => {
    const option = event.target;
    if (option.tagName !== "OPTION" || option.disabled) return;

    row.lapScrollAnchor = {
      laps: select.scrollTop,
      comparisons: comparisonList.scrollTop,
    };
    event.preventDefault();
    const options = [...select.options].filter((item) => item.value);
    const optionIndex = options.indexOf(option);
    if (event.shiftKey && Number.isInteger(row.lastLapIndex)) {
      const start = Math.min(row.lastLapIndex, optionIndex);
      const end = Math.max(row.lastLapIndex, optionIndex);
      options.forEach((item, index) => {
        if (index >= start && index <= end) item.selected = true;
      });
    } else {
      option.selected = !option.selected;
      row.lastLapIndex = optionIndex;
    }
    select.focus({ preventScroll: true });
    restoreLapScroll();
  });

  select.addEventListener("click", (event) => {
    if (event.target.tagName !== "OPTION" || event.target.disabled) return;
    event.preventDefault();
    restoreLapScroll();
  });
}

function consecutiveLapGroups(laps) {
  const groups = [];
  for (const lap of laps) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (!previous || lap.lap_number !== previous.lap_number + 1) groups.push([lap]);
    else current.push(lap);
  }
  return groups;
}

function field(row, name) {
  return row.element.querySelector(`[data-field="${name}"]`);
}

function setRowLoading(row, loading) {
  row.element.querySelectorAll("select, button").forEach((control) => {
    if (control.tagName === "SELECT") {
      const hasSelectableOption = [...control.options].some((option) => option.value);
      control.disabled = loading || !hasSelectableOption;
      return;
    }
    control.disabled = loading || (control.classList.contains("remove-row") && state.rows.length === 1);
  });
}

async function loadMeetings(row) {
  clearOptions(field(row, "meeting"), "Select Grand Prix");
  clearOptions(field(row, "session"), "Select session");
  clearOptions(field(row, "driver"), "Select driver");
  clearOptions(field(row, "lap"), "Select lap");
  const year = field(row, "year").value;
  if (!year) return;
  setRowLoading(row, true);
  try {
    const meetings = normalizeMeetings(await openf1("meetings", { year }));
    row.meetings = meetings;
    setOptions(
      field(row, "meeting"),
      meetings.map((meeting) => ({
        value: meeting.meeting_key,
        label: meeting.meeting_name,
      })),
      "Select Grand Prix"
    );
  } finally {
    setRowLoading(row, false);
    updateRemoveButtons();
  }
}

async function loadSessions(row) {
  clearOptions(field(row, "session"), "Select session");
  clearOptions(field(row, "driver"), "Select driver");
  clearOptions(field(row, "lap"), "Select lap");
  const meetingKey = field(row, "meeting").value;
  if (!meetingKey) return;
  setRowLoading(row, true);
  try {
    const sessions = normalizeSessions(await openf1("sessions", { meeting_key: meetingKey }));
    row.sessions = sessions;
    setOptions(
      field(row, "session"),
      sessions.map((session) => ({
        value: session.session_key,
        label: session.session_name,
      })),
      "Select session"
    );
  } finally {
    setRowLoading(row, false);
    updateRemoveButtons();
  }
}

async function loadDrivers(row) {
  clearOptions(field(row, "driver"), "Select driver");
  clearOptions(field(row, "lap"), "Select lap");
  const sessionKey = field(row, "session").value;
  if (!sessionKey) return;
  setRowLoading(row, true);
  try {
    const drivers = uniqueDrivers(await openf1("drivers", { session_key: sessionKey }));
    row.drivers = drivers;
    setOptions(
      field(row, "driver"),
      drivers.map((driver) => ({
        value: driver.driver_number,
        label: `${driver.full_name} (${driver.driver_number})`,
      })),
      "Select driver"
    );

    if (!drivers.length) {
      row.laps = [];
      return;
    }
  } finally {
    setRowLoading(row, false);
    updateRemoveButtons();
  }
}

async function loadLaps(row) {
  clearOptions(field(row, "lap"), "Select lap");
  const sessionKey = field(row, "session").value;
  const driverNumber = field(row, "driver").value;
  if (!sessionKey || !driverNumber) return;
  setRowLoading(row, true);
  try {
    const laps = timedLaps(await openf1("laps", { session_key: sessionKey, driver_number: driverNumber }));
    row.laps = laps;
    row.lastLapIndex = null;
    setLapOptions(field(row, "lap"), laps);
  } finally {
    setRowLoading(row, false);
    updateRemoveButtons();
  }
}

function updateRemoveButtons() {
  state.rows.forEach((row, index) => {
    row.element.querySelector(".row-title").textContent = index === 0 ? "Base trace" : `Comparison ${index}`;
    row.element.querySelector(".remove-row").disabled = state.rows.length === 1;
  });
}

async function addRow(copyFrom = state.rows[0]) {
  const fragment = comparisonTemplate.content.cloneNode(true);
  const element = fragment.querySelector(".comparison-row");
  const row = {
    id: crypto.randomUUID(),
    element,
    meetings: [],
    sessions: [],
    drivers: [],
    laps: [],
    lastLapIndex: null,
  };

  const yearSelect = field(row, "year");
  setOptions(yearSelect, YEARS.map((year) => ({ value: year, label: String(year) })), "Select year");
  clearOptions(field(row, "meeting"), "Select Grand Prix");
  clearOptions(field(row, "session"), "Select session");
  clearOptions(field(row, "driver"), "Select driver");
  clearOptions(field(row, "lap"), "Select lap");

  field(row, "year").addEventListener("change", () => loadMeetings(row));
  field(row, "meeting").addEventListener("change", () => loadSessions(row));
  field(row, "session").addEventListener("change", () => loadDrivers(row));
  field(row, "driver").addEventListener("change", () => loadLaps(row));
  enableMultiLapClick(row);
  element.querySelector(".remove-row").addEventListener("click", () => {
    state.rows = state.rows.filter((item) => item.id !== row.id);
    element.remove();
    updateRemoveButtons();
    if (state.plotted.length) plot();
  });

  comparisonList.append(element);
  state.rows.push(row);
  updateRemoveButtons();

  if (copyFrom) await copyRowValues(row, copyFrom);
}

async function copyRowValues(target, source) {
  const sourceLapNumbers = selectedLapNumbers(source).map(String);
  field(target, "year").value = field(source, "year").value;
  if (!field(target, "year").value) return;
  await loadMeetings(target);
  field(target, "meeting").value = field(source, "meeting").value;
  if (!field(target, "meeting").value) return;
  await loadSessions(target);
  field(target, "session").value = field(source, "session").value;
  if (!field(target, "session").value) return;
  await loadDrivers(target);
  field(target, "driver").value = field(source, "driver").value;
  if (!field(target, "driver").value) return;
  await loadLaps(target);
  [...field(target, "lap").options].forEach((option) => {
    option.selected = sourceLapNumbers.includes(option.value);
  });
}

function selectedObject(items, key, value) {
  return items.find((item) => String(item[key]) === String(value));
}

async function buildSeries(row, index, metrics, includeLocation, selectedLapNumber = null, prefetched = null) {
  const sessionKey = field(row, "session").value;
  const driverNumber = field(row, "driver").value;
  const lapNumber = selectedLapNumber ?? selectedLapNumbers(row)[0];
  const meeting = selectedObject(row.meetings, "meeting_key", field(row, "meeting").value);
  const session = selectedObject(row.sessions, "session_key", sessionKey);
  const driver = selectedObject(row.drivers, "driver_number", driverNumber);
  const lap = selectedObject(row.laps, "lap_number", lapNumber);
  if (!meeting || !session || !driver || !lap) {
    throw new Error("Missing a selection before plotting.");
  }

  const lapStart = new Date(lap.date_start);
  const lapEnd = new Date(lapStart.getTime() + lap.lap_duration * 1000);
  const traceRequest = prefetched
    ? Promise.resolve(prefetched.trace)
    : metrics.length
    ? openf1("car_data", {
        session_key: sessionKey,
        driver_number: driverNumber,
        "date>": lapStart.toISOString(),
        "date<": lapEnd.toISOString(),
      })
    : Promise.resolve([]);
  const locationRequest = prefetched
    ? Promise.resolve(prefetched.location)
    : includeLocation
    ? openf1("location", {
        session_key: sessionKey,
        driver_number: driverNumber,
        "date>": new Date(lapStart.getTime() - 1500).toISOString(),
        "date<": new Date(lapEnd.getTime() + 1500).toISOString(),
      })
    : Promise.resolve([]);
  const [groupTrace, groupLocation] = await Promise.all([traceRequest, locationRequest]);
  const lapStartMs = lapStart.getTime();
  const lapEndMs = lapEnd.getTime();
  const trace = groupTrace.filter((point) => {
    const timestamp = new Date(point.date).getTime();
    return timestamp >= lapStartMs && timestamp <= lapEndMs;
  });
  const location = groupLocation.filter((point) => {
    const timestamp = new Date(point.date).getTime();
    return timestamp >= lapStartMs - 1500 && timestamp <= lapEndMs + 1500;
  });
  const pointsByMetric = {};
  const rawSpeedPoints = trace
    .filter((point) => point.speed !== null && Number.isFinite(point.speed))
    .map((point) => ({
      x: (new Date(point.date).getTime() - lapStart.getTime()) / 1000,
      y: point.speed,
    }))
    .sort((a, b) => a.x - b.x);
  for (const metric of metrics.filter((item) => !item.derived)) {
    pointsByMetric[metric.key] = metric.key === "speed"
      ? rawSpeedPoints
      : trace
          .filter((point) => point[metric.key] !== null && Number.isFinite(point[metric.key]))
          .map((point) => ({
            x: (new Date(point.date).getTime() - lapStart.getTime()) / 1000,
            y: point[metric.key],
          }))
          .sort((a, b) => a.x - b.x);
  }
  const rawTrackPoints = location
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      elapsed: (new Date(point.date).getTime() - lapStart.getTime()) / 1000,
      x: point.x,
      y: point.y,
    }));
  const trackPoints = normalizeTrackPoints(rawTrackPoints, lap.lap_duration);
  const progressPoints = buildProgressPoints(trackPoints);
  if (metrics.some((metric) => metric.key === "longitudinal_acceleration")) {
    pointsByMetric.longitudinal_acceleration = deriveLongitudinalAcceleration(rawSpeedPoints);
  }
  if (metrics.some((metric) => metric.key === "lateral_acceleration")) {
    pointsByMetric.lateral_acceleration = deriveLateralAcceleration(rawSpeedPoints, trackPoints);
  }

  const missingMetrics = metrics.filter((metric) => !pointsByMetric[metric.key]?.length);
  if (metrics.length && missingMetrics.length === metrics.length) {
    throw new Error(`No selected telemetry fields for ${driver.full_name}.`);
  }
  if (selectedAxisMode() === "track" && !progressPoints.length) {
    throw new Error(`No location data available to build a track-position axis for ${driver.full_name}.`);
  }

  return {
    color: SERIES_COLORS[index % SERIES_COLORS.length],
    driver,
    lap,
    meeting,
    session,
    pointsByMetric,
    trackPoints,
    progressPoints,
  };
}

async function buildRowSeries(row, metrics, includeLocation) {
  const sessionKey = field(row, "session").value;
  const driverNumber = field(row, "driver").value;
  const selectedNumbers = selectedLapNumbers(row);
  const laps = row.laps.filter((lap) => selectedNumbers.includes(lap.lap_number));
  if (!sessionKey || !driverNumber || !laps.length) {
    throw new Error("Select at least one lap in every selection before plotting.");
  }

  const dataByLap = new Map();
  await Promise.all(consecutiveLapGroups(laps).map(async (group) => {
    const firstStart = new Date(group[0].date_start);
    const lastLap = group[group.length - 1];
    const lastEnd = new Date(new Date(lastLap.date_start).getTime() + lastLap.lap_duration * 1000);
    const traceRequest = metrics.length
      ? openf1("car_data", {
          session_key: sessionKey,
          driver_number: driverNumber,
          "date>": firstStart.toISOString(),
          "date<": lastEnd.toISOString(),
        })
      : Promise.resolve([]);
    const locationRequest = includeLocation
      ? openf1("location", {
          session_key: sessionKey,
          driver_number: driverNumber,
          "date>": new Date(firstStart.getTime() - 1500).toISOString(),
          "date<": new Date(lastEnd.getTime() + 1500).toISOString(),
        })
      : Promise.resolve([]);
    const [trace, location] = await Promise.all([traceRequest, locationRequest]);
    group.forEach((lap) => dataByLap.set(lap.lap_number, { trace, location }));
  }));

  return Promise.all(laps.map((lap) => buildSeries(
    row,
    0,
    metrics,
    includeLocation,
    lap.lap_number,
    dataByLap.get(lap.lap_number)
  )));
}

function seriesColor(index) {
  if (index < SERIES_COLORS.length) return SERIES_COLORS[index];
  return `hsl(${Math.round((index * 137.508) % 360)} 68% 42%)`;
}

async function plot() {
  const metrics = selectedMetrics();
  const includeMap = trackMapToggle.checked;
  const includeGG = ggToggle.checked;
  updateAxisStatus();
  if (!metrics.length && !includeMap && !includeGG) {
    setStatus("Select at least one data field, the track map, or the G–G diagram.", true);
    return;
  }
  plotButton.disabled = true;
  emptyState.hidden = true;
  setStatus("Loading OpenF1 telemetry...");
  try {
    const selectedCount = state.rows.reduce((total, row) => total + selectedLapNumbers(row).length, 0);
    const includeMapSpeed = includeMap && mapSpeedDeltaToggle.checked && selectedCount > 1;
    let dataMetrics = includeMapSpeed && !metrics.some((metric) => metric.key === "speed")
      ? [...metrics, SPEED_METRIC]
      : metrics;
    if (includeGG) {
      for (const metric of [LONGITUDINAL_ACCELERATION_METRIC, LATERAL_ACCELERATION_METRIC]) {
        if (!dataMetrics.some((item) => item.key === metric.key)) {
          dataMetrics = [...dataMetrics, metric];
        }
      }
    }
    const includeLocation = includeMap
      || includeGG
      || selectedCount > 1
      || selectedAxisMode() === "track"
      || dataMetrics.some((metric) => metric.needsLocation);
    const series = (await Promise.all(
      state.rows.map((row) => buildRowSeries(row, dataMetrics, includeLocation))
    )).flat();
    series.forEach((item, index) => { item.color = seriesColor(index); });
    prepareSeriesData(series, dataMetrics);
    state.plotted = series;
    state.metrics = metrics;
    state.timeBounds = chartBounds(series);
    state.trackBounds = trackBounds(series);
    state.boundsCache.clear();
    state.hover = null;
    state.cursor = null;
    state.markers = [];
    state.zoom = null;
    updateMarkerControls();
    updateZoomControls();
    updateDeltaReadout(finalCursor());
    plotTitle.textContent = metrics.length === 1
      ? `${metrics[0].label} trace`
      : metrics.length > 1 ? `${metrics.length} telemetry traces` : "Track map";
    updatePlotSubtitle();
    renderLegend(series);
    updateChartHeight(panelDefinitions(metrics).length);
    drawChart();
    drawTrackMap();
    drawGGDiagram();
    setStatus(`Plotted ${series.length} comparison lap${series.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
    emptyState.hidden = state.plotted.length > 0;
  } finally {
    plotButton.disabled = false;
  }
}

function updatePlotSubtitle() {
  const series = state.plotted;
  if (!series.length) return;
  const metrics = state.metrics ?? selectedMetrics();
  const axisLabel = selectedAxisMode() === "track" ? "track-position" : "elapsed-time";
  const mapDescription = trackMapToggle.checked
    ? mapSpeedDeltaToggle.checked && series.length > 1 ? " and speed-advantage track map" : " and track map"
    : "";
  const ggDescription = ggToggle.checked ? " and linked G–G diagram" : "";
  plotSubtitle.textContent = `${series.length} comparison lap${series.length === 1 ? "" : "s"}${metrics.length ? ` across ${metrics.length} data field${metrics.length === 1 ? "" : "s"}` : ""} on an ${axisLabel} axis${dataDeltaToggle.checked && series.length > 1 ? " with data deltas" : ""}${mapDescription}${ggDescription}.`;
}

function ggPointsForSeries(series) {
  const lateral = series.pointsByMetric.lateral_acceleration ?? [];
  const longitudinal = series.pointsByMetric.longitudinal_acceleration ?? [];
  if (!lateral.length || !longitudinal.length) return [];
  return lateral.map((point) => {
    const longitudinalG = interpolateField(longitudinal, "x", point.x, "y");
    return Number.isFinite(longitudinalG)
      ? { elapsed: point.x, x: point.y, y: longitudinalG }
      : null;
  }).filter((point) => point && Math.abs(point.x) <= MAX_ACCELERATION_MPS2 && Math.abs(point.y) <= MAX_ACCELERATION_MPS2);
}

function ggPointAtCursor(series, cursor) {
  if (!cursor) return null;
  const elapsed = elapsedForCursor(series, cursor);
  if (!Number.isFinite(elapsed)) return null;
  const lateralAcceleration = metricValueAtElapsed(series, LATERAL_ACCELERATION_METRIC, elapsed);
  const longitudinalAcceleration = metricValueAtElapsed(series, LONGITUDINAL_ACCELERATION_METRIC, elapsed);
  if (!Number.isFinite(lateralAcceleration) || !Number.isFinite(longitudinalAcceleration)) return null;
  return { elapsed, x: lateralAcceleration, y: longitudinalAcceleration };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const ratio = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * ratio;
}

function resizeGGCanvas() {
  const rect = ggCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
  const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
  if (ggCanvas.width !== targetWidth || ggCanvas.height !== targetHeight) {
    ggCanvas.width = targetWidth;
    ggCanvas.height = targetHeight;
  }
  ggCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function ggExtent(points) {
  const magnitudes = points.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]);
  const robustMaximum = percentile(magnitudes, 0.995);
  return Math.max(10, Math.ceil((robustMaximum * 1.15) / 5) * 5);
}

function drawGGCursor(cursor, pinned, layout) {
  if (!cursor) return;
  const { left, top, size, extent, xScale, yScale } = layout;
  const points = state.plotted
    .map((series) => ({ series, point: ggPointAtCursor(series, cursor) }))
    .filter((item) => item.point);
  if (!points.length) return;

  ggCtx.save();
  ggCtx.beginPath();
  ggCtx.rect(left, top, size, size);
  ggCtx.clip();
  points.forEach(({ series, point }, index) => {
    if (Math.abs(point.x) > extent || Math.abs(point.y) > extent) return;
    const x = xScale(point.x);
    const y = yScale(point.y);
    if (index === 0) {
      ggCtx.strokeStyle = pinned ? "rgba(225, 6, 0, 0.48)" : "rgba(39, 39, 39, 0.28)";
      ggCtx.lineWidth = 1;
      ggCtx.setLineDash([4, 4]);
      ggCtx.beginPath();
      ggCtx.moveTo(xScale(0), y);
      ggCtx.lineTo(x, y);
      ggCtx.lineTo(x, yScale(0));
      ggCtx.stroke();
      ggCtx.setLineDash([]);
    }
    ggCtx.fillStyle = "#fffdf9";
    ggCtx.beginPath();
    ggCtx.arc(x, y, pinned ? 9 : 8, 0, Math.PI * 2);
    ggCtx.fill();
    ggCtx.strokeStyle = series.color;
    ggCtx.lineWidth = pinned ? 3 : 2;
    ggCtx.beginPath();
    ggCtx.arc(x, y, pinned ? 6 : 5, 0, Math.PI * 2);
    ggCtx.fillStyle = series.color;
    ggCtx.fill();
    ggCtx.stroke();
  });
  ggCtx.restore();
}

function ggDrivingState(point) {
  if (Math.abs(point.x) < 3) {
    if (point.y < -3) return "straight-line braking";
    if (point.y > 3) return "straight-line acceleration";
    return "straight / low combined load";
  }
  if (point.y < -3) return "trail braking / combined load";
  if (point.y > 3) return "corner exit / combined load";
  return "cornering";
}

function drawGGDiagram() {
  ggPanel.hidden = !ggToggle.checked || !state.plotted.length;
  if (ggPanel.hidden) return;

  resizeGGCanvas();
  const width = ggCanvas.clientWidth;
  const height = ggCanvas.clientHeight;
  ggCtx.clearRect(0, 0, width, height);
  ggCtx.fillStyle = "#fffdf9";
  ggCtx.fillRect(0, 0, width, height);

  const seriesPoints = state.plotted.map((series) => ({ series, points: ggPointsForSeries(series) }));
  const allPoints = seriesPoints.flatMap((item) => item.points);
  if (!allPoints.length) {
    ggStatus.textContent = "No paired acceleration samples are available for this lap";
    ggCtx.fillStyle = "#68625d";
    ggCtx.font = "14px system-ui, sans-serif";
    ggCtx.textAlign = "center";
    ggCtx.fillText("No G–G data", width / 2, height / 2);
    return;
  }

  const extent = ggExtent(allPoints);
  const availableWidth = Math.max(1, width - GG_PAD.left - GG_PAD.right);
  const availableHeight = Math.max(1, height - GG_PAD.top - GG_PAD.bottom);
  const size = Math.min(availableWidth, availableHeight);
  const left = GG_PAD.left + (availableWidth - size) / 2;
  const top = GG_PAD.top + (availableHeight - size) / 2;
  const xScale = (value) => left + ((value + extent) / (2 * extent)) * size;
  const yScale = (value) => top + (1 - (value + extent) / (2 * extent)) * size;
  const tickStep = extent <= 10 ? 2 : extent <= 25 ? 5 : 10;

  ggCtx.font = "11px system-ui, sans-serif";
  ggCtx.textAlign = "center";
  ggCtx.textBaseline = "top";
  for (let value = -extent; value <= extent + 1e-9; value += tickStep) {
    const x = xScale(value);
    const y = yScale(value);
    ggCtx.strokeStyle = Math.abs(value) < 1e-9 ? "#8b837c" : "#e3ddd5";
    ggCtx.lineWidth = Math.abs(value) < 1e-9 ? 1.3 : 1;
    ggCtx.beginPath();
    ggCtx.moveTo(x, top);
    ggCtx.lineTo(x, top + size);
    ggCtx.stroke();
    ggCtx.beginPath();
    ggCtx.moveTo(left, y);
    ggCtx.lineTo(left + size, y);
    ggCtx.stroke();
    ggCtx.fillStyle = "#68625d";
    const label = Math.abs(value) < 1e-9 ? "0" : value.toFixed(0);
    ggCtx.fillText(label, x, top + size + 7);
    ggCtx.textAlign = "right";
    ggCtx.textBaseline = "middle";
    ggCtx.fillText(label, left - 9, y);
    ggCtx.textAlign = "center";
    ggCtx.textBaseline = "top";
  }

  ggCtx.fillStyle = "#171717";
  ggCtx.font = "700 12px system-ui, sans-serif";
  ggCtx.fillText("Lateral acceleration, aᵧ (m/s²)", left + size / 2, height - 21);
  ggCtx.save();
  ggCtx.translate(17, top + size / 2);
  ggCtx.rotate(-Math.PI / 2);
  ggCtx.fillText("Longitudinal acceleration, aₓ (m/s²)", 0, 0);
  ggCtx.restore();

  ggCtx.save();
  ggCtx.beginPath();
  ggCtx.rect(left, top, size, size);
  ggCtx.clip();
  for (const item of seriesPoints) {
    ggCtx.fillStyle = item.series.color;
    ggCtx.globalAlpha = state.plotted.length === 1 ? 0.42 : 0.3;
    for (const point of item.points) {
      if (Math.abs(point.x) > extent || Math.abs(point.y) > extent) continue;
      ggCtx.beginPath();
      ggCtx.arc(xScale(point.x), yScale(point.y), 2.15, 0, Math.PI * 2);
      ggCtx.fill();
    }
  }
  ggCtx.restore();

  const layout = { left, top, size, extent, xScale, yScale };
  drawGGCursor(state.cursor, true, layout);
  drawGGCursor(state.hover, false, layout);

  const activeCursor = state.hover || state.cursor;
  const activePoint = ggPointAtCursor(state.plotted[0], activeCursor);
  if (activePoint) {
    ggStatus.textContent = `${driverShortName(state.plotted[0])} · ${activePoint.elapsed.toFixed(2)}s · aᵧ ${activePoint.x.toFixed(2)} m/s² · aₓ ${activePoint.y.toFixed(2)} m/s² · ${ggDrivingState(activePoint)}`;
  } else {
    ggStatus.textContent = `${allPoints.length} measured acceleration samples · hover the track map to highlight one`;
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
  const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function updateChartHeight(panelCount) {
  const wrap = canvas.closest(".canvas-wrap");
  wrap.style.height = "";

  const minimumHeight = CHART_PAD.top + CHART_PAD.bottom
    + panelCount * MIN_PANEL_HEIGHT
    + Math.max(0, panelCount - 1) * PANEL_GAP;
  wrap.style.minHeight = `${Math.max(420, minimumHeight)}px`;
}

function chartBounds(series) {
  const all = series.flatMap((item) => Object.values(item.pointsByMetric).flat());
  const trackPoints = series.flatMap((item) => item.trackPoints ?? []);
  const source = all.length ? all : trackPoints.map((point) => ({ x: point.elapsed }));
  const maxX = Math.max(1, ...source.map((point) => point.x).filter(Number.isFinite));
  return {
    minX: 0,
    maxX,
  };
}

function fullAxisBounds() {
  if (selectedAxisMode() === "track") return { minX: 0, maxX: 100 };
  return state.timeBounds ?? (state.plotted.length ? chartBounds(state.plotted) : { minX: 0, maxX: 1 });
}

function activeAxisBounds() {
  const full = fullAxisBounds();
  const zoom = state.zoom?.mode === selectedAxisMode() ? state.zoom : null;
  if (!zoom) return full;
  return {
    minX: Math.max(full.minX, zoom.minX),
    maxX: Math.min(full.maxX, zoom.maxX),
  };
}

function updateZoomControls() {
  const hasPlot = state.plotted.length > 0;
  zoomInButton.disabled = !hasPlot;
  zoomOutButton.disabled = !hasPlot || !state.zoom;
  resetZoomButton.disabled = !hasPlot || !state.zoom;
  canvas.classList.toggle("is-zoomed", Boolean(state.zoom));
  updateAxisStatus();
}

function setZoomBounds(minX, maxX, source = "manual") {
  const full = fullAxisBounds();
  const fullSpan = full.maxX - full.minX;
  const minimumSpan = selectedAxisMode() === "track" ? 0.5 : 0.25;
  let nextMin = Math.max(full.minX, Math.min(minX, maxX));
  let nextMax = Math.min(full.maxX, Math.max(minX, maxX));

  if (nextMax - nextMin < minimumSpan) {
    const center = (nextMin + nextMax) / 2;
    nextMin = center - minimumSpan / 2;
    nextMax = center + minimumSpan / 2;
    if (nextMin < full.minX) {
      nextMax += full.minX - nextMin;
      nextMin = full.minX;
    }
    if (nextMax > full.maxX) {
      nextMin -= nextMax - full.maxX;
      nextMax = full.maxX;
    }
  }

  state.zoom = nextMax - nextMin >= fullSpan * 0.999
    ? null
    : { mode: selectedAxisMode(), minX: nextMin, maxX: nextMax, source };
  updateZoomControls();
  drawChart();
}

function zoomBy(factor, centerX = null) {
  if (!state.plotted.length) return;
  const full = fullAxisBounds();
  const current = activeAxisBounds();
  const center = Number.isFinite(centerX) ? centerX : (current.minX + current.maxX) / 2;
  const nextSpan = Math.min(full.maxX - full.minX, (current.maxX - current.minX) * factor);
  const centerRatio = (center - current.minX) / (current.maxX - current.minX || 1);
  const nextMin = center - nextSpan * centerRatio;
  setZoomBounds(nextMin, nextMin + nextSpan);
}

function panZoomBy(deltaX) {
  const zoom = state.zoom?.mode === selectedAxisMode() ? state.zoom : null;
  if (!zoom || !Number.isFinite(deltaX)) return;
  const full = fullAxisBounds();
  const span = zoom.maxX - zoom.minX;
  let minX = zoom.minX + deltaX;
  let maxX = minX + span;
  if (minX < full.minX) {
    minX = full.minX;
    maxX = minX + span;
  }
  if (maxX > full.maxX) {
    maxX = full.maxX;
    minX = maxX - span;
  }
  state.zoom = { mode: selectedAxisMode(), minX, maxX, source: "pan" };
  updateZoomControls();
  drawChart();
}

function resetZoom() {
  state.zoom = null;
  updateZoomControls();
  drawChart();
}

function markerAxisValue(progress, mode = selectedAxisMode()) {
  if (mode === "track") return progress * 100;
  return elapsedAtProgress(state.plotted[0], progress);
}

function applyMarkerZoom() {
  if (state.markers.length !== 2) return;
  const values = state.markers
    .map((progress) => markerAxisValue(progress))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (values.length === 2) setZoomBounds(values[0], values[1], "markers");
}

function updateMarkerControls() {
  clearMarkersButton.disabled = state.markers.length === 0;
  markerStatus.textContent = state.markers.length
    ? state.markers.map((progress, index) => `${index === 0 ? "A" : "B"} ${(progress * 100).toFixed(1)}%`).join(" · ")
    : "No markers";
}

function clearMarkers() {
  state.markers = [];
  state.zoom = null;
  state.cursor = null;
  state.hover = null;
  updateMarkerControls();
  updateZoomControls();
  updateDeltaReadout(finalCursor());
  drawChart();
  drawTrackMap();
  drawGGDiagram();
}

function metricBounds(series, metric) {
  const points = series.flatMap((item) => item.pointsByMetric[metric.key] ?? []);
  const values = points.map((point) => point.y);
  if (!values.length) {
    return metric.symmetric ? { minY: -1, maxY: 1 } : { minY: 0, maxY: 1 };
  }
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  if (Number.isFinite(metric.min) && Number.isFinite(metric.max)) {
    return { minY: metric.min, maxY: metric.max };
  }
  if (metric.symmetric) {
    const extent = Math.max(0.25, Math.abs(minY), Math.abs(maxY)) * 1.12;
    return { minY: -extent, maxY: extent };
  }
  const padY = Math.max(metric.key === "n_gear" ? 1 : 8, (maxY - minY) * 0.12);
  return {
    minY: metric.minZero ? Math.max(0, minY - padY) : minY - padY,
    maxY: maxY + padY,
  };
}

function panelDefinitions(metrics) {
  const xMode = selectedAxisMode();
  const includeDelta = dataDeltaToggle.checked && state.plotted.length > 1;
  return metrics.flatMap((metric) => [
    { type: "raw", metric, xMode },
    ...(includeDelta ? [{ type: "delta", metric, xMode }] : []),
  ]);
}

function metricValueAtElapsed(series, metric, elapsed) {
  return interpolateField(series.pointsByMetric[metric.key] ?? [], "x", elapsed, "y");
}

function prepareSeriesData(series, metrics) {
  const reference = series[0];
  for (const item of series) {
    item.axisPoints = { time: item.pointsByMetric, track: {} };
    item.deltaPoints = { time: {}, track: {} };
    item.hitTrackPoints = resampledTrackPoints(item.trackPoints ?? []);
    for (const metric of metrics) metricPointsForAxis(item, metric, "track");
  }

  for (const item of series.slice(1)) {
    for (const metric of metrics) {
      metricDeltaPoints(item, reference, metric, "time");
      metricDeltaPoints(item, reference, metric, "track");
    }
  }
}

function metricPointsForAxis(series, metric, mode) {
  const cached = series.axisPoints?.[mode]?.[metric.key];
  if (cached) return cached;
  if (mode === "time") return series.pointsByMetric[metric.key] ?? [];

  const points = (series.pointsByMetric[metric.key] ?? [])
    .map((point) => {
      const progress = progressAtElapsed(series, point.x);
      return Number.isFinite(progress) ? { x: progress * 100, y: point.y } : null;
    })
    .filter(Boolean);
  if (series.axisPoints) series.axisPoints.track[metric.key] = points;
  return points;
}

function metricDeltaPoints(series, reference, metric, mode) {
  const cached = series.deltaPoints?.[mode]?.[metric.key];
  if (cached) return cached;
  const referencePoints = metricPointsForAxis(reference, metric, mode);
  const seriesPoints = metricPointsForAxis(series, metric, mode);
  if (!referencePoints.length || !seriesPoints.length) return [];

  const minX = Math.max(referencePoints[0].x, seriesPoints[0].x);
  const maxX = Math.min(referencePoints[referencePoints.length - 1].x, seriesPoints[seriesPoints.length - 1].x);
  const axisValues = [...referencePoints, ...seriesPoints]
    .map((point) => point.x)
    .filter((x) => x >= minX && x <= maxX)
    .sort((a, b) => a - b)
    .filter((x, index, values) => index === 0 || Math.abs(x - values[index - 1]) > 1e-9);
  const points = axisValues.map((x) => {
    const referencePoint = interpolatePlotPoint(referencePoints, x, metric.discrete);
    const seriesPoint = interpolatePlotPoint(seriesPoints, x, metric.discrete);
    return { x, y: seriesPoint.y - referencePoint.y };
  });
  if (series.deltaPoints) series.deltaPoints[mode][metric.key] = points;
  return points;
}

function panelBounds(series, panel) {
  const cacheKey = `${panel.type}:${panel.metric.key}:${panel.xMode}`;
  const cached = state.boundsCache.get(cacheKey);
  if (cached) return cached;
  if (panel.type === "raw") {
    const bounds = metricBounds(series, panel.metric);
    state.boundsCache.set(cacheKey, bounds);
    return bounds;
  }

  const reference = series[0];
  const values = series
    .slice(1)
    .flatMap((item) => metricDeltaPoints(item, reference, panel.metric, panel.xMode).map((point) => point.y));
  if (!values.length) {
    const bounds = { minY: -1, maxY: 1 };
    state.boundsCache.set(cacheKey, bounds);
    return bounds;
  }

  const maxAbs = Math.max(...values.map((value) => Math.abs(value))) || 1;
  if (panel.metric.discrete) {
    const extent = Math.max(1, Math.ceil(maxAbs));
    const bounds = { minY: -extent, maxY: extent };
    state.boundsCache.set(cacheKey, bounds);
    return bounds;
  }
  const pad = maxAbs * 0.12;
  const bounds = { minY: -maxAbs - pad, maxY: maxAbs + pad };
  state.boundsCache.set(cacheKey, bounds);
  return bounds;
}

function drawChart() {
  const metrics = state.metrics ?? selectedMetrics();
  const panels = panelDefinitions(metrics);
  resizeCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);

  if (!state.plotted.length) {
    emptyState.hidden = false;
    emptyState.textContent = "No trace plotted yet";
    legend.innerHTML = "";
    drawTrackMap();
    return;
  }
  emptyState.hidden = true;

  if (!panels.length) {
    emptyState.hidden = false;
    emptyState.textContent = "No telemetry panels selected";
    ctx.fillStyle = "#fffdf9";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const pad = CHART_PAD;
  const xBounds = activeAxisBounds();
  const availableHeight = height - pad.top - pad.bottom - PANEL_GAP * (panels.length - 1);
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, availableHeight / panels.length);
  const plotWidth = width - pad.left - pad.right;
  const panelLayouts = [];

  ctx.fillStyle = "#fffdf9";
  ctx.fillRect(0, 0, width, height);

  for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
    const panelDef = panels[panelIndex];
    const metric = panelDef.metric;
    const panel = {
      top: pad.top + panelIndex * (panelHeight + PANEL_GAP),
      height: panelHeight,
      bottom: pad.top + panelIndex * (panelHeight + PANEL_GAP) + panelHeight,
    };
    const xScale = (x) => pad.left + ((x - xBounds.minX) / (xBounds.maxX - xBounds.minX || 1)) * plotWidth;
    const yBounds = panelBounds(state.plotted, panelDef);
    const yScale = (y) => panel.top + (1 - (y - yBounds.minY) / (yBounds.maxY - yBounds.minY || 1)) * panel.height;
    panelLayouts.push({ panelDef, panel, xBounds, xScale, yBounds, yScale });

    drawGrid(width, pad, panel, xBounds, yBounds, panelDef, xScale, yScale);
    drawSelectionOnPanel(panel, xBounds, xScale, panelDef.xMode);

    const drawableSeries = panelDef.type === "raw" ? state.plotted : state.plotted.slice(1);
    const reference = state.plotted[0];
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, panel.top, plotWidth, panel.height);
    ctx.clip();
    for (const series of drawableSeries) {
      const allPoints = panelDef.type === "raw"
        ? metricPointsForAxis(series, metric, panelDef.xMode)
        : metricDeltaPoints(series, reference, metric, panelDef.xMode);
      const points = pointsInBounds(allPoints, xBounds);
      if (!points.length) continue;
      ctx.beginPath();
      ctx.moveTo(xScale(points[0].x), yScale(points[0].y));
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        if (metric.discrete) ctx.lineTo(xScale(point.x), yScale(previous.y));
        ctx.lineTo(xScale(point.x), yScale(point.y));
      }
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  if (state.cursor) drawTraceCursor(state.cursor, panelLayouts, true);
  if (state.hover) drawTraceCursor(state.hover, panelLayouts, false);
}

function resizeMapCanvas() {
  const rect = mapCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.floor(rect.width * ratio));
  const targetHeight = Math.max(1, Math.floor(rect.height * ratio));
  if (mapCanvas.width !== targetWidth || mapCanvas.height !== targetHeight) {
    mapCanvas.width = targetWidth;
    mapCanvas.height = targetHeight;
  }
  mapCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function trackBounds(series) {
  const all = series.flatMap((item) => item.trackPoints ?? []);
  if (!all.length) return null;
  const xs = all.map((point) => point.x);
  const ys = all.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function mapPointAtProgress(series, progress) {
  const elapsed = elapsedAtProgress(series, progress);
  return Number.isFinite(elapsed)
    ? interpolatedTrackPoint(series.trackPoints ?? [], elapsed)
    : null;
}

function mapSpeedAdvantageSegments(reference, comparison, segmentCount = 240) {
  const referenceSpeed = metricPointsForAxis(reference, SPEED_METRIC, "track");
  const comparisonSpeed = metricPointsForAxis(comparison, SPEED_METRIC, "track");
  if (!referenceSpeed.length || !comparisonSpeed.length || !reference.trackPoints?.length) return [];

  const segments = [];
  let from = mapPointAtProgress(reference, 0);
  for (let index = 0; index < segmentCount; index += 1) {
    const startProgress = index / segmentCount;
    const endProgress = (index + 1) / segmentCount;
    const midpoint = ((startProgress + endProgress) / 2) * 100;
    const to = mapPointAtProgress(reference, endProgress);
    const referencePoint = interpolatePlotPoint(referenceSpeed, midpoint);
    const comparisonPoint = interpolatePlotPoint(comparisonSpeed, midpoint);
    if (from && to && referencePoint && comparisonPoint) {
      const delta = comparisonPoint.y - referencePoint.y;
      const winner = Math.abs(delta) <= MAP_SPEED_NEUTRAL_THRESHOLD
        ? "neutral"
        : delta > 0 ? "comparison" : "reference";
      segments.push({ from, to, delta, winner });
    }
    from = to;
  }
  return segments;
}

function driverShortName(series) {
  return series.driver.name_acronym || series.driver.last_name;
}

function appendMapSpeedKey(color, text) {
  const key = document.createElement("span");
  key.className = "map-speed-key";
  const swatch = document.createElement("span");
  swatch.className = "map-speed-swatch";
  swatch.style.background = color;
  const label = document.createElement("span");
  label.textContent = text;
  key.append(swatch, label);
  mapSpeedLegend.append(key);
}

function updateMapSpeedLegend(enabled, available) {
  mapSpeedLegend.innerHTML = "";
  mapSpeedLegend.hidden = !enabled;
  if (!enabled) return;
  if (!available) {
    mapSpeedLegend.textContent = "Speed comparison unavailable for these laps";
    return;
  }

  const [reference, comparison] = state.plotted;
  appendMapSpeedKey(reference.color, `${driverShortName(reference)} faster`);
  appendMapSpeedKey(comparison.color, `${driverShortName(comparison)} faster`);
  appendMapSpeedKey(MAP_SPEED_NEUTRAL_COLOR, `Within ${MAP_SPEED_NEUTRAL_THRESHOLD} km/h`);
  if (state.plotted.length > 2) {
    const note = document.createElement("span");
    note.className = "map-speed-key";
    note.textContent = "Map compares the first two laps";
    mapSpeedLegend.append(note);
  }
}

function drawMapSpeedSegments(segments, reference, comparison, xScale, yScale) {
  mapCtx.lineWidth = 6.5;
  mapCtx.lineJoin = "round";
  mapCtx.lineCap = "round";
  for (const segment of segments) {
    mapCtx.strokeStyle = segment.winner === "reference"
      ? reference.color
      : segment.winner === "comparison" ? comparison.color : MAP_SPEED_NEUTRAL_COLOR;
    mapCtx.beginPath();
    mapCtx.moveTo(xScale(segment.from.x), yScale(segment.from.y));
    mapCtx.lineTo(xScale(segment.to.x), yScale(segment.to.y));
    mapCtx.stroke();
  }
}

function drawTrackMap() {
  const includeMap = trackMapToggle.checked;
  mapPanel.hidden = !includeMap || !state.plotted.length;
  if (mapPanel.hidden) return;

  resizeMapCanvas();
  const width = mapCanvas.clientWidth;
  const height = mapCanvas.clientHeight;
  mapCtx.clearRect(0, 0, width, height);
  mapCtx.fillStyle = "#fffdf9";
  mapCtx.fillRect(0, 0, width, height);

  const layout = mapLayout();
  if (!layout) {
    mapCtx.fillStyle = "#68625d";
    mapCtx.font = "14px system-ui, sans-serif";
    mapCtx.textAlign = "center";
    mapCtx.fillText("No location data for this lap window", width / 2, height / 2);
    return;
  }
  const { xScale, yScale } = layout;

  const showSpeedAdvantage = mapSpeedDeltaToggle.checked && state.plotted.length > 1;
  const speedSegments = showSpeedAdvantage
    ? mapSpeedAdvantageSegments(state.plotted[0], state.plotted[1])
    : [];
  updateMapSpeedLegend(showSpeedAdvantage, speedSegments.length > 0);

  if (speedSegments.length) {
    mapCtx.strokeStyle = "#d8d4ce";
    mapCtx.lineWidth = 10;
    mapCtx.lineJoin = "round";
    mapCtx.lineCap = "round";
    drawSmoothPath(mapCtx, state.plotted[0].trackPoints, xScale, yScale);
    drawMapSpeedSegments(speedSegments, state.plotted[0], state.plotted[1], xScale, yScale);
  } else {
    for (const series of state.plotted) {
      const points = series.trackPoints ?? [];
      if (!points.length) continue;
      mapCtx.strokeStyle = series.color;
      mapCtx.lineWidth = 3;
      mapCtx.lineJoin = "round";
      mapCtx.lineCap = "round";
      drawSmoothPath(mapCtx, points, xScale, yScale);
    }
  }

  if (state.cursor) drawMapCursor(state.cursor, xScale, yScale, true);
  if (state.hover) drawMapCursor(state.hover, xScale, yScale, false);
  drawMapSelectionMarkers(xScale, yScale);
}

function drawMapSelectionMarkers(xScale, yScale) {
  const reference = state.plotted[0];
  state.markers.forEach((progress, index) => {
    const elapsed = elapsedAtProgress(reference, progress);
    const point = Number.isFinite(elapsed)
      ? interpolatedTrackPoint(reference.trackPoints ?? [], elapsed)
      : null;
    if (!point) return;

    const x = xScale(point.x);
    const y = yScale(point.y);
    mapCtx.fillStyle = "#fffdf9";
    mapCtx.beginPath();
    mapCtx.arc(x, y, 10, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.fillStyle = MARKER_COLORS[index];
    mapCtx.beginPath();
    mapCtx.arc(x, y, 8, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.fillStyle = "#ffffff";
    mapCtx.font = "700 11px system-ui, sans-serif";
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "middle";
    mapCtx.fillText(index === 0 ? "A" : "B", x, y + 0.5);
  });
}

function drawSmoothPath(context, points, xScale, yScale) {
  if (!points.length) return;
  context.beginPath();
  context.moveTo(xScale(points[0].x), yScale(points[0].y));

  if (points.length === 1) {
    context.stroke();
    return;
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (xScale(current.x) + xScale(next.x)) / 2;
    const midY = (yScale(current.y) + yScale(next.y)) / 2;
    context.quadraticCurveTo(xScale(current.x), yScale(current.y), midX, midY);
  }

  const last = points[points.length - 1];
  context.lineTo(xScale(last.x), yScale(last.y));
  context.stroke();
}

function formatXAxisTick(value, bounds, mode) {
  const span = bounds.maxX - bounds.minX;
  const digits = span < 5 ? 2 : span < 20 ? 1 : 0;
  return `${value.toFixed(digits)}${mode === "track" ? "%" : "s"}`;
}

function formatYAxisTick(value, metric) {
  if (metric.discrete) return String(Math.round(value));
  if (Math.abs(value) < 0.0005) return "0";
  if (Math.abs(value) < 10) return value.toFixed(1);
  return String(Math.round(value));
}

function integerTicks(minY, maxY) {
  const minimum = Math.ceil(minY);
  const maximum = Math.floor(maxY);
  const step = Math.max(1, Math.ceil((maximum - minimum) / 8));
  const ticks = [];
  for (let value = minimum; value <= maximum; value += step) ticks.push(value);
  if (minimum <= 0 && maximum >= 0 && !ticks.includes(0)) ticks.push(0);
  if (!ticks.includes(maximum)) ticks.push(maximum);
  return ticks.sort((a, b) => a - b);
}

function shortDriverName(driver) {
  const firstName = driver?.first_name;
  return firstName && firstName.length <= 8
    ? firstName
    : driver?.name_acronym || driver?.last_name || "driver";
}

function deltaMeaning(metric) {
  const reference = state.plotted[0];
  const comparisons = state.plotted.slice(1);
  const referenceName = reference ? shortDriverName(reference.driver) : "base";
  const comparisonName = comparisons.length === 1
    ? shortDriverName(comparisons[0].driver)
    : "Comparison";
  const phrase = {
    speed: "faster than",
    longitudinal_acceleration: "higher longitudinal acceleration than",
    lateral_acceleration: "higher signed lateral acceleration than",
    throttle: "more throttle than",
    brake: "more braking than",
    rpm: "more RPM than",
    n_gear: "higher gear than",
    drs: "higher DRS state than",
  }[metric.key] ?? "higher than";
  return {
    positive: `${comparisonName} ${phrase} ${referenceName}`,
    negative: `${referenceName} ${phrase} ${comparisonName}`,
  };
}

function drawGrid(width, pad, panel, xBounds, yBounds, panelDef, xScale, yScale) {
  if (panelDef.type === "delta") {
    const zeroY = yScale(0);
    ctx.fillStyle = "rgba(29, 154, 74, 0.09)";
    ctx.fillRect(pad.left, panel.top, width - pad.left - pad.right, Math.max(0, zeroY - panel.top));
  }

  ctx.strokeStyle = "#e6ddd3";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#655f59";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (let i = 0; i <= 5; i += 1) {
    const xValue = xBounds.minX + ((xBounds.maxX - xBounds.minX) * i) / 5;
    const x = xScale(xValue);
    ctx.beginPath();
    ctx.moveTo(x, panel.top);
    ctx.lineTo(x, panel.bottom);
    ctx.stroke();
    ctx.fillText(formatXAxisTick(xValue, xBounds, panelDef.xMode), x, panel.bottom + 5);
  }

  ctx.fillStyle = "#272727";
  ctx.textAlign = "center";
  ctx.fillText(
    panelDef.xMode === "track" ? "Track position (%)" : "Elapsed lap time (s)",
    pad.left + (width - pad.left - pad.right) / 2,
    panel.bottom + 23
  );

  const yTicks = panelDef.metric.discrete
    ? integerTicks(yBounds.minY, yBounds.maxY)
    : panelDef.type === "delta"
      ? [yBounds.minY, yBounds.minY / 2, 0, yBounds.maxY / 2, yBounds.maxY]
      : Array.from({ length: 6 }, (_, index) => yBounds.minY + ((yBounds.maxY - yBounds.minY) * index) / 5);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const yValue of yTicks) {
    const y = yScale(yValue);
    const isZero = panelDef.type === "delta" && Math.abs(yValue) < 0.0005;
    ctx.strokeStyle = isZero ? "#272727" : "#e6ddd3";
    ctx.lineWidth = isZero ? 1.8 : 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = isZero ? "#272727" : "#655f59";
    ctx.fillText(formatYAxisTick(yValue, panelDef.metric), pad.left - 10, y);
  }

  ctx.strokeStyle = "#242424";
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(pad.left, panel.top);
  ctx.lineTo(pad.left, panel.bottom);
  ctx.lineTo(width - pad.right, panel.bottom);
  ctx.stroke();

  ctx.fillStyle = "#272727";
  ctx.save();
  ctx.translate(18, panel.top + panel.height / 2);
  ctx.rotate(-Math.PI / 2);
  const prefix = panelDef.type === "delta" ? "Delta " : "";
  ctx.fillText(`${prefix}${panelDef.metric.label} (${panelDef.metric.unit})`, 0, 0);
  ctx.restore();

  if (panelDef.type === "delta") {
    const meaning = deltaMeaning(panelDef.metric);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#17663a";
    ctx.fillText(meaning.positive, width - pad.right - 8, panel.top + 7);
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#68625d";
    ctx.fillText(meaning.negative, width - pad.right - 8, panel.bottom - 7);
  }
}

function drawSelectionOnPanel(panel, xBounds, xScale, mode) {
  if (!state.markers.length) return;
  const values = state.markers.map((progress) => markerAxisValue(progress, mode));
  if (values.length === 2) {
    const rangeMin = Math.max(xBounds.minX, Math.min(...values));
    const rangeMax = Math.min(xBounds.maxX, Math.max(...values));
    if (rangeMax > rangeMin) {
      const left = xScale(rangeMin);
      const right = xScale(rangeMax);
      ctx.fillStyle = "rgba(18, 97, 160, 0.06)";
      ctx.fillRect(left, panel.top, right - left, panel.height);
    }
  }

  values.forEach((value, index) => {
    if (!Number.isFinite(value) || value < xBounds.minX || value > xBounds.maxX) return;
    const x = xScale(value);
    ctx.strokeStyle = MARKER_COLORS[index];
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, panel.top);
    ctx.lineTo(x, panel.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = MARKER_COLORS[index];
    ctx.font = "12px system-ui, sans-serif";
    const placeRight = value <= (xBounds.minX + xBounds.maxX) / 2;
    ctx.textAlign = placeRight ? "left" : "right";
    ctx.textBaseline = "top";
    ctx.fillText(index === 0 ? "A" : "B", x + (placeRight ? 5 : -5), panel.top + 5);
  });
}

function lowerBound(points, key, target) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle][key] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function interpolatePlotPoint(points, targetX, discrete = false) {
  if (!points.length) return null;
  const index = lowerBound(points, "x", targetX);
  if (index === 0) return points[0];
  if (index === points.length) return points[points.length - 1];
  const previous = points[index - 1];
  const next = points[index];
  const span = next.x - previous.x;
  if (span <= 0) return next;
  if (discrete) {
    return { x: targetX, y: targetX === next.x ? next.y : previous.y };
  }
  const ratio = (targetX - previous.x) / span;
  return {
    x: targetX,
    y: previous.y + (next.y - previous.y) * ratio,
  };
}

function pointsInBounds(points, bounds) {
  if (points.length < 2) return points;
  const start = Math.max(0, lowerBound(points, "x", bounds.minX) - 1);
  const end = Math.min(points.length, lowerBound(points, "x", bounds.maxX) + 1);
  return points.slice(start, end);
}

function interpolatedTrackPoint(points, targetX) {
  if (!points.length) return null;
  if (targetX <= points[0].elapsed) return points[0];
  if (targetX >= points[points.length - 1].elapsed) return points[points.length - 1];

  const index = lowerBound(points, "elapsed", targetX);
  const previous = points[index - 1];
  const next = points[index];
  const span = next.elapsed - previous.elapsed || 1;
  const ratio = (targetX - previous.elapsed) / span;
  return {
    elapsed: targetX,
    x: previous.x + (next.x - previous.x) * ratio,
    y: previous.y + (next.y - previous.y) * ratio,
  };
}

function normalizeTrackPoints(points, lapDuration) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.elapsed - b.elapsed);
  const start = interpolatedTrackPoint(sorted, 0);
  const end = interpolatedTrackPoint(sorted, lapDuration);
  const withinLap = sorted.filter((point) => point.elapsed > 0 && point.elapsed < lapDuration);
  return [start, ...withinLap, end].filter(Boolean);
}

function deriveLongitudinalAcceleration(speedPoints, windowRadius = 2) {
  if (speedPoints.length < 3) return [];
  const result = [];
  for (let index = 0; index < speedPoints.length; index += 1) {
    const samples = speedPoints.slice(
      Math.max(0, index - windowRadius),
      Math.min(speedPoints.length, index + windowRadius + 1)
    );
    if (samples.length < 3) continue;
    const meanTime = samples.reduce((sum, point) => sum + point.x, 0) / samples.length;
    const meanSpeed = samples.reduce((sum, point) => sum + point.y / 3.6, 0) / samples.length;
    let covariance = 0;
    let timeVariance = 0;
    for (const point of samples) {
      const timeOffset = point.x - meanTime;
      covariance += timeOffset * (point.y / 3.6 - meanSpeed);
      timeVariance += timeOffset * timeOffset;
    }
    if (timeVariance <= 0) continue;
    const acceleration = covariance / timeVariance;
    if (Number.isFinite(acceleration) && Math.abs(acceleration) <= MAX_ACCELERATION_MPS2) {
      result.push({ x: speedPoints[index].x, y: acceleration });
    }
  }
  return result;
}

function smoothedTrackPoints(points, radius = 2) {
  return points.map((point, index) => {
    const samples = points.slice(
      Math.max(0, index - radius),
      Math.min(points.length, index + radius + 1)
    );
    return {
      elapsed: point.elapsed,
      x: samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length,
      y: samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length,
    };
  });
}

function wrappedAngle(angle) {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

function deriveLateralAcceleration(speedPoints, trackPoints, windowRadius = 2) {
  if (speedPoints.length < 3 || trackPoints.length < windowRadius * 2 + 1) return [];
  const smoothed = smoothedTrackPoints(trackPoints, 2);
  const result = [];
  for (let index = windowRadius; index < smoothed.length - windowRadius; index += 1) {
    const previous = smoothed[index - windowRadius];
    const current = smoothed[index];
    const next = smoothed[index + windowRadius];
    const incomingHeading = Math.atan2(current.y - previous.y, current.x - previous.x);
    const outgoingHeading = Math.atan2(next.y - current.y, next.x - current.x);
    const headingTime = (next.elapsed - previous.elapsed) / 2;
    const speedKmh = interpolateField(speedPoints, "x", current.elapsed, "y");
    if (!(headingTime > 0) || !Number.isFinite(speedKmh)) continue;
    const turnRate = wrappedAngle(outgoingHeading - incomingHeading) / headingTime;
    const acceleration = (speedKmh / 3.6) * turnRate;
    if (Number.isFinite(acceleration) && Math.abs(acceleration) <= MAX_ACCELERATION_MPS2) {
      result.push({ x: current.elapsed, y: acceleration });
    }
  }
  return result;
}

function buildProgressPoints(points) {
  if (!points.length) return [];
  let cumulative = 0;
  const withDistance = points.map((point, index) => {
    if (index > 0) {
      const previous = points[index - 1];
      cumulative += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    return { ...point, distance: cumulative };
  });
  const total = cumulative || 1;
  return withDistance.map((point) => ({
    ...point,
    progress: point.distance / total,
  }));
}

function interpolateField(points, key, target, valueKey) {
  if (!points.length) return null;
  if (target <= points[0][key]) return points[0][valueKey];
  if (target >= points[points.length - 1][key]) return points[points.length - 1][valueKey];

  const index = lowerBound(points, key, target);
  const previous = points[index - 1];
  const next = points[index];
  const span = next[key] - previous[key] || 1;
  const ratio = (target - previous[key]) / span;
  return previous[valueKey] + (next[valueKey] - previous[valueKey]) * ratio;
}

function progressAtElapsed(series, elapsed) {
  return interpolateField(series.progressPoints ?? [], "elapsed", elapsed, "progress");
}

function elapsedAtProgress(series, progress) {
  return interpolateField(series.progressPoints ?? [], "progress", progress, "elapsed");
}

function resampledTrackPoints(points, stepSeconds = 0.1) {
  if (points.length < 2) return points;
  const start = points[0].elapsed;
  const end = points[points.length - 1].elapsed;
  const sampled = [];

  for (let elapsed = start; elapsed <= end; elapsed += stepSeconds) {
    const point = interpolatedTrackPoint(points, elapsed);
    if (point) sampled.push(point);
  }

  const last = points[points.length - 1];
  if (sampled[sampled.length - 1]?.elapsed !== last.elapsed) sampled.push(last);
  return sampled;
}

function drawTraceCursor(cursor, panelLayouts, pinned) {
  const reference = state.plotted[0];
  const axisMode = selectedAxisMode();
  const cursorAxisX = axisMode === "track" && Number.isFinite(cursor.progress)
    ? cursor.progress * 100
    : cursor.x;

  for (const layout of panelLayouts) {
    const { panelDef, panel, xBounds, xScale, yScale } = layout;
    const metric = panelDef.metric;
    if (!Number.isFinite(cursorAxisX) || cursorAxisX < xBounds.minX || cursorAxisX > xBounds.maxX) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(CHART_PAD.left, panel.top, canvas.clientWidth - CHART_PAD.left - CHART_PAD.right, panel.height);
    ctx.clip();
    if (Number.isFinite(cursorAxisX)) {
      ctx.strokeStyle = pinned ? "rgba(225, 6, 0, 0.72)" : "rgba(39, 39, 39, 0.35)";
      ctx.lineWidth = pinned ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(xScale(cursorAxisX), panel.top);
      ctx.lineTo(xScale(cursorAxisX), panel.bottom);
      ctx.stroke();
    }

    const drawableSeries = panelDef.type === "raw" ? state.plotted : state.plotted.slice(1);
    for (const series of drawableSeries) {
      const points = panelDef.type === "raw"
        ? metricPointsForAxis(series, metric, panelDef.xMode)
        : metricDeltaPoints(series, reference, metric, panelDef.xMode);
      const point = interpolatePlotPoint(points, cursorAxisX, metric.discrete);
      if (!point) continue;

      const pointX = xScale(point.x);
      const pointY = yScale(point.y);
      ctx.fillStyle = "#fffdf9";
      ctx.beginPath();
      ctx.arc(pointX, pointY, pinned ? 7 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = series.color;
      ctx.beginPath();
      ctx.arc(pointX, pointY, pinned ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (pinned && panelLayouts.length) {
    const firstLayout = panelLayouts[0];
    const label = axisMode === "track" && Number.isFinite(cursor.progress)
      ? `${(cursor.progress * 100).toFixed(1)}% track`
      : `${cursor.x.toFixed(1)}s`;
    if (cursorAxisX < firstLayout.xBounds.minX || cursorAxisX > firstLayout.xBounds.maxX) return;
    const labelX = firstLayout.xScale(cursorAxisX);
    ctx.fillStyle = "#272727";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, Math.min(labelX + 8, canvas.clientWidth - 76), firstLayout.panel.top + 4);
  }
}

function drawMapCursor(cursor, xScale, yScale, pinned) {
  const reference = state.plotted[0];
  const sharedElapsed = cursor.mode === "progress" && Number.isFinite(cursor.progress)
    ? elapsedAtProgress(reference, cursor.progress)
    : null;
  const sharedPoint = Number.isFinite(sharedElapsed)
    ? interpolatedTrackPoint(reference.trackPoints ?? [], sharedElapsed)
    : null;

  if (sharedPoint) {
    const x = xScale(sharedPoint.x);
    const y = yScale(sharedPoint.y);
    mapCtx.fillStyle = reference.color;
    mapCtx.strokeStyle = "#fffdf9";
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.arc(x, y, pinned ? 7 : 5, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
  } else {
    state.plotted.forEach((series) => {
      const point = interpolatedTrackPoint(series.trackPoints ?? [], elapsedForCursor(series, cursor));
      if (!point) return;
      const x = xScale(point.x);
      const y = yScale(point.y);
      const radius = pinned ? 7 : 5;
      mapCtx.fillStyle = "#fffdf9";
      mapCtx.strokeStyle = series.color;
      mapCtx.lineWidth = pinned ? 3 : 2;
      mapCtx.beginPath();
      mapCtx.arc(x, y, radius, 0, Math.PI * 2);
      mapCtx.fill();
      mapCtx.stroke();
    });
  }

  if (pinned) {
    mapCtx.fillStyle = "#272727";
    mapCtx.font = "12px system-ui, sans-serif";
    mapCtx.textAlign = "left";
    mapCtx.textBaseline = "top";
    const label = cursor.mode === "progress" && Number.isFinite(cursor.progress)
      ? `${(cursor.progress * 100).toFixed(1)}% track`
      : `${cursor.x.toFixed(1)}s`;
    mapCtx.fillText(label, 12, 12);
  }
}

function elapsedForCursor(series, cursor) {
  if (cursor.mode === "progress" && Number.isFinite(cursor.progress)) {
    const elapsed = elapsedAtProgress(series, cursor.progress);
    if (Number.isFinite(elapsed)) return elapsed;
  }
  return cursor.x;
}

function formatDelta(delta) {
  const abs = Math.abs(delta).toFixed(3);
  if (Math.abs(delta) < 0.0005) return "0.000s";
  return `${delta > 0 ? "+" : "-"}${abs}s`;
}

function formatMetricValue(metric, value) {
  const digits = metric.unit === "m/s²" ? 2 : metric.key === "throttle" ? 1 : 0;
  const formatted = value.toFixed(digits);
  return metric.unit === "%" ? `${formatted}%` : `${formatted} ${metric.unit}`;
}

function metricReadout(series, reference, elapsed, referenceElapsed) {
  const metrics = state.metrics ?? selectedMetrics();
  return metrics
    .map((metric) => {
      const value = metricValueAtElapsed(series, metric, elapsed);
      const referenceValue = metricValueAtElapsed(reference, metric, referenceElapsed);
      if (!Number.isFinite(value)) return null;
      const delta = series === reference || !Number.isFinite(referenceValue)
        ? ""
        : ` (delta ${value - referenceValue >= 0 ? "+" : ""}${formatMetricValue(metric, value - referenceValue)})`;
      return `${metric.label} ${formatMetricValue(metric, value)}${delta}`;
    })
    .filter(Boolean)
    .join(" · ");
}

function updateDeltaReadout(cursor) {
  if (!cursor || state.plotted.length < 2) {
    deltaReadout.hidden = true;
    deltaReadout.innerHTML = "";
    return;
  }

  const reference = state.plotted[0];
  const referenceElapsed = elapsedForCursor(reference, cursor);
  if (!Number.isFinite(referenceElapsed)) {
    deltaReadout.hidden = true;
    deltaReadout.innerHTML = "";
    return;
  }

  deltaReadout.hidden = false;
  deltaReadout.innerHTML = "";

  const basisNode = document.createElement("div");
  basisNode.className = "delta-item reference";
  basisNode.textContent = cursor.mode === "progress" && Number.isFinite(cursor.progress)
    ? `${(cursor.progress * 100).toFixed(1)}% track position`
    : `${cursor.x.toFixed(3)}s elapsed`;
  deltaReadout.append(basisNode);

  for (const series of state.plotted) {
    const elapsed = elapsedForCursor(series, cursor);
    if (!Number.isFinite(elapsed)) continue;
    const node = document.createElement("div");
    node.className = series === reference ? "delta-item reference" : "delta-item";
    node.style.borderColor = series.color;
    const timeText = cursor.mode === "progress" && series !== reference
      ? ` · time delta ${formatDelta(elapsed - referenceElapsed)}`
      : ` · ${elapsed.toFixed(3)}s`;
    const values = metricReadout(series, reference, elapsed, referenceElapsed);
    node.textContent = `${series.driver.name_acronym || series.driver.last_name}${timeText}${values ? ` · ${values}` : ""}`;
    deltaReadout.append(node);
  }
}

function finalCursor() {
  if (!state.plotted.length) return null;
  const reference = state.plotted[0];
  const progress = 1;
  const referenceElapsed = elapsedAtProgress(reference, progress);
  return {
    x: Number.isFinite(referenceElapsed) ? referenceElapsed : reference.lap.lap_duration,
    progress,
    mode: "progress",
  };
}

function renderLegend(series) {
  legend.innerHTML = "";
  series.forEach((item, index) => {
    const node = document.createElement("div");
    node.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = item.color;
    const copy = document.createElement("span");
    copy.className = "legend-copy";
    const driverName = item.driver.name_acronym || item.driver.last_name;
    copy.innerHTML = `
      <span class="legend-primary">${index === 0 ? "Base" : `Compare ${index}`} · ${driverName} · ${formatLapTime(item.lap.lap_duration)}</span>
      <span class="legend-detail">${item.meeting.year} ${item.meeting.meeting_name} · ${item.session.session_name} · L${item.lap.lap_number}</span>
    `;
    node.append(swatch, copy);
    legend.append(node);
  });
}

function setCursorFromTraceEvent(event, pinned) {
  if (!state.plotted.length) return;
  const rect = canvas.getBoundingClientRect();
  const axisMode = selectedAxisMode();
  const bounds = activeAxisBounds();
  const plotWidth = rect.width - CHART_PAD.left - CHART_PAD.right;
  const x = event.clientX - rect.left;
  const axisX = bounds.minX + ((x - CHART_PAD.left) / plotWidth) * (bounds.maxX - bounds.minX);
  const clampedX = Math.max(bounds.minX, Math.min(bounds.maxX, axisX));
  const reference = state.plotted[0];
  const progress = axisMode === "track"
    ? clampedX / 100
    : progressAtElapsed(reference, clampedX);
  const referenceElapsed = axisMode === "track"
    ? elapsedAtProgress(reference, progress)
    : clampedX;
  const cursor = {
    x: referenceElapsed,
    progress,
    mode: axisMode === "track" ? "progress" : "time",
  };
  if (pinned) state.cursor = cursor;
  else state.hover = cursor;
  scheduleInteractionRender(cursor);
}

function beginTracePan(event) {
  const zoom = state.zoom?.mode === selectedAxisMode() ? state.zoom : null;
  if (!zoom || event.button !== 0) return;
  state.tracePan = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    minX: zoom.minX,
    maxX: zoom.maxX,
    moved: false,
  };
  canvas.setPointerCapture?.(event.pointerId);
}

function moveTracePointer(event) {
  const pan = state.tracePan;
  if (!pan || pan.pointerId !== event.pointerId) {
    setCursorFromTraceEvent(event, false);
    return;
  }

  const pixelDelta = event.clientX - pan.startClientX;
  if (!pan.moved && Math.abs(pixelDelta) < 4) return;
  pan.moved = true;
  canvas.classList.toggle("is-panning", true);
  event.preventDefault();
  const plotWidth = Math.max(1, canvas.getBoundingClientRect().width - CHART_PAD.left - CHART_PAD.right);
  const axisSpan = pan.maxX - pan.minX;
  const targetMin = pan.minX - (pixelDelta / plotWidth) * axisSpan;
  panZoomBy(targetMin - state.zoom.minX);
}

function endTracePan(event) {
  const pan = state.tracePan;
  if (!pan || pan.pointerId !== event.pointerId) return;
  state.suppressTraceClick = pan.moved;
  state.tracePan = null;
  canvas.classList.toggle("is-panning", false);
  canvas.releasePointerCapture?.(event.pointerId);
}

function mapLayout() {
  const bounds = state.trackBounds ?? trackBounds(state.plotted);
  if (!bounds) return null;
  const width = mapCanvas.clientWidth;
  const height = mapCanvas.clientHeight;
  const pad = 34;
  const rangeX = bounds.maxX - bounds.minX || 1;
  const rangeY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((width - pad * 2) / rangeX, (height - pad * 2) / rangeY);
  const usedWidth = rangeX * scale;
  const usedHeight = rangeY * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;
  return {
    xScale: (value) => offsetX + (value - bounds.minX) * scale,
    yScale: (value) => offsetY + usedHeight - (value - bounds.minY) * scale,
  };
}

function setCursorFromMapEvent(event, pinned) {
  if (!state.plotted.length || mapPanel.hidden) return;
  const layout = mapLayout();
  if (!layout) return;
  const rect = mapCanvas.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  const clickY = event.clientY - rect.top;
  let nearest = null;
  const reference = state.plotted[0];

  for (const point of reference.hitTrackPoints ?? reference.trackPoints ?? []) {
    const dx = layout.xScale(point.x) - clickX;
    const dy = layout.yScale(point.y) - clickY;
    const distance = dx * dx + dy * dy;
    if (!nearest || distance < nearest.distance) nearest = { point, distance };
  }
  if (!nearest) return;
  const progress = progressAtElapsed(reference, nearest.point.elapsed);
  const referenceElapsed = Number.isFinite(progress) ? elapsedAtProgress(reference, progress) : nearest.point.elapsed;
  const axisMode = selectedAxisMode();
  const cursor = {
    x: Number.isFinite(referenceElapsed) ? referenceElapsed : nearest.point.elapsed,
    progress,
    mode: axisMode === "track" ? "progress" : "time",
  };
  if (pinned) {
    state.cursor = cursor;
    addTrackMarker(progress);
  } else {
    state.hover = cursor;
  }
  scheduleInteractionRender(cursor);
}

function addTrackMarker(progress) {
  if (!Number.isFinite(progress)) return;
  if (state.markers.length === 2) {
    state.markers = [progress];
    state.zoom = null;
  } else {
    state.markers.push(progress);
  }
  updateMarkerControls();
  if (state.markers.length === 2) applyMarkerZoom();
  else updateZoomControls();
}

function scheduleInteractionRender(cursor = state.cursor || finalCursor()) {
  state.pendingCursor = cursor;
  if (state.interactionFrame) return;
  state.interactionFrame = requestAnimationFrame(() => {
    state.interactionFrame = null;
    updateDeltaReadout(state.pendingCursor);
    drawChart();
    drawTrackMap();
    drawGGDiagram();
  });
}

canvas.addEventListener("pointerdown", beginTracePan);
canvas.addEventListener("pointermove", moveTracePointer);
canvas.addEventListener("pointerup", endTracePan);
canvas.addEventListener("pointercancel", (event) => {
  endTracePan(event);
  state.suppressTraceClick = false;
});
canvas.addEventListener("click", (event) => {
  if (state.suppressTraceClick) {
    state.suppressTraceClick = false;
    return;
  }
  setCursorFromTraceEvent(event, true);
});
canvas.addEventListener("wheel", (event) => {
  if (!state.plotted.length) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const bounds = activeAxisBounds();
  const plotWidth = rect.width - CHART_PAD.left - CHART_PAD.right;
  const pointerX = Math.max(CHART_PAD.left, Math.min(rect.width - CHART_PAD.right, event.clientX - rect.left));
  const centerX = bounds.minX + ((pointerX - CHART_PAD.left) / plotWidth) * (bounds.maxX - bounds.minX);
  zoomBy(event.deltaY < 0 ? 0.72 : 1.38, centerX);
}, { passive: false });
canvas.addEventListener("dblclick", resetZoom);

canvas.addEventListener("mouseleave", () => {
  state.hover = null;
  scheduleInteractionRender(state.cursor || finalCursor());
});

mapCanvas.addEventListener("mousemove", (event) => setCursorFromMapEvent(event, false));
mapCanvas.addEventListener("click", (event) => setCursorFromMapEvent(event, true));
mapCanvas.addEventListener("mouseleave", () => {
  state.hover = null;
  scheduleInteractionRender(state.cursor || finalCursor());
});

window.addEventListener("resize", () => {
  updateChartHeight(panelDefinitions(state.metrics ?? selectedMetrics()).length);
  drawChart();
  drawTrackMap();
  drawGGDiagram();
});
metricOptions.addEventListener("change", () => {
  const metrics = selectedMetrics();
  if (state.plotted.length) plot();
  else plotTitle.textContent = metrics.length === 1
    ? `${metrics[0].label} trace`
    : metrics.length > 1 ? `${metrics.length} telemetry traces` : "Telemetry trace";
});
trackMapToggle.addEventListener("change", () => {
  mapSpeedDeltaToggle.disabled = !trackMapToggle.checked;
  if (!state.plotted.length) {
    drawTrackMap();
    return;
  }
  const hasTrackData = state.plotted.every((series) => series.trackPoints?.length);
  const hasSpeedData = !mapSpeedDeltaToggle.checked
    || state.plotted.length < 2
    || state.plotted.every((series) => series.pointsByMetric.speed?.length);
  if (!trackMapToggle.checked || (hasTrackData && hasSpeedData)) {
    updatePlotSubtitle();
    drawTrackMap();
    return;
  }
  plot();
});
ggToggle.addEventListener("change", () => {
  if (!state.plotted.length) {
    drawGGDiagram();
    return;
  }
  const hasAccelerationData = state.plotted.every((series) =>
    series.pointsByMetric.longitudinal_acceleration?.length && series.pointsByMetric.lateral_acceleration?.length
  );
  if (ggToggle.checked && !hasAccelerationData) {
    plot();
    return;
  }
  updatePlotSubtitle();
  drawGGDiagram();
});
mapSpeedDeltaToggle.addEventListener("change", () => {
  if (!state.plotted.length || !trackMapToggle.checked) {
    drawTrackMap();
    return;
  }
  const hasSpeedData = state.plotted.every((series) => series.pointsByMetric.speed?.length);
  if (mapSpeedDeltaToggle.checked && state.plotted.length > 1 && !hasSpeedData) {
    plot();
    return;
  }
  updatePlotSubtitle();
  drawTrackMap();
});
dataDeltaToggle.addEventListener("change", () => {
  if (state.plotted.length) {
    updateChartHeight(panelDefinitions(state.metrics ?? selectedMetrics()).length);
    updatePlotSubtitle();
    drawChart();
    updateDeltaReadout(state.cursor || finalCursor());
  }
});
axisModeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    updateAxisStatus();
    if (!state.plotted.length) return;

    const hasTrackData = state.plotted.every((series) => series.progressPoints?.length);
    if (selectedAxisMode() === "time" || hasTrackData) {
      state.hover = null;
      state.cursor = null;
      state.zoom = null;
      updatePlotSubtitle();
      updateDeltaReadout(finalCursor());
      if (state.markers.length === 2) applyMarkerZoom();
      else {
        updateZoomControls();
        drawChart();
      }
      drawTrackMap();
      drawGGDiagram();
      return;
    }

    plot();
  });
});
[addButton, addButtonBottom].filter(Boolean).forEach((button) => {
  button.addEventListener("click", () => addRow());
});
plotButton.addEventListener("click", plot);
zoomInButton.addEventListener("click", () => zoomBy(0.72));
zoomOutButton.addEventListener("click", () => zoomBy(1.38));
resetZoomButton.addEventListener("click", resetZoom);
clearMarkersButton.addEventListener("click", clearMarkers);

initMetricOptions();
mapSpeedDeltaToggle.disabled = !trackMapToggle.checked;
updateMarkerControls();
updateZoomControls();
updateAxisStatus();
addRow().catch((error) => setStatus(error.message, true));
