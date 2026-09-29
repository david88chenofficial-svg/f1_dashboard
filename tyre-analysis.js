"use strict";

const API_BASE = "/api/openf1";
const YEARS = [new Date().getFullYear(), 2025, 2024, 2023].filter(
  (year, index, values) => year >= 2023 && values.indexOf(year) === index,
);
const QUALIFYING_SESSIONS = new Set(["Qualifying", "Sprint Qualifying", "Sprint Shootout"]);

const elements = {
  studyTitle: document.querySelector("#study-title"),
  studySubtitle: document.querySelector("#study-subtitle"),
  legend: document.querySelector("#stint-legend"),
  lapCanvas: document.querySelector("#lap-time-canvas"),
  lapTooltip: document.querySelector("#lap-tooltip"),
  excludedLaps: document.querySelector("#excluded-laps"),
  yearSelect: document.querySelector("#year-select"),
  meetingSelect: document.querySelector("#meeting-select"),
  sessionSelect: document.querySelector("#session-select"),
  driverSelect: document.querySelector("#driver-select"),
  analyseButton: document.querySelector("#analyse-button"),
  addComparisonButton: document.querySelector("#add-comparison-button"),
  comparisonList: document.querySelector("#comparison-list"),
  comparisonRule: document.querySelector("#comparison-rule"),
  sessionHint: document.querySelector("#session-hint"),
  lapAxisSelect: document.querySelector("#lap-axis-select"),
  stintSelect: document.querySelector("#stint-select"),
  lapSelect: document.querySelector("#lap-select"),
  ellipseCanvas: document.querySelector("#ellipse-canvas"),
  ellipseReadout: document.querySelector("#ellipse-readout"),
  allocationSourceNote: document.querySelector("#allocation-source-note"),
  status: document.querySelector("#load-status"),
};

const lapContext = elements.lapCanvas.getContext("2d");
const ellipseContext = elements.ellipseCanvas.getContext("2d");

const COMPOUND_COLORS = {
  SOFT: "#e13b35",
  MEDIUM: "#c59b00",
  HARD: "#59636e",
  INTERMEDIATE: "#168f48",
  WET: "#2774c9",
  UNKNOWN: "#7b7282",
};

const VIRIDIS = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
const SERIES_COLORS = ["#171513", "#1769aa", "#a2449c", "#00846b"];
const state = {
  data: null,
  datasets: [],
  activeDatasetId: null,
  nextDatasetId: 1,
  selectedLap: null,
  hoverLap: null,
  hoverDatasetId: null,
  lapPlot: null,
  meetings: [],
  sessions: [],
  drivers: [],
  apiCache: new Map(),
  loading: false,
};

function cacheKey(endpoint, params) {
  return `${endpoint}?${new URLSearchParams(params).toString()}`;
}

async function openf1(endpoint, params = {}) {
  const key = cacheKey(endpoint, params);
  if (state.apiCache.has(key)) return state.apiCache.get(key);
  const response = await fetch(`${API_BASE}/${endpoint}?${new URLSearchParams(params).toString()}`);
  if (!response.ok) throw new Error(`OpenF1 ${endpoint} failed (${response.status})`);
  const data = await response.json();
  state.apiCache.set(key, data);
  return data;
}

function replaceOptions(select, items, placeholder, preferredValue = "") {
  select.replaceChildren();
  const prompt = new Option(items.length ? placeholder : "No data available", "");
  prompt.disabled = items.length > 0;
  prompt.selected = true;
  select.append(prompt);
  items.forEach((item) => select.append(new Option(item.label, String(item.value))));
  select.disabled = !items.length;
  if (preferredValue && items.some((item) => String(item.value) === String(preferredValue))) {
    select.value = String(preferredValue);
  }
}

function clearSelect(select, placeholder) {
  replaceOptions(select, [], placeholder);
}

function setSelectionLoading(loading, message = "") {
  state.loading = loading;
  [elements.yearSelect, elements.meetingSelect, elements.sessionSelect, elements.driverSelect].forEach((select) => {
    select.disabled = loading || ![...select.options].some((option) => option.value);
  });
  elements.analyseButton.disabled = loading || !elements.sessionSelect.value || !elements.driverSelect.value;
  elements.addComparisonButton.disabled = loading || !elements.sessionSelect.value || !elements.driverSelect.value || state.datasets.length >= 4;
  elements.status.textContent = message;
}

function compoundLabel(item) {
  return `${item.compound || "UNKNOWN"}${item.construction ? ` · ${item.construction}` : ""}`;
}

function allocationLabel(metadata) {
  const allocation = metadata.tyre_allocation;
  if (!allocation) return "C-number unavailable for this weekend";
  return ["HARD", "MEDIUM", "SOFT"]
    .filter((compound) => allocation[compound])
    .map((compound) => `${compound} ${allocation[compound]}`)
    .join(" · ");
}

function datasetKey(data) {
  return `${data.metadata.session_key}:${data.metadata.driver_number}`;
}

function defaultStintNumber(data) {
  const best = data.stints.reduce((winner, stint) => {
    const count = data.laps.filter((lap) => lap.stint_number === stint.stint_number && lap.clean_lap).length;
    return !winner || count > winner.count ? { number: stint.stint_number, count } : winner;
  }, null);
  return best?.number ?? data.stints[0]?.stint_number ?? 1;
}

function activeDataset() {
  return state.datasets.find((dataset) => dataset.id === state.activeDatasetId) || state.datasets[0] || null;
}

function lapComparable(dataset, base = state.datasets[0]) {
  if (!dataset || !base) return false;
  return dataset.data.metadata.circuit === base.data.metadata.circuit
    && dataset.data.metadata.session === base.data.metadata.session;
}

function updateSessionHint() {
  const session = state.sessions.find((item) => String(item.session_key) === elements.sessionSelect.value);
  if (session && QUALIFYING_SESSIONS.has(session.session_name)) {
    elements.sessionHint.textContent = "Qualifying is available as a separate short-run study. Its laps are useful for peak performance, but not for long-stint degradation.";
    return;
  }
  elements.sessionHint.textContent = "Race, sprint, and practice sessions are listed first. Slow laps, standing starts, pit laps, and out laps are kept in the excluded-laps strip.";
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseHex(color) {
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
}

function colorRamp(value) {
  const scaled = clamp(value, 0, 1) * (VIRIDIS.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(VIRIDIS.length - 1, lower + 1);
  const mix = scaled - lower;
  const start = parseHex(VIRIDIS[lower]);
  const end = parseHex(VIRIDIS[upper]);
  const channel = start.map((item, index) => Math.round(item + (end[index] - item) * mix));
  return `rgb(${channel.join(",")})`;
}

function formatLapTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`;
}

function formatRaceElapsed(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function uniqueDrivers(drivers) {
  const unique = new Map();
  drivers.forEach((driver) => {
    if (!unique.has(driver.driver_number)) unique.set(driver.driver_number, driver);
  });
  return [...unique.values()].sort((left, right) => left.full_name.localeCompare(right.full_name));
}

async function loadMeetings(preferredMeeting = "") {
  clearSelect(elements.meetingSelect, "Select Grand Prix");
  clearSelect(elements.sessionSelect, "Select session");
  clearSelect(elements.driverSelect, "Select driver");
  const year = elements.yearSelect.value;
  if (!year) return;
  setSelectionLoading(true, "Loading Grand Prix list…");
  try {
    state.meetings = (await openf1("meetings", { year }))
      .filter((meeting) => meeting.meeting_name?.includes("Grand Prix") && !meeting.is_cancelled)
      .sort((left, right) => new Date(left.date_start) - new Date(right.date_start));
    replaceOptions(
      elements.meetingSelect,
      state.meetings.map((meeting) => ({ value: meeting.meeting_key, label: meeting.meeting_name })),
      "Select Grand Prix",
      preferredMeeting,
    );
  } finally {
    setSelectionLoading(false, "");
  }
}

function setSessionOptions(sessions, preferredSession = "") {
  elements.sessionSelect.replaceChildren();
  const prompt = new Option(sessions.length ? "Select session" : "No sessions available", "");
  prompt.disabled = sessions.length > 0;
  prompt.selected = true;
  elements.sessionSelect.append(prompt);

  const regular = document.createElement("optgroup");
  regular.label = "Race, sprint, and practice";
  const qualifying = document.createElement("optgroup");
  qualifying.label = "Qualifying · short-run study";
  sessions.forEach((session) => {
    const option = new Option(session.session_name, String(session.session_key));
    (QUALIFYING_SESSIONS.has(session.session_name) ? qualifying : regular).append(option);
  });
  if (regular.children.length) elements.sessionSelect.append(regular);
  if (qualifying.children.length) elements.sessionSelect.append(qualifying);
  elements.sessionSelect.disabled = !sessions.length;
  if (preferredSession && sessions.some((session) => String(session.session_key) === String(preferredSession))) {
    elements.sessionSelect.value = String(preferredSession);
  }
  updateSessionHint();
}

async function loadSessions(preferredSession = "") {
  clearSelect(elements.sessionSelect, "Select session");
  clearSelect(elements.driverSelect, "Select driver");
  if (!elements.meetingSelect.value) return;
  setSelectionLoading(true, "Loading sessions…");
  try {
    state.sessions = (await openf1("sessions", { meeting_key: elements.meetingSelect.value }))
      .filter((session) => !session.is_cancelled)
      .sort((left, right) => new Date(left.date_start) - new Date(right.date_start));
    setSessionOptions(state.sessions, preferredSession);
  } finally {
    setSelectionLoading(false, "");
  }
}

async function loadDrivers(preferredDriver = "") {
  clearSelect(elements.driverSelect, "Select driver");
  if (!elements.sessionSelect.value) return;
  setSelectionLoading(true, "Loading drivers…");
  try {
    state.drivers = uniqueDrivers(await openf1("drivers", { session_key: elements.sessionSelect.value }));
    replaceOptions(
      elements.driverSelect,
      state.drivers.map((driver) => ({
        value: driver.driver_number,
        label: `${driver.full_name} (${driver.driver_number})`,
      })),
      "Select driver",
      preferredDriver,
    );
  } finally {
    setSelectionLoading(false, "");
  }
}

function resizeCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function niceTicks(minimum, maximum, count = 6) {
  const span = Math.max(1e-9, maximum - minimum);
  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const start = Math.ceil(minimum / step) * step;
  const ticks = [];
  for (let value = start; value <= maximum + step * 0.1; value += step) ticks.push(value);
  return ticks;
}

function drawAxes(context, plot, xTicks, yTicks, xMap, yMap, xFormatter, yFormatter, labels) {
  context.save();
  context.font = "12px Inter, system-ui, sans-serif";
  context.lineWidth = 1;
  context.strokeStyle = "#e8e2db";
  context.fillStyle = "#625c56";

  yTicks.forEach((tick) => {
    const y = yMap(tick);
    context.beginPath();
    context.moveTo(plot.left, y);
    context.lineTo(plot.right, y);
    context.stroke();
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(yFormatter(tick), plot.left - 10, y);
  });

  xTicks.forEach((tick) => {
    const x = xMap(tick);
    context.beginPath();
    context.moveTo(x, plot.top);
    context.lineTo(x, plot.bottom);
    context.stroke();
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(xFormatter(tick), x, plot.bottom + 10);
  });

  context.strokeStyle = "#847c75";
  context.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  context.fillStyle = "#302d2a";
  context.font = "600 13px Inter, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText(labels.x, (plot.left + plot.right) / 2, plot.canvasHeight - 3);
  context.save();
  context.translate(15, (plot.top + plot.bottom) / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(labels.y, 0, 0);
  context.restore();
  context.restore();
}

function linearFit(laps) {
  if (laps.length < 3) return null;
  const meanX = laps.reduce((sum, lap) => sum + lap.lap_number, 0) / laps.length;
  const meanY = laps.reduce((sum, lap) => sum + lap.lap_duration, 0) / laps.length;
  let numerator = 0;
  let denominator = 0;
  laps.forEach((lap) => {
    numerator += (lap.lap_number - meanX) * (lap.lap_duration - meanY);
    denominator += (lap.lap_number - meanX) ** 2;
  });
  if (!denominator) return null;
  const slope = numerator / denominator;
  return { slope, intercept: meanY - slope * meanX };
}

function drawLapChart() {
  if (!state.data || !state.datasets.length) return;
  const { width, height } = resizeCanvas(elements.lapCanvas, lapContext);
  const compact = width < 620;
  const plot = {
    left: compact ? 55 : 67,
    right: width - 18,
    top: 28,
    bottom: height - 50,
    canvasHeight: height,
  };
  const datasets = state.datasets.filter((dataset) => lapComparable(dataset));
  const axisMode = elements.lapAxisSelect.value;
  const xValue = (lap) => axisMode === "tyre-age" ? lap.tyre_age_laps : lap.lap_number;
  const cleanLaps = datasets.flatMap((dataset) => dataset.data.laps.filter((lap) => lap.clean_lap));
  lapContext.clearRect(0, 0, width, height);
  if (!cleanLaps.length) {
    lapContext.fillStyle = "#625c56";
    lapContext.font = "600 14px Inter, system-ui, sans-serif";
    lapContext.textAlign = "center";
    lapContext.fillText("No representative laps were available for this selection.", width / 2, height / 2);
    state.lapPlot = null;
    return;
  }
  const xMin = Math.min(...cleanLaps.map(xValue));
  const xMax = Math.max(...cleanLaps.map(xValue));
  const yMin = Math.floor(Math.min(...cleanLaps.map((lap) => lap.lap_duration)) - 1);
  const yMax = Math.ceil(Math.max(...cleanLaps.map((lap) => lap.lap_duration)) + 1);
  const xSpan = Math.max(1, xMax - xMin);
  const xMap = (value) => plot.left + ((value - xMin) / xSpan) * (plot.right - plot.left);
  const yMap = (value) => plot.bottom - ((value - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const xTicks = niceTicks(xMin, xMax, compact ? 5 : 9);

  drawAxes(
    lapContext,
    plot,
    xTicks,
    niceTicks(yMin, yMax, 6),
    xMap,
    yMap,
    String,
    (value) => value.toFixed(0),
    { x: axisMode === "tyre-age" ? "Tyre age (laps)" : "Session lap", y: "Lap time (s)" },
  );

  const currentDataset = activeDataset();
  if (axisMode === "session" && currentDataset && lapComparable(currentDataset)) currentDataset.data.stints.slice(1).forEach((stint) => {
    const x = xMap(stint.lap_start - 0.5);
    lapContext.save();
    lapContext.strokeStyle = "#423d39";
    lapContext.setLineDash([5, 5]);
    lapContext.beginPath();
    lapContext.moveTo(x, plot.top);
    lapContext.lineTo(x, plot.bottom);
    lapContext.stroke();
    lapContext.setLineDash([]);
    lapContext.fillStyle = "#423d39";
    lapContext.font = "600 11px Inter, system-ui, sans-serif";
    lapContext.textAlign = x > width * 0.74 ? "right" : "left";
    lapContext.textBaseline = "top";
    const labelX = x > width * 0.74 ? x - 6 : x + 6;
    lapContext.fillText(`Change before L${stint.lap_start}`, labelX, plot.top + 7);
    lapContext.fillStyle = "#716a64";
    const pitText = stint.pit_event
      ? `T+${formatRaceElapsed(stint.pit_event.race_elapsed_seconds)}${Number.isFinite(stint.pit_event.lane_duration_seconds) ? ` · lane ${stint.pit_event.lane_duration_seconds.toFixed(1)} s` : " · change inferred from stint"}`
      : `${compoundLabel(stint)} · start age ${stint.tyre_age_at_start}`;
    lapContext.fillText(`${compoundLabel(stint)} · start age ${stint.tyre_age_at_start}`, labelX, plot.top + 23);
    lapContext.fillText(pitText, labelX, plot.top + 39);
    lapContext.restore();
  });

  const hitPoints = [];
  datasets.forEach((dataset) => dataset.data.stints.forEach((stint) => {
    const clean = dataset.data.laps.filter((lap) => lap.stint_number === stint.stint_number && lap.clean_lap);
    const seriesColor = dataset.color;
    const tyreColor = COMPOUND_COLORS[stint.compound] || COMPOUND_COLORS.UNKNOWN;
    const points = clean.map((lap) => ({ lap, x: xValue(lap) })).sort((left, right) => left.x - right.x);
    lapContext.save();
    lapContext.strokeStyle = seriesColor;
    lapContext.globalAlpha = 0.42;
    lapContext.lineWidth = 1.6;
    lapContext.beginPath();
    points.forEach((point, index) => {
      const x = xMap(point.x);
      const y = yMap(point.lap.lap_duration);
      if (index === 0) lapContext.moveTo(x, y);
      else lapContext.lineTo(x, y);
    });
    lapContext.stroke();
    lapContext.restore();

    if (points.length >= 3) {
      const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const meanY = points.reduce((sum, point) => sum + point.lap.lap_duration, 0) / points.length;
      const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
      const numerator = points.reduce((sum, point) => sum + (point.x - meanX) * (point.lap.lap_duration - meanY), 0);
      const slope = denominator ? numerator / denominator : 0;
      const intercept = meanY - slope * meanX;
      const first = points[0].x;
      const last = points[points.length - 1].x;
      lapContext.save();
      lapContext.strokeStyle = seriesColor;
      lapContext.lineWidth = 2.8;
      lapContext.setLineDash(dataset.id === state.datasets[0].id ? [] : [7, 4]);
      lapContext.beginPath();
      lapContext.moveTo(xMap(first), yMap(slope * first + intercept));
      lapContext.lineTo(xMap(last), yMap(slope * last + intercept));
      lapContext.stroke();
      lapContext.restore();
    }

    clean.forEach((lap) => {
      const x = xMap(xValue(lap));
      const y = yMap(lap.lap_duration);
      lapContext.save();
      lapContext.strokeStyle = seriesColor;
      lapContext.fillStyle = tyreColor;
      lapContext.lineWidth = 2;
      lapContext.beginPath();
      lapContext.arc(x, y, dataset.id === state.activeDatasetId ? 4.5 : 3.8, 0, Math.PI * 2);
      lapContext.fill();
      lapContext.stroke();
      lapContext.restore();
      hitPoints.push({ dataset, lap, x, y });
    });
  }));

  const activeLap = state.hoverLap || state.selectedLap;
  const activeDatasetId = state.hoverLap ? state.hoverDatasetId : state.activeDatasetId;
  if (activeLap?.clean_lap) {
    const point = hitPoints.find((item) => item.dataset.id === activeDatasetId && item.lap === activeLap);
    if (point) {
    lapContext.save();
    lapContext.strokeStyle = "#181716";
    lapContext.lineWidth = 2;
    lapContext.beginPath();
    lapContext.arc(point.x, point.y, 8, 0, Math.PI * 2);
    lapContext.stroke();
    lapContext.restore();
    }
  }

  state.lapPlot = { plot, xMap, yMap, hitPoints };
}

function currentEnvelopeLaps() {
  if (!state.data) return [];
  const value = elements.stintSelect.value;
  if (value === "compare") return state.data.laps.filter((lap) => lap.clean_lap);
  if (value === "compare-loaded") {
    return state.datasets.flatMap((dataset) => dataset.data.laps.filter(
      (lap) => lap.clean_lap && lap.stint_number === dataset.selectedStint,
    ));
  }
  const stintNumber = Number(value.replace("stint-", ""));
  return state.data.laps.filter((lap) => lap.clean_lap && lap.stint_number === stintNumber);
}

function ellipsePoint(longitudinalAxis, lateralAxis, angle) {
  return {
    x: lateralAxis * Math.cos(angle),
    y: longitudinalAxis * Math.sin(angle),
  };
}

function drawEllipsePath(context, ellipse, xMap, yMap) {
  context.beginPath();
  for (let index = 0; index <= 180; index += 1) {
    const point = ellipsePoint(
      ellipse.longitudinal_axis_mps2,
      ellipse.lateral_axis_mps2,
      (index / 180) * Math.PI * 2,
    );
    if (index === 0) context.moveTo(xMap(point.x), yMap(point.y));
    else context.lineTo(xMap(point.x), yMap(point.y));
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function drawEllipseChart() {
  if (!state.data) return;
  const { width, height } = resizeCanvas(elements.ellipseCanvas, ellipseContext);
  ellipseContext.clearRect(0, 0, width, height);
  const compact = width < 620;
  const plotSize = Math.min(width - (compact ? 75 : 150), height - 100);
  const plot = {
    left: Math.max(compact ? 55 : 72, (width - plotSize) / 2),
    right: Math.min(width - 20, (width + plotSize) / 2),
    top: 22,
    bottom: 22 + plotSize,
    canvasHeight: height,
  };
  const laps = currentEnvelopeLaps();
  if (!laps.length) {
    ellipseContext.fillStyle = "#625c56";
    ellipseContext.font = "600 14px Inter, system-ui, sans-serif";
    ellipseContext.textAlign = "center";
    ellipseContext.fillText("No fitted clean-lap envelopes are available for this view.", width / 2, height / 2);
    elements.ellipseReadout.textContent = "No representative lap envelope is available for this selection.";
    return;
  }
  const maximumAxis = Math.max(
    ...laps.flatMap((lap) => [lap.ellipse.longitudinal_axis_mps2, lap.ellipse.lateral_axis_mps2]),
  );
  const extent = Math.ceil((maximumAxis * 1.16) / 5) * 5;
  const xMap = (value) => plot.left + ((value + extent) / (extent * 2)) * (plot.right - plot.left);
  const yMap = (value) => plot.bottom - ((value + extent) / (extent * 2)) * (plot.bottom - plot.top);
  const ticks = niceTicks(-extent, extent, compact ? 5 : 7);

  drawAxes(
    ellipseContext,
    plot,
    ticks,
    ticks,
    xMap,
    yMap,
    (value) => value.toFixed(0),
    (value) => value.toFixed(0),
    { x: "Lateral acceleration, aᵧ (m/s²)", y: "Longitudinal acceleration, aₓ (m/s²)" },
  );
  ellipseContext.save();
  ellipseContext.strokeStyle = "#8c847c";
  ellipseContext.lineWidth = 1.1;
  ellipseContext.beginPath();
  ellipseContext.moveTo(xMap(0), plot.top);
  ellipseContext.lineTo(xMap(0), plot.bottom);
  ellipseContext.moveTo(plot.left, yMap(0));
  ellipseContext.lineTo(plot.right, yMap(0));
  ellipseContext.stroke();
  ellipseContext.restore();

  const compareMode = elements.stintSelect.value === "compare";
  const loadedCompareMode = elements.stintSelect.value === "compare-loaded";
  if (loadedCompareMode) drawLoadedComparison(xMap, yMap, plot);
  else if (compareMode) drawStintComparison(laps, xMap, yMap, plot);
  else drawLapEllipses(laps, xMap, yMap, plot);
}

function drawLapEllipses(laps, xMap, yMap, plot) {
  const ages = laps.map((lap) => lap.tyre_age_laps);
  const minAge = Math.min(...ages);
  const maxAge = Math.max(...ages);
  const selected = state.selectedLap && laps.find((lap) => lap.lap_number === state.selectedLap.lap_number)
    ? state.selectedLap
    : laps[0];
  if (selected && selected.points) {
    ellipseContext.save();
    ellipseContext.fillStyle = "rgba(24, 23, 22, 0.16)";
    selected.points.forEach(([lateral, longitudinal]) => {
      ellipseContext.beginPath();
      ellipseContext.arc(xMap(lateral), yMap(longitudinal), 1.6, 0, Math.PI * 2);
      ellipseContext.fill();
    });
    ellipseContext.restore();
  }

  laps.forEach((lap) => {
    const ratio = maxAge === minAge ? 0.5 : (lap.tyre_age_laps - minAge) / (maxAge - minAge);
    ellipseContext.save();
    ellipseContext.strokeStyle = colorRamp(ratio);
    ellipseContext.globalAlpha = selected && lap.lap_number === selected.lap_number ? 1 : 0.55;
    ellipseContext.lineWidth = selected && lap.lap_number === selected.lap_number ? 3.2 : 1.35;
    drawEllipsePath(ellipseContext, lap.ellipse, xMap, yMap);
    ellipseContext.stroke();
    ellipseContext.restore();
  });

  const legendWidth = Math.min(260, plot.right - plot.left - 16);
  const legendX = plot.left + 8;
  const legendY = plot.top + 12;
  const gradient = ellipseContext.createLinearGradient(legendX, 0, legendX + legendWidth, 0);
  VIRIDIS.forEach((color, index) => gradient.addColorStop(index / (VIRIDIS.length - 1), color));
  ellipseContext.save();
  ellipseContext.fillStyle = gradient;
  ellipseContext.fillRect(legendX, legendY, legendWidth, 7);
  ellipseContext.fillStyle = "#4f4944";
  ellipseContext.font = "600 11px Inter, system-ui, sans-serif";
  ellipseContext.textBaseline = "top";
  ellipseContext.textAlign = "left";
  ellipseContext.fillText(`Age ${minAge}`, legendX, legendY + 11);
  ellipseContext.textAlign = "right";
  ellipseContext.fillText(`Age ${maxAge} laps`, legendX + legendWidth, legendY + 11);
  ellipseContext.restore();

  updateEllipseReadout(selected);
}

function drawStintComparison(laps, xMap, yMap, plot) {
  const summaries = state.data.stints.map((stint) => {
    const stintLaps = laps.filter((lap) => lap.stint_number === stint.stint_number);
    if (!stintLaps.length) return null;
    return {
      stint,
      lapCount: stintLaps.length,
      ellipse: {
        longitudinal_axis_mps2: median(stintLaps.map((lap) => lap.ellipse.longitudinal_axis_mps2)),
        lateral_axis_mps2: median(stintLaps.map((lap) => lap.ellipse.lateral_axis_mps2)),
      },
    };
  }).filter(Boolean);

  summaries.forEach((summary, index) => {
    ellipseContext.save();
    ellipseContext.strokeStyle = COMPOUND_COLORS[summary.stint.compound] || COMPOUND_COLORS.UNKNOWN;
    ellipseContext.lineWidth = 2.2 + index * 0.35;
    ellipseContext.setLineDash(index === 0 ? [] : index === 1 ? [8, 4] : [3, 4]);
    drawEllipsePath(ellipseContext, summary.ellipse, xMap, yMap);
    ellipseContext.stroke();
    ellipseContext.restore();
  });

  ellipseContext.save();
  ellipseContext.font = "600 12px Inter, system-ui, sans-serif";
  ellipseContext.textAlign = "left";
  ellipseContext.textBaseline = "top";
  summaries.forEach((summary, index) => {
    const y = plot.top + 14 + index * 23;
    const color = COMPOUND_COLORS[summary.stint.compound] || COMPOUND_COLORS.UNKNOWN;
    ellipseContext.strokeStyle = color;
    ellipseContext.lineWidth = 3;
    ellipseContext.setLineDash(index === 0 ? [] : index === 1 ? [8, 4] : [3, 4]);
    ellipseContext.beginPath();
    ellipseContext.moveTo(plot.left + 10, y + 6);
    ellipseContext.lineTo(plot.left + 36, y + 6);
    ellipseContext.stroke();
    ellipseContext.setLineDash([]);
    ellipseContext.fillStyle = "#373330";
    ellipseContext.fillText(
      `Stint ${summary.stint.stint_number} · ${compoundLabel(summary.stint)} · median of ${summary.lapCount} clean laps`,
      plot.left + 44,
      y,
    );
  });
  ellipseContext.restore();

  elements.ellipseReadout.innerHTML = "<strong>Stint comparison:</strong> each line is the median fitted A<sub>x</sub> and A<sub>y</sub> across that stint’s clean laps. Same-compound stints remain separate so fuel-load and race-phase effects are visible.";
}

function drawLoadedComparison(xMap, yMap, plot) {
  const summaries = state.datasets.map((dataset) => {
    const stint = dataset.data.stints.find((item) => item.stint_number === dataset.selectedStint);
    const laps = dataset.data.laps.filter(
      (lap) => lap.clean_lap && lap.stint_number === dataset.selectedStint,
    );
    if (!stint || !laps.length) return null;
    return {
      dataset,
      stint,
      lapCount: laps.length,
      ellipse: {
        longitudinal_axis_mps2: median(laps.map((lap) => lap.ellipse.longitudinal_axis_mps2)),
        lateral_axis_mps2: median(laps.map((lap) => lap.ellipse.lateral_axis_mps2)),
      },
    };
  }).filter(Boolean);

  summaries.forEach((summary, index) => {
    ellipseContext.save();
    ellipseContext.strokeStyle = summary.dataset.color;
    ellipseContext.lineWidth = 2.7;
    ellipseContext.setLineDash(index === 0 ? [] : index === 1 ? [9, 4] : index === 2 ? [3, 4] : [10, 3, 2, 3]);
    drawEllipsePath(ellipseContext, summary.ellipse, xMap, yMap);
    ellipseContext.stroke();
    ellipseContext.restore();
  });

  ellipseContext.save();
  ellipseContext.font = "600 11px Inter, system-ui, sans-serif";
  ellipseContext.textAlign = "left";
  ellipseContext.textBaseline = "top";
  summaries.forEach((summary, index) => {
    const metadata = summary.dataset.data.metadata;
    const y = plot.top + 14 + index * 24;
    ellipseContext.strokeStyle = summary.dataset.color;
    ellipseContext.lineWidth = 3;
    ellipseContext.setLineDash(index === 0 ? [] : index === 1 ? [9, 4] : index === 2 ? [3, 4] : [10, 3, 2, 3]);
    ellipseContext.beginPath();
    ellipseContext.moveTo(plot.left + 10, y + 6);
    ellipseContext.lineTo(plot.left + 38, y + 6);
    ellipseContext.stroke();
    ellipseContext.setLineDash([]);
    ellipseContext.fillStyle = "#373330";
    ellipseContext.fillText(
      `${metadata.driver_name} · ${metadata.year} · S${summary.stint.stint_number} ${compoundLabel(summary.stint)} · ${summary.lapCount} laps`,
      plot.left + 46,
      y,
    );
  });
  ellipseContext.restore();

  elements.ellipseReadout.innerHTML = "<strong>Loaded-selection comparison:</strong> each line is the median 95% acceleration envelope for the stint chosen on that selection’s card. These envelopes may be compared across circuits, but they still include car, driver, fuel, aero, weather, and track effects.";
}

function updateEllipseReadout(lap) {
  if (!lap || !lap.ellipse) {
    elements.ellipseReadout.textContent = "Select a clean lap in the first chart.";
    return;
  }
  elements.ellipseReadout.innerHTML = [
    `<strong>Lap ${lap.lap_number}</strong> · ${compoundLabel(lap)} · tyre age ${lap.tyre_age_laps} laps`,
    `A<sub>y</sub> ${lap.ellipse.lateral_axis_mps2.toFixed(2)} m/s²`,
    `A<sub>x</sub> ${lap.ellipse.longitudinal_axis_mps2.toFixed(2)} m/s²`,
    `${(lap.ellipse.coverage * 100).toFixed(1)}% of ${lap.ellipse.sample_count} samples enclosed`,
  ].join(" &nbsp;·&nbsp; ");
}

function populateControls() {
  elements.stintSelect.replaceChildren();
  const dataset = activeDataset();
  state.data.stints.forEach((stint) => {
    const option = document.createElement("option");
    option.value = `stint-${stint.stint_number}`;
    option.textContent = `Stint ${stint.stint_number} · ${compoundLabel(stint)} · laps ${stint.lap_start}–${stint.lap_end} · start age ${stint.tyre_age_at_start}`;
    elements.stintSelect.append(option);
  });
  const compare = document.createElement("option");
  compare.value = "compare";
  compare.textContent = "Compare median ellipse for every stint";
  elements.stintSelect.append(compare);
  if (state.datasets.length > 1) {
    const compareLoaded = document.createElement("option");
    compareLoaded.value = "compare-loaded";
    compareLoaded.textContent = "Compare chosen stint across loaded selections";
    elements.stintSelect.append(compareLoaded);
  }
  const preferredStint = dataset?.selectedStint ?? defaultStintNumber(state.data);
  elements.stintSelect.value = `stint-${preferredStint}`;

  elements.legend.replaceChildren();
  state.data.stints.forEach((stint) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legend-item";
    button.dataset.stint = String(stint.stint_number);
    const clean = state.data.laps.filter((lap) => lap.stint_number === stint.stint_number && lap.clean_lap);
    const trend = linearFit(clean);
    const trendLabel = trend ? ` · ${trend.slope >= 0 ? "+" : ""}${trend.slope.toFixed(3)} s/lap` : "";
    button.innerHTML = `<span class="legend-swatch" style="--swatch:${COMPOUND_COLORS[stint.compound] || COMPOUND_COLORS.UNKNOWN}"></span><span>Stint ${stint.stint_number} · ${compoundLabel(stint)} · L${stint.lap_start}–${stint.lap_end} · start age ${stint.tyre_age_at_start}${trendLabel}</span>`;
    button.addEventListener("click", () => selectStint(stint.stint_number));
    elements.legend.append(button);
  });
  populateLapOptions();
  renderExcludedLaps();
}

function populateLapOptions(preferredLap = "") {
  elements.lapSelect.replaceChildren();
  if (["compare", "compare-loaded"].includes(elements.stintSelect.value)) {
    elements.lapSelect.append(new Option("Median comparison", ""));
    elements.lapSelect.disabled = true;
    return;
  }
  const stintNumber = Number(elements.stintSelect.value.replace("stint-", ""));
  const laps = state.data.laps.filter((lap) => lap.stint_number === stintNumber && lap.clean_lap);
  laps.forEach((lap) => {
    elements.lapSelect.append(new Option(
      `Lap ${lap.lap_number} · ${formatLapTime(lap.lap_duration)} · tyre age ${lap.tyre_age_laps}`,
      String(lap.lap_number),
    ));
  });
  elements.lapSelect.disabled = !laps.length;
  const chosen = preferredLap && laps.some((lap) => String(lap.lap_number) === String(preferredLap))
    ? String(preferredLap)
    : String(laps[0]?.lap_number ?? "");
  elements.lapSelect.value = chosen;
  state.selectedLap = laps.find((lap) => String(lap.lap_number) === chosen) || null;
}

function renderExcludedLaps() {
  elements.excludedLaps.replaceChildren();
  const excluded = state.data.laps.filter((lap) => !lap.clean_lap);
  if (!excluded.length) {
    const text = document.createElement("span");
    text.textContent = "None";
    elements.excludedLaps.append(text);
    return;
  }
  excluded.forEach((lap) => {
    const item = document.createElement("span");
    item.className = "excluded-lap";
    const reasons = lap.excluded_reasons?.length ? lap.excluded_reasons.join(" + ") : "not representative";
    item.textContent = `L${lap.lap_number} · ${formatLapTime(lap.lap_duration)} · ${reasons}`;
    elements.excludedLaps.append(item);
  });
}

function selectStint(stintNumber) {
  elements.stintSelect.value = `stint-${stintNumber}`;
  const dataset = activeDataset();
  if (dataset) dataset.selectedStint = stintNumber;
  populateLapOptions();
  drawAll();
}

function pointerLap(event) {
  if (!state.lapPlot || !state.data) return null;
  const rect = elements.lapCanvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  let closest = null;
  let closestDistance = Infinity;
  state.lapPlot.hitPoints.forEach((point) => {
    const distance = Math.hypot(pointerX - point.x, pointerY - point.y);
    if (distance < closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  });
  return closestDistance <= 18 ? { ...closest, pointerX, pointerY } : null;
}

function showTooltip(hit) {
  if (!hit) {
    elements.lapTooltip.hidden = true;
    return;
  }
  const lap = hit.lap;
  const metadata = hit.dataset.data.metadata;
  const flags = [lap.is_start_lap ? "standing start" : "", lap.is_pit_in_lap ? "pit-in" : "", lap.is_pit_out_lap ? "pit-out" : ""].filter(Boolean);
  elements.lapTooltip.innerHTML = [
    `<strong>Lap ${lap.lap_number} · ${formatLapTime(lap.lap_duration)}</strong>`,
    `${metadata.driver_name} · ${metadata.year} ${metadata.session}`,
    `${compoundLabel(lap)} · stint ${lap.stint_number} · tyre age ${lap.tyre_age_laps} laps`,
    `Session elapsed ${formatRaceElapsed(lap.race_elapsed_seconds)}${flags.length ? ` · ${flags.join(", ")}` : ""}`,
    "Click to inspect this lap’s ellipse",
  ].join("<br>");
  elements.lapTooltip.hidden = false;
  const maxLeft = elements.lapCanvas.clientWidth - elements.lapTooltip.offsetWidth - 8;
  const maxTop = elements.lapCanvas.clientHeight - elements.lapTooltip.offsetHeight - 8;
  elements.lapTooltip.style.left = `${clamp(hit.pointerX + 12, 8, maxLeft)}px`;
  elements.lapTooltip.style.top = `${clamp(hit.pointerY + 12, 8, maxTop)}px`;
}

function drawAll() {
  drawLapChart();
  drawEllipseChart();
}

function updateStudyHeading() {
  if (!state.data) return;
  const metadata = state.data.metadata;
  elements.studyTitle.textContent = `${metadata.driver_name} · ${metadata.year} ${metadata.meeting_name || `${metadata.country} GP`}`;
  elements.studySubtitle.textContent = `${metadata.session} · ${metadata.team_name || ""} · OpenF1 session ${metadata.session_key} · ${state.data.laps.length} timed laps · ${state.data.laps.filter((lap) => lap.clean_lap).length} representative · ${allocationLabel(metadata)}`;
  elements.allocationSourceNote.replaceChildren();
  if (metadata.tyre_allocation_sources?.length) {
    elements.allocationSourceNote.append(" ");
    metadata.tyre_allocation_sources.forEach((url, index) => {
      if (index) elements.allocationSourceNote.append(index === metadata.tyre_allocation_sources.length - 1 ? " and " : ", ");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = metadata.tyre_allocation_sources.length === 1 ? "Pirelli allocation source" : `Pirelli source ${index + 1}`;
      elements.allocationSourceNote.append(link);
    });
    elements.allocationSourceNote.append(".");
  }
}

function renderComparisonWorkspace() {
  elements.comparisonList.replaceChildren();
  const base = state.datasets[0];
  state.datasets.forEach((dataset, index) => {
    const metadata = dataset.data.metadata;
    const card = document.createElement("article");
    card.className = `comparison-card${dataset.id === state.activeDatasetId ? " active" : ""}`;

    const color = document.createElement("span");
    color.className = "comparison-color";
    color.style.setProperty("--series-color", dataset.color);

    const copy = document.createElement("div");
    copy.className = "comparison-copy";
    const title = document.createElement("strong");
    title.textContent = `${index === 0 ? "Base · " : ""}${metadata.driver_name} · ${metadata.year}`;
    const context = document.createElement("span");
    const lapStatus = lapComparable(dataset, base) ? "lap overlay" : "ellipse only";
    context.textContent = `${metadata.meeting_name} · ${metadata.session} · ${metadata.team_name || "Team unknown"} · ${lapStatus}`;
    const tyres = document.createElement("span");
    tyres.textContent = allocationLabel(metadata);
    copy.append(title, context, tyres);

    const actions = document.createElement("div");
    actions.className = "comparison-card-actions";
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.textContent = dataset.id === state.activeDatasetId ? "Inspecting" : "Inspect";
    inspect.disabled = dataset.id === state.activeDatasetId;
    inspect.addEventListener("click", () => setActiveDataset(dataset.id));
    actions.append(inspect);
    if (index > 0) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeDataset(dataset.id));
      actions.append(remove);
    }

    const stint = document.createElement("select");
    stint.setAttribute("aria-label", `Choose tyre stint for ${metadata.driver_name} ${metadata.year}`);
    dataset.data.stints.forEach((item) => {
      stint.append(new Option(
        `Ellipse: stint ${item.stint_number} · ${compoundLabel(item)} · L${item.lap_start}–${item.lap_end} · start age ${item.tyre_age_at_start}`,
        String(item.stint_number),
      ));
    });
    stint.value = String(dataset.selectedStint);
    stint.addEventListener("change", () => {
      dataset.selectedStint = Number(stint.value);
      if (dataset.id === state.activeDatasetId && elements.stintSelect.value.startsWith("stint-")) {
        elements.stintSelect.value = `stint-${dataset.selectedStint}`;
        populateLapOptions();
      }
      drawEllipseChart();
    });

    card.append(color, copy, actions, stint);
    elements.comparisonList.append(card);
  });

  if (!base) {
    elements.comparisonRule.textContent = "Load a base selection to begin.";
  } else {
    const included = state.datasets.filter((dataset) => lapComparable(dataset, base)).length;
    const excluded = state.datasets.length - included;
    elements.comparisonRule.textContent = `Lap-time rule: ${included} selection${included === 1 ? "" : "s"} shown because they match ${base.data.metadata.circuit} · ${base.data.metadata.session}.${excluded ? ` ${excluded} non-matching selection${excluded === 1 ? " is" : "s are"} kept for ellipse comparison only.` : ""}`;
  }
  elements.addComparisonButton.disabled = state.loading || state.datasets.length >= 4 || !elements.driverSelect.value;
}

function setActiveDataset(datasetId, preferredLap = "") {
  const dataset = state.datasets.find((item) => item.id === datasetId);
  if (!dataset) return;
  state.activeDatasetId = dataset.id;
  state.data = dataset.data;
  state.hoverLap = null;
  state.hoverDatasetId = null;
  state.selectedLap = null;
  updateStudyHeading();
  populateControls();
  if (preferredLap) populateLapOptions(preferredLap);
  renderComparisonWorkspace();
  drawAll();
}

function removeDataset(datasetId) {
  const wasActive = datasetId === state.activeDatasetId;
  state.datasets = state.datasets.filter((dataset) => dataset.id !== datasetId);
  if (wasActive) setActiveDataset(state.datasets[0].id);
  else {
    populateControls();
    renderComparisonWorkspace();
    drawAll();
  }
}

function applyAnalysisData(data, mode = "base") {
  const duplicate = state.datasets.find((dataset) => datasetKey(dataset.data) === datasetKey(data));
  if (mode === "comparison" && duplicate) {
    setActiveDataset(duplicate.id);
    return { added: false, reason: "already loaded" };
  }
  if (mode === "comparison" && state.datasets.length >= 4) {
    return { added: false, reason: "four-selection limit" };
  }
  const dataset = {
    id: state.nextDatasetId++,
    data,
    color: SERIES_COLORS[mode === "base" ? 0 : state.datasets.length % SERIES_COLORS.length],
    selectedStint: defaultStintNumber(data),
  };
  if (mode === "base") state.datasets = [dataset];
  else state.datasets.push(dataset);
  setActiveDataset(dataset.id);
  return { added: true };
}

async function analyseSelection(mode = "base") {
  const sessionKey = elements.sessionSelect.value;
  const driverNumber = elements.driverSelect.value;
  if (!sessionKey || !driverNumber) return;
  setSelectionLoading(true, "Building lap envelopes… this usually takes 10–25 seconds for a race.");
  try {
    const response = await fetch(`/api/tyre-analysis?${new URLSearchParams({
      session_key: sessionKey,
      driver_number: driverNumber,
    }).toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Analysis failed (${response.status})`);
    const result = applyAnalysisData(payload, mode);
    const verb = mode === "comparison" ? (result.added ? "Added comparison" : `Comparison ${result.reason}`) : "Loaded base";
    setSelectionLoading(false, `${verb}: ${payload.laps.filter((lap) => lap.clean_lap).length} representative laps; ${payload.laps.filter((lap) => !lap.clean_lap).length} excluded.`);
  } catch (error) {
    setSelectionLoading(false, `Could not build this analysis: ${error.message}`);
  }
}

async function runSelectionTask(task) {
  try {
    await task();
  } catch (error) {
    setSelectionLoading(false, `Could not load the selection: ${error.message}`);
  }
}

function bindInteractions() {
  elements.yearSelect.addEventListener("change", () => runSelectionTask(() => loadMeetings()));
  elements.meetingSelect.addEventListener("change", () => runSelectionTask(() => loadSessions()));
  elements.sessionSelect.addEventListener("change", () => runSelectionTask(async () => {
    updateSessionHint();
    await loadDrivers();
  }));
  elements.driverSelect.addEventListener("change", () => setSelectionLoading(false, "Ready to analyse this driver."));
  elements.analyseButton.addEventListener("click", () => analyseSelection("base"));
  elements.addComparisonButton.addEventListener("click", () => analyseSelection("comparison"));
  elements.lapAxisSelect.addEventListener("change", drawLapChart);

  elements.stintSelect.addEventListener("change", () => {
    if (elements.stintSelect.value.startsWith("stint-")) {
      const dataset = activeDataset();
      if (dataset) dataset.selectedStint = Number(elements.stintSelect.value.replace("stint-", ""));
      renderComparisonWorkspace();
    }
    populateLapOptions();
    drawAll();
  });
  elements.lapSelect.addEventListener("change", () => {
    state.selectedLap = state.data.laps.find((lap) => String(lap.lap_number) === elements.lapSelect.value && lap.clean_lap) || null;
    drawAll();
  });

  elements.lapCanvas.addEventListener("pointermove", (event) => {
    const hit = pointerLap(event);
    state.hoverLap = hit ? hit.lap : null;
    state.hoverDatasetId = hit ? hit.dataset.id : null;
    showTooltip(hit);
    drawLapChart();
  });
  elements.lapCanvas.addEventListener("pointerleave", () => {
    state.hoverLap = null;
    state.hoverDatasetId = null;
    showTooltip(null);
    drawLapChart();
  });
  elements.lapCanvas.addEventListener("click", (event) => {
    const hit = pointerLap(event);
    if (!hit || !hit.lap.clean_lap) return;
    if (hit.dataset.id !== state.activeDatasetId) setActiveDataset(hit.dataset.id, hit.lap.lap_number);
    state.selectedLap = hit.lap;
    elements.stintSelect.value = `stint-${hit.lap.stint_number}`;
    populateLapOptions(hit.lap.lap_number);
    drawAll();
  });

  const observer = new ResizeObserver(() => requestAnimationFrame(drawAll));
  observer.observe(elements.lapCanvas.parentElement);
  observer.observe(elements.ellipseCanvas.parentElement);
}

async function init() {
  try {
    const response = await fetch("tyre-analysis-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Data request failed (${response.status})`);
    const initialData = await response.json();
    replaceOptions(elements.yearSelect, YEARS.map((year) => ({ value: year, label: String(year) })), "Select year", initialData.metadata.year);
    await loadMeetings(initialData.metadata.meeting_key);
    await loadSessions(initialData.metadata.session_key);
    await loadDrivers(initialData.metadata.driver_number);
    bindInteractions();
    applyAnalysisData(initialData, "base");
    elements.status.textContent = "Ready. Choose another session or driver, then run the analysis.";
  } catch (error) {
    elements.status.textContent = `Could not load the tyre analysis: ${error.message}. Run python plot_tyre_performance.py, then open this page through server.py.`;
  }
}

init();
