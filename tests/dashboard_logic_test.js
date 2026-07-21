ObjC.import("Foundation");

function readText(path) {
  const data = $.NSData.dataWithContentsOfFile($(path).stringByStandardizingPath);
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function FakeClassList() {
  this.values = {};
}

FakeClassList.prototype.toggle = function (name, enabled) {
  this.values[name] = Boolean(enabled);
};

function FakeElement(id) {
  this.id = id;
  this.children = [];
  this.style = {};
  this.classList = new FakeClassList();
  this.hidden = false;
  this.disabled = false;
  this.checked = false;
  this.value = "";
  this.textContent = "";
  this.clientWidth = 900;
  this.clientHeight = 700;
}

FakeElement.prototype.addEventListener = function () {};
FakeElement.prototype.append = function () {
  for (let index = 0; index < arguments.length; index += 1) this.children.push(arguments[index]);
};
FakeElement.prototype.querySelectorAll = function () { return []; };
FakeElement.prototype.getBoundingClientRect = function () {
  return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 };
};

function FakeContext() {
  this.texts = [];
}

[
  "setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke",
  "save", "restore", "rect", "clip", "translate", "rotate", "arc", "fill",
  "quadraticCurveTo", "setLineDash",
].forEach(function (name) {
  FakeContext.prototype[name] = function () {};
});
FakeContext.prototype.fillText = function (text) { this.texts.push(String(text)); };

const elements = {};
[
  "metric-options", "track-map-toggle", "data-delta-toggle", "comparison-list",
  "comparison-template", "add-comparison", "plot-button", "zoom-out", "zoom-in",
  "reset-zoom", "clear-markers", "trace-canvas", "track-map-panel",
  "track-map-canvas", "empty-state", "legend", "delta-readout", "status",
  "plot-title", "plot-subtitle", "axis-status", "marker-status",
].forEach(function (id) { elements[id] = new FakeElement(id); });

const traceContext = new FakeContext();
const mapContext = new FakeContext();
const chartWrap = new FakeElement("chart-wrap");
elements["trace-canvas"].width = 0;
elements["trace-canvas"].height = 0;
elements["trace-canvas"].getContext = function () { return traceContext; };
elements["trace-canvas"].closest = function () { return chartWrap; };
elements["track-map-canvas"].width = 0;
elements["track-map-canvas"].height = 0;
elements["track-map-canvas"].getContext = function () { return mapContext; };
elements["track-map-panel"].hidden = false;
elements["track-map-toggle"].checked = true;
elements["data-delta-toggle"].checked = true;

const timeInput = { checked: false, value: "time", addEventListener: function () {} };
const trackInput = { checked: true, value: "track", addEventListener: function () {} };
const speedInput = { checked: true, value: "speed" };
elements["metric-options"].querySelectorAll = function () { return [speedInput]; };

const document = {
  querySelector: function (selector) { return elements[selector.slice(1)]; },
  querySelectorAll: function (selector) {
    return selector === 'input[name="axis-mode"]' ? [timeInput, trackInput] : [];
  },
  createElement: function (name) { return new FakeElement(name); },
};
const window = {
  devicePixelRatio: 1,
  addEventListener: function () {},
};
function requestAnimationFrame(callback) { callback(); return 1; }

const appSource = readText("app.js");
let source = appSource;
source = source.slice(0, source.lastIndexOf("\ninitMetricOptions();"));
source += `
  function syntheticSeries(firstName, acronym, color, offset) {
    const trackPoints = [
      { elapsed: 0, x: 0, y: 0 },
      { elapsed: 5, x: 50, y: 20 },
      { elapsed: 10, x: 100, y: 0 },
    ];
    return {
      color,
      driver: { first_name: firstName, last_name: firstName, name_acronym: acronym },
      lap: { lap_duration: 10, lap_number: 1 },
      meeting: { year: 2026, meeting_name: "British Grand Prix" },
      session: { session_name: "Qualifying" },
      pointsByMetric: {
        speed: [
          { x: 0, y: 100 + offset },
          { x: 5, y: 200 + offset },
          { x: 10, y: 150 + offset },
        ],
        n_gear: [
          { x: 0, y: 1 },
          { x: 3, y: 3 },
          { x: 6, y: 5 },
          { x: 10, y: 8 },
        ],
      },
      trackPoints,
      progressPoints: buildProgressPoints(trackPoints),
    };
  }

  const speedMetric = METRICS[0];
  const gearMetric = METRICS.find(function (metric) { return metric.key === "n_gear"; });
  const maxSeries = syntheticSeries("Max", "VER", "#e10600", 0);
  const lewisSeries = syntheticSeries("Lewis", "HAM", "#008c95", 10);
  lewisSeries.pointsByMetric.speed[1].x = 4;
  lewisSeries.pointsByMetric.n_gear[1].x = 2;
  prepareSeriesData([maxSeries, lewisSeries], [speedMetric, gearMetric]);
  state.plotted = [maxSeries, lewisSeries];
  state.metrics = [speedMetric, gearMetric];

  const cachedTrack = metricPointsForAxis(lewisSeries, speedMetric, "track");
  assert(cachedTrack === metricPointsForAxis(lewisSeries, speedMetric, "track"), "Track samples were not cached");
  assert(cachedTrack.length === lewisSeries.pointsByMetric.speed.length, "Track mode did not retain every telemetry point");
  const cachedDelta = metricDeltaPoints(lewisSeries, maxSeries, speedMetric, "track");
  assert(cachedDelta === metricDeltaPoints(lewisSeries, maxSeries, speedMetric, "track"), "Delta samples were not cached");
  assert(cachedDelta.length === 4, "Track delta did not use the union of both drivers' telemetry points");
  assert(metricDeltaPoints(lewisSeries, maxSeries, speedMetric, "time").length === 4, "Time delta did not use the union of both drivers' telemetry points");
  const cursorPoint = interpolatePlotPoint(cachedDelta, 45);
  const leftPoint = cachedDelta.find(function (point) { return Math.abs(point.x - 40) < 0.001; });
  const rightPoint = cachedDelta.find(function (point) { return Math.abs(point.x - 50) < 0.001; });
  const expectedCursorY = leftPoint.y + (rightPoint.y - leftPoint.y) * 0.5;
  assert(Math.abs(cursorPoint.x - 45) < 0.001 && Math.abs(cursorPoint.y - expectedCursorY) < 0.000001, "Cursor point is not on the plotted polyline");

  const gearTicks = integerTicks(gearMetric.min, gearMetric.max);
  assert(gearTicks.join(",") === "1,2,3,4,5,6,7,8", "Gear axis does not use the integer gears 1 through 8");
  assert(gearTicks.every(function (tick) { return Number.isInteger(tick); }), "Gear axis contains decimal ticks");
  const gearBetweenChanges = interpolatePlotPoint([{ x: 0, y: 1 }, { x: 5, y: 3 }], 2.5, true);
  const gearAtChange = interpolatePlotPoint([{ x: 0, y: 1 }, { x: 5, y: 3 }], 5, true);
  assert(gearBetweenChanges.y === 1 && gearAtChange.y === 3, "Gear cursor does not follow the plotted step trace");
  assert(metricDeltaPoints(lewisSeries, maxSeries, gearMetric, "time").every(function (point) {
    return Number.isInteger(point.y);
  }), "Gear delta contains interpolated decimal gears");

  const deltaPanel = { type: "delta", metric: speedMetric, xMode: "track" };
  const deltaBounds = panelBounds(state.plotted, deltaPanel);
  assert(deltaBounds.minY < 0 && deltaBounds.maxY > 0, "Delta bounds do not include zero");
  assert(Math.abs(deltaBounds.minY + deltaBounds.maxY) < 0.000001, "Delta bounds are not symmetric around zero");

  traceContext.texts = [];
  drawGrid(900, CHART_PAD, { top: 20, bottom: 220, height: 200 }, { minX: 0, maxX: 100 }, deltaBounds, deltaPanel, function (x) { return 72 + x * 8; }, function (y) { return 120 - y; });
  assert(traceContext.texts.indexOf("0") !== -1, "Delta axis does not render a zero tick");
  assert(traceContext.texts.indexOf("Lewis faster than Max") !== -1, "Positive delta meaning is missing or incorrect");
  assert(traceContext.texts.indexOf("Max faster than Lewis") !== -1, "Negative delta meaning does not reverse the driver order");
  const throttleMeaning = deltaMeaning(METRICS[1]);
  assert(throttleMeaning.positive === "Lewis more throttle than Max", "Positive throttle meaning is incorrect");
  assert(throttleMeaning.negative === "Max more throttle than Lewis", "Negative throttle meaning does not reverse the driver order");
  assert((throttleMeaning.positive + throttleMeaning.negative).indexOf("less") === -1, "Delta meaning still uses less language");

  updateChartHeight(12);
  const requiredHeight = CHART_PAD.top + CHART_PAD.bottom + 12 * MIN_PANEL_HEIGHT + 11 * PANEL_GAP;
  assert(parseFloat(chartWrap.style.height) >= requiredHeight, "Large metric selections do not reserve enough chart height");
  const heightBeforeHoverRedraw = chartWrap.style.height;
  drawChart();
  drawChart();
  assert(chartWrap.style.height === heightBeforeHoverRedraw, "Trace redraw changed the chart layout height");

  addTrackMarker(0.2);
  addTrackMarker(0.6);
  assert(Math.abs(state.zoom.minX - 20) < 0.001 && Math.abs(state.zoom.maxX - 60) < 0.001, "Two markers did not zoom to their track range");
  mapContext.texts = [];
  drawTrackMap();
  assert(mapContext.texts.indexOf("A") !== -1 && mapContext.texts.indexOf("B") !== -1, "Map selection markers were not rendered");

  clearMarkers();
  assert(state.markers.length === 0 && state.zoom === null, "Clear markers did not reset the selection");
  addTrackMarker(0.2);
  addTrackMarker(0.6);
  addTrackMarker(0.8);
  assert(state.markers.length === 1 && Math.abs(state.markers[0] - 0.8) < 0.001 && state.zoom === null, "A third map click did not start a new selection");
  clearMarkers();
  zoomBy(0.5);
  assert(Math.abs(state.zoom.minX - 25) < 0.001 && Math.abs(state.zoom.maxX - 75) < 0.001, "Independent plot zoom failed");
  panZoomBy(10);
  assert(Math.abs(state.zoom.minX - 35) < 0.001 && Math.abs(state.zoom.maxX - 85) < 0.001, "Horizontal plot panning failed");
  panZoomBy(100);
  assert(Math.abs(state.zoom.minX - 50) < 0.001 && Math.abs(state.zoom.maxX - 100) < 0.001, "Plot panning did not preserve the zoom span at the right edge");
  panZoomBy(-100);
  assert(Math.abs(state.zoom.minX) < 0.001 && Math.abs(state.zoom.maxX - 50) < 0.001, "Plot panning did not preserve the zoom span at the left edge");
  resetZoom();
  assert(state.zoom === null, "Reset zoom failed");

  trackInput.checked = false;
  timeInput.checked = true;
  addTrackMarker(0.2);
  addTrackMarker(0.6);
  assert(Math.abs(state.zoom.minX - 2) < 0.001 && Math.abs(state.zoom.maxX - 6) < 0.001, "Marker zoom did not convert track positions to elapsed time");
  clearMarkers();
  zoomBy(0.5);
  assert(Math.abs(state.zoom.minX - 2.5) < 0.001 && Math.abs(state.zoom.maxX - 7.5) < 0.001, "Independent time-axis zoom failed");
  resetZoom();
  timeInput.checked = false;
  trackInput.checked = true;

  emptyState.hidden = true;
  drawChart();
  assert(emptyState.hidden === true, "Empty-state overlay became visible over plotted data");
  renderLegend(state.plotted);
  assert(legend.children.length === 2, "Legend did not render one stable item per series");
`;

eval(source);

const css = readText("styles.css");
const html = readText("index.html");
assert(css.indexOf(".empty-state[hidden]") !== -1, "Hidden empty-state CSS rule is missing");
assert(/#trace-canvas\s*\{[^}]*position:\s*absolute;/m.test(css), "Trace canvas can still resize its grid container");
assert(/\.delta-readout\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*height:\s*42px;[^}]*overflow-x:\s*auto;/m.test(css), "Changing readout text can still change the plot layout height");
assert(html.indexOf('id="legend"') < html.indexOf('class="viz-grid"'), "Legend is not above the plots");
assert(/name="axis-mode" value="track" checked/.test(html), "Track position is not the default comparison axis");
assert(!/name="axis-mode" value="time" checked/.test(html), "Time is still the default comparison axis");
assert(appSource.indexOf("British Grand Prix") === -1 && appSource.indexOf("Antonelli") === -1, "The initial selection still contains a hard-coded event or driver");
Object.keys(elements).forEach(function (id) {
  assert(html.indexOf('id="' + id + '"') !== -1, "Missing DOM element: " + id);
});
console.log("dashboard logic tests passed");
