if (typeof ObjC !== "undefined") ObjC.import("Foundation");

function readText(path) {
  if (typeof require === "function") return require("fs").readFileSync(path, "utf8");
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
  this.arcs = [];
}

[
  "setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo", "stroke",
  "save", "restore", "rect", "clip", "translate", "rotate", "arc", "fill",
  "quadraticCurveTo", "setLineDash",
].forEach(function (name) {
  FakeContext.prototype[name] = function () {};
});
FakeContext.prototype.arc = function (x, y, radius) { this.arcs.push({ x: x, y: y, radius: radius }); };
FakeContext.prototype.fillText = function (text) { this.texts.push(String(text)); };

const elements = {};
[
  "metric-options", "track-map-toggle", "data-delta-toggle", "map-speed-delta-toggle", "gg-toggle", "comparison-list",
  "comparison-template", "add-comparison", "add-comparison-bottom", "plot-button", "zoom-out", "zoom-in",
  "reset-zoom", "clear-markers", "trace-canvas", "track-map-panel",
  "track-map-canvas", "map-speed-legend", "gg-panel", "gg-canvas", "gg-status", "empty-state", "legend", "delta-readout", "status",
  "plot-title", "plot-subtitle", "axis-status", "marker-status",
].forEach(function (id) { elements[id] = new FakeElement(id); });

const traceContext = new FakeContext();
const mapContext = new FakeContext();
const ggContext = new FakeContext();
const chartWrap = new FakeElement("chart-wrap");
elements["trace-canvas"].width = 0;
elements["trace-canvas"].height = 0;
elements["trace-canvas"].getContext = function () { return traceContext; };
elements["trace-canvas"].closest = function () { return chartWrap; };
elements["track-map-canvas"].width = 0;
elements["track-map-canvas"].height = 0;
elements["track-map-canvas"].getContext = function () { return mapContext; };
elements["gg-canvas"].width = 0;
elements["gg-canvas"].height = 0;
elements["gg-canvas"].getContext = function () { return ggContext; };
elements["track-map-panel"].hidden = false;
elements["track-map-toggle"].checked = true;
elements["data-delta-toggle"].checked = true;
elements["map-speed-delta-toggle"].checked = true;
elements["gg-toggle"].checked = true;

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
        longitudinal_acceleration: [
          { x: 0, y: 7.8 },
          { x: 5, y: -17.7 },
          { x: 10, y: 2.9 },
        ],
        lateral_acceleration: [
          { x: 0, y: 0 },
          { x: 5, y: 23.5 },
          { x: 10, y: 0 },
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
  const mapSpeedSegments = mapSpeedAdvantageSegments(maxSeries, lewisSeries, 20);
  assert(mapSpeedSegments.length === 20, "Map speed comparison did not cover the full lap");
  assert(mapSpeedSegments.every(function (segment) { return segment.winner === "comparison"; }), "Map speed comparison did not color the faster driver");
  const swingSeries = syntheticSeries("Lando", "NOR", "#f59e0b", 0);
  swingSeries.pointsByMetric.speed = [{ x: 0, y: 80 }, { x: 5, y: 230 }, { x: 10, y: 120 }];
  prepareSeriesData([maxSeries, swingSeries], [speedMetric]);
  const changingAdvantage = mapSpeedAdvantageSegments(maxSeries, swingSeries, 20);
  assert(changingAdvantage.some(function (segment) { return segment.winner === "reference"; }), "Map never shows the reference driver faster");
  assert(changingAdvantage.some(function (segment) { return segment.winner === "comparison"; }), "Map never shows the comparison driver faster");
  prepareSeriesData([maxSeries, lewisSeries], [speedMetric, gearMetric]);

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
  const throttleMetric = METRICS.find(function (metric) { return metric.key === "throttle"; });
  const throttleMeaning = deltaMeaning(throttleMetric);
  assert(throttleMeaning.positive === "Lewis more throttle than Max", "Positive throttle meaning is incorrect");
  assert(throttleMeaning.negative === "Max more throttle than Lewis", "Negative throttle meaning does not reverse the driver order");
  assert((throttleMeaning.positive + throttleMeaning.negative).indexOf("less") === -1, "Delta meaning still uses less language");

  const acceleratingSpeed = [0, 1, 2, 3, 4, 5].map(function (time) {
    return { x: time, y: 36 + time * 36 };
  });
  const longitudinalAcceleration = deriveLongitudinalAcceleration(acceleratingSpeed);
  assert(longitudinalAcceleration.length === acceleratingSpeed.length, "Longitudinal acceleration did not retain the telemetry samples");
  assert(longitudinalAcceleration.every(function (point) { return point.y > 9.99 && point.y < 10.01; }), "Longitudinal acceleration calculation is incorrect");

  const circularSpeed = [];
  const circularTrack = [];
  for (let index = 0; index <= 20; index += 1) {
    const elapsed = index * 0.5;
    const angle = elapsed * 0.1;
    circularSpeed.push({ x: elapsed, y: 180 });
    circularTrack.push({ elapsed: elapsed, x: Math.cos(angle) * 1000, y: Math.sin(angle) * 1000 });
  }
  const lateralAcceleration = deriveLateralAcceleration(circularSpeed, circularTrack);
  const averageLateralAcceleration = lateralAcceleration.reduce(function (sum, point) { return sum + Math.abs(point.y); }, 0) / lateralAcceleration.length;
  assert(lateralAcceleration.length > 0 && averageLateralAcceleration > 4.4 && averageLateralAcceleration < 5.7, "Lateral acceleration calculation is incorrect");

  const ggPoints = ggPointsForSeries(maxSeries);
  const linkedGGPoint = ggPointAtCursor(maxSeries, { x: 5, progress: 0.5, mode: "progress" });
  assert(ggPoints.length === 3, "G–G diagram did not pair the acceleration channels");
  assert(Math.abs(linkedGGPoint.x - 23.5) < 0.000001 && Math.abs(linkedGGPoint.y + 17.7) < 0.000001, "Track cursor did not resolve to the matching G–G point");
  state.hover = { x: 5, progress: 0.5, mode: "progress" };
  ggContext.arcs = [];
  drawGGDiagram();
  assert(ggContext.arcs.length > ggPoints.length, "G–G cursor highlight was not drawn over the acceleration cloud");
  assert(elements["gg-status"].textContent.indexOf("aᵧ 23.50 m/s²") !== -1, "G–G cursor readout is missing the linked lateral acceleration");
  state.hover = null;


  updateChartHeight(12);
  const requiredHeight = CHART_PAD.top + CHART_PAD.bottom + 12 * MIN_PANEL_HEIGHT + 11 * PANEL_GAP;
  assert(parseFloat(chartWrap.style.minHeight) >= requiredHeight, "Large metric selections do not reserve enough chart height");
  const heightBeforeHoverRedraw = chartWrap.style.minHeight;
  drawChart();
  drawChart();
  assert(chartWrap.style.minHeight === heightBeforeHoverRedraw, "Trace redraw changed the chart layout height");

  addTrackMarker(0.2);
  addTrackMarker(0.6);
  assert(Math.abs(state.zoom.minX - 20) < 0.001 && Math.abs(state.zoom.maxX - 60) < 0.001, "Two markers did not zoom to their track range");
  mapContext.texts = [];
  drawTrackMap();
  assert(mapContext.texts.indexOf("A") !== -1 && mapContext.texts.indexOf("B") !== -1, "Map selection markers were not rendered");

  mapContext.arcs = [];
  drawMapCursor({ mode: "progress", progress: 0.5, x: 5 }, function (x) { return x; }, function (y) { return y; }, true);
  assert(mapContext.arcs.length === 1 && mapContext.arcs[0].radius === 7, "Track-position map cursor does not collapse to one fixed-size dot");
  mapContext.arcs = [];
  drawMapCursor({ mode: "time", x: 5 }, function (x) { return x; }, function (y) { return y; }, true);
  assert(mapContext.arcs.length === state.plotted.length, "Time-based map cursors no longer show every compared lap");

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
assert(/data-field="lap" multiple/.test(html), "Lap selection does not allow multiple laps");
assert(/id="map-speed-delta-toggle"[^>]*checked/.test(html), "Map speed advantage is not enabled by default");
assert(/id="gg-toggle"[^>]*checked/.test(html), "G–G diagram is not enabled by default");
assert(/\.controls-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/m.test(css), "Comparison rows can still stretch the desktop plot layout");
assert(/\.comparison-list\s*\{[^}]*overflow-y:\s*auto;/m.test(css), "Comparison list does not scroll independently");
assert(/\.gg-header\s*\{[^}]*height:\s*60px;[^}]*overflow:\s*hidden;/m.test(css), "G–G header height can still change while the cursor moves");
assert(/\.gg-header p\s*\{[^}]*height:\s*34px;[^}]*overflow:\s*hidden;/m.test(css), "G–G cursor readout can still resize the plot");
assert(/\.viz-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/m.test(css), "Track map and G–G diagram are not locked into two equal columns");
assert(/\.viz-grid > \.canvas-wrap\s*\{[^}]*grid-column:\s*1 \/ -1;/m.test(css), "Telemetry traces do not span the full top row");
assert(!/@media \(min-width:\s*1600px\)[\s\S]*?\.viz-grid/m.test(css), "Wide layouts can still move the telemetry, track, and G–G panels into one row");
assert(appSource.indexOf("consecutiveLapGroups") !== -1, "Consecutive selected laps are not batched");
assert(appSource.indexOf('key: "longitudinal_acceleration"') !== -1, "Longitudinal acceleration metric is missing");
assert(appSource.indexOf('key: "lateral_acceleration"') !== -1, "Lateral acceleration metric is missing");
assert(appSource.indexOf("select.scrollTop = row.lapScrollAnchor.laps") !== -1, "Lap selection does not preserve its scroll position");
assert(appSource.indexOf('select.addEventListener("click"') !== -1, "Lap selection does not override Chrome's late native scroll");
assert(appSource.indexOf("British Grand Prix") === -1 && appSource.indexOf("Antonelli") === -1, "The initial selection still contains a hard-coded event or driver");
Object.keys(elements).forEach(function (id) {
  assert(html.indexOf('id="' + id + '"') !== -1, "Missing DOM element: " + id);
});
console.log("dashboard logic tests passed");
