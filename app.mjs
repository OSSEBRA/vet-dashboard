import {
  applyTemperatureMethod,
  analyzeIntervention,
  calendarDateValue,
  calculatePeriodChanges,
  calculateVET,
  comparePeriods,
  identifyFloorCurve,
  interpolateCurve,
  parseCalendarDateMs,
  parseEngineeringCurveCsv,
  parseTimestampMs,
  parseVETCsv,
  summarizeSeries,
} from "./vet-model.mjs";

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const signedFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, signDisplay: "always" });
function historicalFloorActive() { return potentialMethod.value === "automatic"; }
function referenceSpanLabel() { return historicalFloorActive() ? "Reference temperature span" : "Available temperature span"; }
function referencePotentialLabel() { return historicalFloorActive() ? "Reference volumetric potential" : "Maximum practical volumetric potential"; }
function utilizationReferenceText() { return historicalFloorActive() ? "historical temperature-potential reference" : "selected practical temperature potential"; }
const snapshotForm = document.getElementById("snapshot-form");
const snapshotFields = [...snapshotForm.elements].filter(field => field instanceof HTMLInputElement);
const snapshotError = document.getElementById("snapshot-error");

function display(id, value, format = numberFormat) {
  document.getElementById(id).value = value === null ? "—" : format.format(value);
}

function snapshotInputs() {
  const field = name => snapshotForm.elements[name];
  const read = name => field(name).value === "" ? null : field(name).valueAsNumber;
  return {
    soldEnergyMWh: read("soldEnergyMWh"),
    pumpedVolumeM3: read("pumpedVolumeM3"),
    TcapC: read("TcapC"),
    TfloorC: read("TfloorC"),
    supplyTemperatureC: read("supplyTemperatureC"),
    returnTemperatureC: read("returnTemperatureC"),
  };
}

function clearSnapshot() {
  ["snapshot-vet", "snapshot-utilization", "snapshot-delta", "snapshot-potential"].forEach(id => display(id, null));
  ["operating-energy", "operating-volume", "operating-supply", "operating-return", "operating-measured-delta"].forEach(id => display(id, null));
  document.getElementById("snapshot-util-bar").style.width = "0%";
  document.getElementById("snapshot-util-marker").style.left = "100%";
  document.getElementById("snapshot-util-label").textContent = "— of scenario potential";
  document.getElementById("snapshot-scale-end").textContent = "—";
  document.getElementById("snapshot-overflow-note").textContent = "";
  document.querySelector(".util-track").setAttribute("aria-label", "VET utilization compared with the entered scenario bounds.");
}

function renderSnapshot() {
  snapshotError.textContent = "";
  snapshotFields.forEach(field => field.removeAttribute("aria-invalid"));
  const input = snapshotInputs();
  const required = [input.soldEnergyMWh, input.pumpedVolumeM3, input.TcapC, input.TfloorC];
  if (required.some(value => value === null)) {
    clearSnapshot();
    return;
  }

  try {
    const result = calculateVET(input);
    display("snapshot-vet", result.VET);
    display("snapshot-utilization", result.utilizationPercent, percentFormat);
    display("snapshot-delta", result.availableDeltaK);
    display("snapshot-potential", result.maximumPotentialKWhM3);
    display("operating-energy", result.soldEnergyMWh);
    display("operating-volume", result.pumpedVolumeM3);
    display("operating-supply", result.supplyTemperatureC);
    display("operating-return", result.returnTemperatureC);
    display("operating-measured-delta", result.measuredDeltaK, signedFormat);

    const scale = Math.max(1, result.utilization);
    document.getElementById("snapshot-util-bar").style.width = `${Math.max(0, result.utilization / scale * 100)}%`;
    document.getElementById("snapshot-util-marker").style.left = `${100 / scale}%`;
    document.getElementById("snapshot-util-label").textContent = `${percentFormat.format(result.utilizationPercent)}% of scenario potential`;
    document.getElementById("snapshot-scale-end").textContent = `${percentFormat.format(scale * 100)}% scale`;
    document.querySelector(".util-track").setAttribute("aria-label", `VET is ${percentFormat.format(result.utilizationPercent)} percent of the practical scenario potential.`);
    document.getElementById("snapshot-overflow-note").textContent = result.utilization > 1
      ? "Scale extends beyond 100% to show VET above the potential implied by the entered scenario bounds."
      : "Reference marker indicates 100% of the potential implied by the entered scenario bounds.";
  } catch (error) {
    clearSnapshot();
    snapshotError.textContent = error.message;
    if (input.soldEnergyMWh !== null && input.soldEnergyMWh < 0) snapshotForm.elements.soldEnergyMWh.setAttribute("aria-invalid", "true");
    if (input.pumpedVolumeM3 !== null && input.pumpedVolumeM3 <= 0) snapshotForm.elements.pumpedVolumeM3.setAttribute("aria-invalid", "true");
    if (input.TcapC !== null && input.TfloorC !== null && input.TfloorC >= input.TcapC) {
      snapshotForm.elements.TcapC.setAttribute("aria-invalid", "true");
      snapshotForm.elements.TfloorC.setAttribute("aria-invalid", "true");
    }
  }
}

snapshotForm.addEventListener("input", renderSnapshot);

const snapshotTab = document.getElementById("snapshot-tab");
const seriesTab = document.getElementById("series-tab");
const interventionTab = document.getElementById("intervention-tab");
const snapshotView = document.getElementById("snapshot-view");
const seriesView = document.getElementById("series-view");
const interventionView = document.getElementById("intervention-view");

function selectTab(tab) {
  for (const [button, view] of [[snapshotTab, snapshotView], [seriesTab, seriesView], [interventionTab, interventionView]]) {
    const selected = button === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    view.hidden = !selected;
  }
}

snapshotTab.addEventListener("click", () => selectTab(snapshotTab));
seriesTab.addEventListener("click", () => selectTab(seriesTab));
interventionTab.addEventListener("click", () => selectTab(interventionTab));

function setSummary(id, value, format = numberFormat) {
  document.getElementById(id).value = value === null ? "—" : format.format(value);
}

function renderSummary(points) {
  const summary = summarizeSeries(points);
  const historical = historicalFloorActive();
  setSummary("summary-energy", summary.totalSoldEnergyMWh);
  setSummary("summary-volume", summary.totalPumpedVolumeM3);
  setSummary("summary-vet", summary.periodVET);
  setSummary("summary-util", summary.aggregateUtilizationPercent, percentFormat);
  setSummary("summary-delta", summary.volumeWeightedAvailableDeltaK);
  document.getElementById("summary-delta-label").textContent = `Average ${referenceSpanLabel().toLowerCase()}`;
  document.getElementById("summary-util-label").textContent = historical
    ? "Aggregate η_VET · historical reference utilization"
    : "Aggregate η_VET · practical potential utilization";
  document.getElementById("interval-span-heading").innerHTML = `${referenceSpanLabel()}<br>K`;
  document.getElementById("interval-potential-heading").innerHTML = `${referencePotentialLabel()}<br>kWh/m³`;
  setSummary("summary-measured-delta", summary.volumeWeightedMeasuredDeltaK);
  setSummary("summary-supply", summary.volumeWeightedSupplyTemperatureC);
  setSummary("summary-return", summary.volumeWeightedReturnTemperatureC);
  setSummary("summary-outdoor", summary.timeWeightedOutdoorTemperatureC);
  document.getElementById("series-count").textContent = `${summary.count} accepted interval${summary.count === 1 ? "" : "s"}`;
  document.getElementById("summary-measured-card").hidden = summary.volumeWeightedMeasuredDeltaK === null;
  document.getElementById("summary-supply-card").hidden = summary.volumeWeightedSupplyTemperatureC === null;
  document.getElementById("summary-return-card").hidden = summary.volumeWeightedReturnTemperatureC === null;
  document.getElementById("summary-outdoor-card").hidden = summary.timeWeightedOutdoorTemperatureC === null;
  const potentialName = historical ? "historical reference potential" : "practical temperature potential";
  document.getElementById("series-theory-note").textContent = historical
    ? "VET [kWh/m³] is useful energy delivered per circulated water volume. η_VET [%] is utilization relative to the empirical historical temperature-potential reference, not a physical maximum. Values above 100% mean operation exceeds that reference and are permitted. VET and η_VET remain distinct; network temperature averages are weighted by pumped volume and outdoor temperature is time-weighted."
    : "VET [kWh/m³] is useful energy delivered per circulated water volume. η_VET [%] is utilization relative to the selected engineering or manual practical temperature potential. Values above 100% mean VET exceeds the potential implied by those bounds. VET and η_VET remain distinct; network temperature averages are weighted by pumped volume and outdoor temperature is time-weighted.";
  document.getElementById("potential-coverage").textContent = summary.potentialIntervalCount === summary.count
    ? `${historical ? "Historical reference potential" : "Practical temperature potential"} and η_VET calculated for all ${summary.count} accepted intervals.${historical && points.some(point => point.utilizationPercent > 100) ? " Values above 100% mean measured VET exceeds the empirical historical reference; this is permitted and is not an impossible value." : ""}`
    : `VET calculated for all ${summary.count} accepted intervals; η_VET relative to ${potentialName} is unavailable for ${summary.count - summary.potentialIntervalCount} intervals because temperature bounds are missing or invalid.`;
  renderCharts(points);
  renderTable(points);
}

function renderTable(points) {
  const body = document.getElementById("interval-rows");
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const row = document.createElement("tr");
    const values = [
      formatUtcTimestamp(point.timestampMs),
      numberFormat.format(point.soldEnergyMWh),
      numberFormat.format(point.pumpedVolumeM3),
      Number.isFinite(point.outdoorTemperatureC) ? numberFormat.format(point.outdoorTemperatureC) : "—",
      Number.isFinite(point.TcapC) ? numberFormat.format(point.TcapC) : "—",
      Number.isFinite(point.TfloorC) ? numberFormat.format(point.TfloorC) : "—",
      point.potentialError ? "Unavailable" : point.floorOutsideRange ? "Outside calibration" : potentialMethod.value === "manual" ? "Manual / scenario" : "Within curve",
      point.supplyTemperatureC === null ? "—" : numberFormat.format(point.supplyTemperatureC),
      point.returnTemperatureC === null ? "—" : numberFormat.format(point.returnTemperatureC),
      numberFormat.format(point.VET),
      Number.isFinite(point.availableDeltaK) ? numberFormat.format(point.availableDeltaK) : "—",
      Number.isFinite(point.maximumPotentialKWhM3) ? numberFormat.format(point.maximumPotentialKWhM3) : "—",
      Number.isFinite(point.utilizationPercent) ? percentFormat.format(point.utilizationPercent) : "—",
      point.measuredDeltaK === null ? "—" : numberFormat.format(point.measuredDeltaK),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    fragment.append(row);
  }
  body.replaceChildren(fragment);
  document.getElementById("interval-summary").textContent = `Show interval calculations (${points.length})`;
}

function addSvgElement(parent, tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  parent.append(node);
  return node;
}

function formatTick(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 }).format(value);
}

function formatUtcTimestamp(timestampMs) {
  const iso = new Date(timestampMs).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace(".000Z", "Z");
}

function formatTimestamp(timestampMs, spanMs) {
  const date = new Date(timestampMs);
  return spanMs < 2 * 86400000
    ? date.toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    : date.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
}

function renderChart({ title, note, points, series, zeroBased = true, root = chartsRoot, eventTimestampMs = null }) {
  const card = document.createElement("article");
  card.className = "chart-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const description = document.createElement("p");
  description.className = "chart-note";
  description.textContent = note;
  card.append(heading, description);

  const width = 700;
  const height = 230;
  const margin = { top: 15, right: 13, bottom: 42, left: 55 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = series.flatMap(item => item.values.filter(Number.isFinite));
  if (!values.length) {
    const empty = document.createElement("p");
    empty.className = "chart-note";
    empty.textContent = "No valid temperature-potential calculations are available for this chart.";
    card.append(empty);
    root.append(card);
    return;
  }
  let yMin = zeroBased ? 0 : Math.min(...values);
  let yMax = Math.max(...values);
  if (yMax === yMin) {
    const padding = Math.abs(yMax) * .1 || 1;
    yMin = zeroBased ? 0 : yMin - padding;
    yMax += padding;
  } else {
    const padding = (yMax - yMin) * .08;
    yMin = zeroBased ? 0 : yMin - padding;
    yMax += padding;
  }
  const xAt = index => points.length < 2
    ? margin.left + plotWidth / 2
    : margin.left + (points[index].timestampMs - points[0].timestampMs) / (points.at(-1).timestampMs - points[0].timestampMs || 1) * plotWidth;
  const yAt = value => margin.top + (yMax - value) / (yMax - yMin) * plotHeight;
  const svg = addSvgElement(card, "svg", { class: "chart-svg", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = yMin + (yMax - yMin) * tick / 4;
    const y = yAt(value);
    addSvgElement(svg, "line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "chart-gridline" });
    const label = addSvgElement(svg, "text", { x: margin.left - 8, y: y + 3, "text-anchor": "end", class: "chart-axis-label" });
    label.textContent = formatTick(value);
  }

  const span = points.at(-1).timestampMs - points[0].timestampMs;
  const xIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  for (const index of xIndices) {
    const x = xAt(index);
    addSvgElement(svg, "line", { x1: x, x2: x, y1: margin.top + plotHeight, y2: margin.top + plotHeight + 4, class: "chart-gridline" });
    const label = addSvgElement(svg, "text", { x, y: height - 10, "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle", class: "chart-x-label" });
    label.textContent = formatTimestamp(points[index].timestampMs, span);
  }

  if (Number.isFinite(eventTimestampMs) && points.length > 1
    && eventTimestampMs >= points[0].timestampMs && eventTimestampMs <= points.at(-1).timestampMs) {
    const x = margin.left + (eventTimestampMs - points[0].timestampMs) / (points.at(-1).timestampMs - points[0].timestampMs || 1) * plotWidth;
    const marker = addSvgElement(svg, "line", { x1: x, x2: x, y1: margin.top, y2: margin.top + plotHeight, class: "intervention-marker" });
    addSvgElement(marker, "title").textContent = `Intervention date: ${new Date(eventTimestampMs).toLocaleDateString(undefined, { timeZone: "UTC" })} UTC`;
  }

  for (const item of series) {
    let segment = [];
    const drawSegment = () => {
      if (!segment.length) return;
      if (segment.length > 1) addSvgElement(svg, "polyline", { points: segment.map(point => `${point.x},${point.y}`).join(" "), class: "chart-line", stroke: item.color });
      for (const point of segment) {
        const dot = addSvgElement(svg, "circle", { cx: point.x, cy: point.y, r: 3.3, class: "chart-point", fill: item.color });
        const tooltip = addSvgElement(dot, "title");
        tooltip.textContent = `${item.label}: ${String(point.value)} ${item.unit ?? ""} at ${formatUtcTimestamp(points[point.index].timestampMs)}`;
      }
      segment = [];
    };

    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        drawSegment();
        return;
      }
      segment.push({ x: xAt(index), y: yAt(value), value, index });
    });
    drawSegment();
  }

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  for (const item of series) {
    const entry = document.createElement("span");
    const mark = document.createElement("i");
    mark.style.setProperty("--series-color", item.color);
    const text = document.createElement("span");
    text.textContent = item.label;
    entry.append(mark, text);
    legend.append(entry);
  }
  card.append(legend);
  root.append(card);
}

function renderCharts(points) {
  chartsRoot.replaceChildren();
  const historical = historicalFloorActive();
  const chartSeries = [
    { title: "VET", note: "kWh/m³ · interval values", zeroBased: true, series: [
      { label: "VET", unit: "kWh/m³", color: "#38835a", values: points.map(point => point.VET) },
    ] },
    { title: "VET utilization", note: `% relative to ${utilizationReferenceText()} · values above 100% are permitted`, zeroBased: true, series: [
      { label: "η_VET", unit: "%", color: "#4d78a8", values: points.map(point => point.utilizationPercent) },
    ] },
    { title: "Pumped primary volume", note: "m³ per interval", zeroBased: true, series: [
      { label: "Pumped volume", unit: "m³", color: "#449799", values: points.map(point => point.pumpedVolumeM3) },
    ] },
    { title: "Sold heat energy", note: "MWh per interval", zeroBased: true, series: [
      { label: "Sold energy", unit: "MWh", color: "#8264a6", values: points.map(point => point.soldEnergyMWh) },
    ] },
    { title: historical ? "CAP and historical FLOOR reference" : "Available temperature bounds", note: historical ? "°C · measured supply CAP and empirical 10th-percentile FLOOR reference" : "°C · operator-selected practical T_cap and T_floor bounds", zeroBased: false, series: [
      { label: "T_cap", unit: "°C", color: "#c97856", values: points.map(point => point.TcapC) },
      { label: "T_floor", unit: "°C", color: "#8264a6", values: points.map(point => point.TfloorC) },
    ] },
  ];

  chartSeries.forEach(config => renderChart({ ...config, points }));
  const hasMeasuredTemperatures = points.some(point => point.supplyTemperatureC !== null || point.returnTemperatureC !== null);
  if (hasMeasuredTemperatures) {
    renderChart({
      title: "Measured network temperatures",
      note: "°C · diagnostic values, separate from T_cap and T_floor",
      points,
      zeroBased: false,
      series: [
        { label: "Supply", unit: "°C", color: "#38835a", values: points.map(point => point.supplyTemperatureC ?? NaN) },
        { label: "Return", unit: "°C", color: "#4d78a8", values: points.map(point => point.returnTemperatureC ?? NaN) },
      ],
    });
  }

  const spanLabel = historical ? "Reference temperature span" : "Available temperature span";
  const spanSeries = [{ label: spanLabel, unit: "K", color: "#bd8c42", values: points.map(point => point.availableDeltaK) }];
  if (points.some(point => point.measuredDeltaK !== null)) {
    spanSeries.push({ label: "Measured ΔT", unit: "K", color: "#4d78a8", values: points.map(point => point.measuredDeltaK ?? NaN) });
  }
  renderChart({
    title: historical ? "Measured ΔT and reference temperature span" : "Measured and available temperature span",
    note: historical
      ? "K · empirical FLOOR-based reference span; measured ΔT is diagnostic"
      : "K · measured ΔT is diagnostic; available ΔT uses T_cap − T_floor",
    points,
    zeroBased: false,
    series: spanSeries,
  });
}

let importedPoints = [];
let engineeringCurve = [];
let demoMode = false;
const csvFile = document.getElementById("csv-file");
const dropZone = document.getElementById("drop-zone");
const csvStatus = document.getElementById("csv-status");
const chartsRoot = document.getElementById("charts");
const importReport = document.getElementById("import-report");
const importCount = document.getElementById("import-count");
const globalErrors = document.getElementById("import-global-errors");
const rejectedList = document.getElementById("rejected-rows");
const rejectionDetails = document.getElementById("rejection-details");
const seriesEmpty = document.getElementById("series-empty");
const seriesResults = document.getElementById("series-results");
const compareForm = document.getElementById("compare-form");
const potentialMethod = document.getElementById("potential-method");
const methodStatus = document.getElementById("method-status");
const floorChartRoot = document.getElementById("floor-chart");

function renderFloorAnalysis(points, analysis) {
  const body = document.getElementById("floor-bin-rows");
  body.replaceChildren();
  for (const bin of analysis.bins) {
    const row = document.createElement("tr");
    const values = [
      `${numberFormat.format(bin.lowerC)} to ${numberFormat.format(bin.upperC)} °C`,
      String(bin.count),
      bin.supported ? `${numberFormat.format(bin.floorC)} °C` : "—",
      bin.supported ? `${numberFormat.format(bin.medianReturnC)} °C` : "—",
      bin.supported ? "Supported reference bin" : `Low-confidence / unsupported · needs ${Math.max(0, analysis.minimumObservations - bin.count)} more`,
    ];
    values.forEach(value => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  }
  floorChartRoot.replaceChildren();
  const observations = points.filter(point => Number.isFinite(point.outdoorTemperatureC) && Number.isFinite(point.returnTemperatureC));
  if (!observations.length) {
    floorChartRoot.textContent = "No historical return/outdoor-temperature observations are available for FLOOR identification.";
    return;
  }

  const values = observations.map(point => point.returnTemperatureC).concat(analysis.curve.flatMap(point => [point.floorC, point.medianReturnC]));
  const xValues = observations.map(point => point.outdoorTemperatureC);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin0 = Math.min(...values);
  const yMax0 = Math.max(...values);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax0 - yMin0 || 1;
  const width = 700;
  const height = 280;
  const margin = { top: 16, right: 14, bottom: 42, left: 54 };
  const x = value => margin.left + (value - (xMin - xSpan * .04)) / (xSpan * 1.08) * (width - margin.left - margin.right);
  const y = value => margin.top + (yMax0 + ySpan * .08 - value) / (ySpan * 1.16) * (height - margin.top - margin.bottom);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg floor-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Measured return temperature versus outdoor temperature, historical FLOOR percentile and median");
  const add = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
    svg.append(node);
    return node;
  };
  const yTop = margin.top;
  const yBottom = height - margin.bottom;
  add("line", { x1: margin.left, x2: width - margin.right, y1: yBottom, y2: yBottom, class: "chart-gridline" });
  add("line", { x1: margin.left, x2: margin.left, y1: yTop, y2: yBottom, class: "chart-gridline" });
  for (const [value, position] of [[yMin0, yBottom], [yMax0, yTop]]) {
    const tick = add("text", { x: margin.left - 7, y: position + 3, "text-anchor": "end", class: "chart-axis-label" });
    tick.textContent = formatTick(value);
  }
  for (const value of [...new Set([xMin, xMax])]) {
    const tick = add("text", { x: x(value), y: yBottom + 17, "text-anchor": value === xMin ? "start" : "end", class: "chart-axis-label" });
    tick.textContent = formatTick(value);
  }
  const xLabel = add("text", { x: width / 2, y: height - 8, "text-anchor": "middle", class: "chart-axis-label" });
  xLabel.textContent = "Outdoor temperature · °C";
  const yLabel = add("text", { x: 14, y: height / 2, transform: `rotate(-90 14 ${height / 2})`, "text-anchor": "middle", class: "chart-axis-label" });
  yLabel.textContent = "Return temperature · °C";

  for (const point of observations) {
    const dot = add("circle", { cx: x(point.outdoorTemperatureC), cy: y(point.returnTemperatureC), r: 3, class: "floor-observation" });
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
    tip.textContent = `${formatUtcTimestamp(point.timestampMs)}: outdoor ${point.outdoorTemperatureC} °C, return ${point.returnTemperatureC} °C`;
    dot.append(tip);
  }
  for (const [key, color] of [["medianReturnC", "#4d78a8"], ["floorC", "#bd8c42"]]) {
    if (analysis.curve.length > 1) {
      add("polyline", { points: analysis.curve.map(point => `${x(point.outdoorTemperatureC)},${y(point[key])}`).join(" "), class: "floor-line", stroke: color });
    }
    for (const point of analysis.curve) {
      const mark = add("circle", { cx: x(point.outdoorTemperatureC), cy: y(point[key]), r: 3.6, fill: color, class: "chart-point" });
      const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
      tip.textContent = `${key === "floorC" ? "10th-percentile FLOOR" : "Median return"}: ${point[key]} °C at ${point.outdoorTemperatureC} °C outdoor (${point.count} observations)`;
      mark.append(tip);
    }
  }
  floorChartRoot.append(svg);
  const legend = document.createElement("div");
  legend.className = "chart-legend floor-legend";
  for (const [label, color] of [["Historical observations", "#8d9b92"], ["10th-percentile FLOOR", "#bd8c42"], ["Median return", "#4d78a8"]]) {
    const entry = document.createElement("span");
    const mark = document.createElement("i");
    mark.style.setProperty("--series-color", color);
    entry.append(mark, document.createTextNode(label));
    legend.append(entry);
  }
  floorChartRoot.append(legend);
}

function getMethodOptions(floorCurve) {
  return {
    method: potentialMethod.value,
    floorCurve,
    engineeringCurve,
    manualTcapC: document.getElementById("manual-cap").value === "" ? null : document.getElementById("manual-cap").valueAsNumber,
    manualTfloorC: document.getElementById("manual-floor").value === "" ? null : document.getElementById("manual-floor").valueAsNumber,
  };
}

function updateMethodVisibility() {
  const method = potentialMethod.value;
  document.getElementById("floor-methodology").hidden = method !== "automatic";
  document.getElementById("engineering-controls").hidden = method !== "engineering";
  document.getElementById("manual-controls").hidden = method !== "manual";
  document.getElementById("floor-reference-label").hidden = method !== "automatic";
  document.getElementById("summary-delta-label").textContent = `Average ${referenceSpanLabel().toLowerCase()}`;
  document.getElementById("summary-util-label").textContent = method === "automatic"
    ? "Aggregate η_VET · historical reference utilization"
    : "Aggregate η_VET · practical potential utilization";
  document.getElementById("interval-span-heading").innerHTML = `${referenceSpanLabel()}<br>K`;
  document.getElementById("interval-potential-heading").innerHTML = `${referencePotentialLabel()}<br>kWh/m³`;
  document.getElementById("method-explanation").textContent = method === "automatic"
      ? "Automatic T_cap — measured supply at the same network boundary as pumped primary volume. Automatic T_floor — empirical 10th-percentile historical return reference by outdoor-temperature bin; this is a benchmark, not an absolute thermodynamic minimum. η_VET is relative to that historical reference and may exceed 100%."
    : method === "engineering"
      ? "T_floor comes from the imported engineering curve, then row T_floor_C values. T_cap uses an imported engineering curve when present, then row T_cap_C, then measured supply."
      : "Fixed T_cap and T_floor values are applied to every interval for scenario analysis.";
}

function refreshPotentialAnalysis(initializeRanges = false) {
  updateMethodVisibility();
  updateInterventionAvailability();
  const floorAnalysis = identifyFloorCurve(importedPoints);
  renderFloorAnalysis(importedPoints, floorAnalysis);
  document.getElementById("floor-reference-note").textContent = "Displayed FLOOR curve uses the full imported historical dataset.";
  if (!importedPoints.length) {
    methodStatus.textContent = "Import a dataset to calculate temperature potential.";
    methodStatus.classList.remove("method-warning");
    return;
  }
  const result = applyTemperatureMethod(importedPoints, getMethodOptions(floorAnalysis.curve));
  const status = [];
  if (potentialMethod.value === "automatic") {
    if (!importedPoints.some(point => Number.isFinite(point.outdoorTemperatureC))) status.push("Automatic FLOOR unavailable: CSV has no outdoor_temperature_C values.");
    else if (!importedPoints.some(point => Number.isFinite(point.returnTemperatureC))) status.push("Automatic FLOOR unavailable: CSV has no return_temperature_C values.");
    else if (!floorAnalysis.curve.length) status.push(`No supported FLOOR bins: ${floorAnalysis.observationCount} return/outdoor observations; each 2 °C bin needs at least ${floorAnalysis.minimumObservations}.`);
    const lowConfidenceBins = floorAnalysis.bins.filter(bin => !bin.supported).length;
    if (lowConfidenceBins) status.push(`${lowConfidenceBins} outdoor-temperature bins are low-confidence / unsupported; they do not define the historical FLOOR reference.`);
  }
  if (potentialMethod.value === "engineering" && !engineeringCurve.length) status.push("Import an engineering curve to calculate FLOOR.");
  if (result.missingCapCount) status.push(`${result.missingCapCount} intervals have no usable T_cap.`);
  if (result.missingFloorCount) status.push(`${result.missingFloorCount} intervals have no usable T_floor.`);
  if (result.invalidBoundsCount) status.push(`${result.invalidBoundsCount} intervals have T_floor ≥ T_cap.`);
  if (result.outsideFloorRangeCount) status.push(`${result.outsideFloorRangeCount} intervals use the nearest FLOOR value outside the calibrated outdoor-temperature range.`);
  methodStatus.textContent = status.join(" ") || `Temperature potential calculated for all ${importedPoints.length} intervals.`;
  methodStatus.classList.toggle("method-warning", status.length > 0);
  if (importedPoints.length) {
    renderSummary(result.points);
    if (initializeRanges) prepareComparisonRanges(importedPoints);
    seriesResults.hidden = false;
    seriesEmpty.hidden = true;
    if (!interventionResults.hidden) runInterventionAnalysis(new Event("submit", { cancelable: true }));
  }
}

function utcDateTime(timestampMs) {
  const date = new Date(timestampMs);
  const pad = value => String(value).padStart(2, "0");
  const milliseconds = date.getUTCMilliseconds();
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}`;
}

function prepareComparisonRanges(points) {
  const fields = ["baseline-start", "baseline-end", "comparison-start", "comparison-end"].map(id => document.getElementById(id));
  const start = utcDateTime(points[0].timestampMs);
  const end = utcDateTime(points.at(-1).timestampMs);
  fields.forEach(field => {
    field.min = start;
    field.max = end;
  });
  const baselineEndIndex = points.length > 1 ? Math.floor((points.length - 1) / 2) : 0;
  const comparisonStartIndex = points.length > 1 ? baselineEndIndex + 1 : 0;
  fields[0].value = start;
  fields[1].value = utcDateTime(points[baselineEndIndex].timestampMs);
  fields[2].value = utcDateTime(points[comparisonStartIndex].timestampMs);
  fields[3].value = end;
  document.getElementById("comparison-results").hidden = true;
  document.getElementById("compare-error").textContent = "";
}

function renderImportReport(result) {
  importReport.hidden = false;
  importCount.textContent = `${result.rowCount} data row${result.rowCount === 1 ? "" : "s"} read · ${result.acceptedRows.length} accepted · ${result.rejectedCount} rejected`;
  globalErrors.replaceChildren();
  for (const message of result.globalErrors) {
    const item = document.createElement("li");
    item.textContent = message;
    globalErrors.append(item);
  }
  globalErrors.hidden = result.globalErrors.length === 0;

  rejectedList.replaceChildren();
  for (const rejection of result.rejections) {
    const item = document.createElement("li");
    const rowLabel = rejection.rowNumber ? `Row ${rejection.rowNumber}` : "CSV";
    item.textContent = `${rowLabel}${rejection.timestamp ? ` · ${rejection.timestamp}` : ""}: ${rejection.reason}`;
    rejectedList.append(item);
  }
  rejectionDetails.hidden = result.rejections.length === 0;
  rejectionDetails.open = result.rejections.length > 0;
  document.getElementById("rejection-summary").textContent = `Rejected row details (${result.rejections.length})`;
}

function resetDataset() {
  demoMode = false;
  importedPoints = [];
  engineeringCurve = [];
  document.getElementById("engineering-curve-file").value = "";
  document.getElementById("engineering-curve-status").textContent = "No engineering curve loaded.";
  csvFile.value = "";
  csvStatus.textContent = "No file loaded. Import the example CSV to explore the analysis.";
  importReport.hidden = true;
  globalErrors.replaceChildren();
  rejectedList.replaceChildren();
  seriesResults.hidden = true;
  seriesEmpty.hidden = false;
  seriesEmpty.querySelector("strong").textContent = "Time-series analysis is ready";
  seriesEmpty.querySelector("p").textContent = "Import a CSV to see period totals, volume-weighted indicators, charts, interval calculations, and optional period comparison.";
  document.getElementById("remove-data").hidden = true;
  document.getElementById("clear-demo-data").hidden = true;
  document.getElementById("demo-notice").hidden = true;
  chartsRoot.replaceChildren();
  document.getElementById("interval-rows").replaceChildren();
  document.getElementById("compare-panel").open = false;
  document.getElementById("comparison-results").hidden = true;
  interventionResults.hidden = true;
  document.getElementById("intervention-charts").replaceChildren();
  renderFloorAnalysis([], identifyFloorCurve([]));
  methodStatus.textContent = "Import a dataset to calculate temperature potential.";
  updateMethodVisibility();
  updateInterventionAvailability();
  dropZone.classList.remove("drag-active");
}

function prefillDemoIntervention() {
  document.getElementById("intervention-name").value = "Synthetic return-side heat utilization example";
  document.getElementById("intervention-date").value = "2023-01-01";
  document.getElementById("intervention-type").selectedIndex = 0;
  document.getElementById("intervention-stabilization").value = "0";
  document.getElementById("intervention-baseline-start").value = "2022-01-01";
  document.getElementById("intervention-baseline-end").value = "2022-12-31";
  document.getElementById("intervention-after-start").value = "2023-01-01";
  document.getElementById("intervention-after-end").value = "2023-12-31";
  document.getElementById("intervention-floor-reference").value = "baseline";
}

async function importCsvContent(fileName, readText, isDemo = false) {
  importedPoints = [];
  demoMode = isDemo;
  seriesResults.hidden = true;
  seriesEmpty.hidden = true;
  importReport.hidden = true;
  document.getElementById("compare-panel").open = false;
  document.getElementById("comparison-results").hidden = true;
  csvStatus.textContent = `Reading ${fileName}…`;
  document.getElementById("remove-data").hidden = isDemo;
  document.getElementById("clear-demo-data").hidden = true;
  document.getElementById("demo-notice").hidden = true;
  document.getElementById("charts").replaceChildren();
  document.getElementById("interval-rows").replaceChildren();
  dropZone.classList.remove("drag-active");

  try {
    const result = parseVETCsv(await readText());
    importedPoints = result.acceptedRows;
    demoMode = isDemo;
    document.getElementById("clear-demo-data").hidden = !isDemo;
    document.getElementById("demo-notice").hidden = !isDemo;
    renderImportReport(result);
    csvStatus.textContent = `${fileName} · ${result.rowCount} rows read · ${result.acceptedRows.length} accepted · ${result.rejectedCount} rejected.`;
    if (importedPoints.length) {
      prepareInterventionRanges(importedPoints);
      if (isDemo) prefillDemoIntervention();
      refreshPotentialAnalysis(true);
    } else {
      seriesEmpty.hidden = false;
      seriesEmpty.querySelector("strong").textContent = "No valid intervals to analyze";
      seriesEmpty.querySelector("p").textContent = "Review the import report above, correct the CSV, and import it again.";
    }
  } catch (error) {
    seriesEmpty.hidden = false;
    seriesEmpty.querySelector("strong").textContent = "CSV could not be read";
    seriesEmpty.querySelector("p").textContent = error.message;
    renderImportReport({ rowCount: 0, acceptedRows: [], rejectedCount: 0, rejections: [], globalErrors: [error.message] });
    csvStatus.textContent = `${fileName} · 0 accepted · 0 rejected.`;
    if (isDemo) {
      demoMode = false;
      document.getElementById("clear-demo-data").hidden = true;
      document.getElementById("demo-notice").hidden = true;
    }
  }
}

function importFile(file) {
  if (!file) return;
  return importCsvContent(file.name, () => file.text());
}

function loadDemoData() {
  const demoUrl = new URL("./sample-vet-data.csv", import.meta.url);
  return importCsvContent("sample-vet-data.csv", async () => {
    const response = await fetch(demoUrl, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Demo CSV request failed (${response.status}).`);
    return response.text();
  }, true);
}

function clearDemoData() {
  if (!demoMode) return;
  resetDataset();
  potentialMethod.value = "automatic";
  document.getElementById("manual-cap").value = "";
  document.getElementById("manual-floor").value = "";
  document.getElementById("intervention-name").value = "";
  document.getElementById("intervention-type").selectedIndex = 0;
  document.getElementById("intervention-date").value = "";
  document.getElementById("intervention-stabilization").value = "0";
  document.getElementById("intervention-notes").value = "";
  for (const id of ["intervention-baseline-start", "intervention-baseline-end", "intervention-after-start", "intervention-after-end"]) {
    document.getElementById(id).value = "";
  }
  for (const id of ["baseline-start", "baseline-end", "comparison-start", "comparison-end"]) {
    document.getElementById(id).value = "";
  }
  document.getElementById("intervention-floor-reference").value = "baseline";
  document.getElementById("floor-development-outdoor").value = "-10";
  updateMethodVisibility();
}

document.getElementById("load-demo-data").addEventListener("click", loadDemoData);
document.getElementById("clear-demo-data").addEventListener("click", clearDemoData);

csvFile.addEventListener("change", () => importFile(csvFile.files?.[0]));
dropZone.addEventListener("dragover", event => {
  event.preventDefault();
  dropZone.classList.add("drag-active");
});
dropZone.addEventListener("dragleave", event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-active");
});
dropZone.addEventListener("drop", event => {
  event.preventDefault();
  importFile(event.dataTransfer.files?.[0]);
});
document.getElementById("remove-data").addEventListener("click", resetDataset);
potentialMethod.addEventListener("change", () => refreshPotentialAnalysis());
document.getElementById("manual-cap").addEventListener("input", () => refreshPotentialAnalysis());
document.getElementById("manual-floor").addEventListener("input", () => refreshPotentialAnalysis());
document.getElementById("engineering-curve-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    engineeringCurve = parseEngineeringCurveCsv(await file.text());
    document.getElementById("engineering-curve-status").textContent = `${file.name} · ${engineeringCurve.length} curve points loaded.`;
  } catch (error) {
    engineeringCurve = [];
    document.getElementById("engineering-curve-status").textContent = error.message;
  }
  refreshPotentialAnalysis();
});
updateMethodVisibility();

function periodForRange(points, startField, endField) {
  const start = parseTimestampMs(startField.value);
  const end = parseTimestampMs(endField.value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Enter valid start and end timestamps for both periods.");
  if (start > end) throw new Error("Each period start must be before or equal to its end.");
  const selected = points.filter(point => point.timestampMs >= start && point.timestampMs <= end);
  if (!selected.length) throw new Error("Each selected period must include at least one accepted CSV row.");
  return { points: selected, start, end, durationDays: (end - start) / 86400000 };
}

function comparisonSummary(metrics, baseline, comparison) {
  const byLabel = Object.fromEntries(metrics.map(metric => [metric.label, metric]));
  const describe = (label, display, temperature = false) => {
    const metric = byLabel[label];
    if (!metric || metric.absolute === null || metric.absolute === 0) return null;
    const direction = metric.absolute > 0 ? "increased" : "decreased";
    const magnitude = metric.relative === null
      ? `${numberFormat.format(Math.abs(metric.absolute))} ${temperature ? "K" : metric.deltaUnit}`
      : `${percentFormat.format(Math.abs(metric.relative))}%`;
    return `${display} ${direction} by ${magnitude}`;
  };
  const changes = [
    describe("VET", "VET"),
    describe("Pumped primary volume", "pumped primary-water volume"),
    describe("Measured return temperature", "volume-weighted return temperature", true),
    describe("Measured ΔT", "measured ΔT", true),
  ].filter(Boolean);
  const eta = byLabel["η_VET"];
  if (eta && eta.before !== null && eta.after !== null && eta.absolute !== null && eta.absolute !== 0) {
    changes.push(`utilization relative to the ${historicalFloorActive() ? "historical temperature-potential reference" : "selected practical temperature potential"} ${eta.absolute > 0 ? "increased" : "decreased"} from ${percentFormat.format(eta.before)}% to ${percentFormat.format(eta.after)}%, a change of ${signedFormat.format(eta.absolute)} percentage points`);
  }
  const summary = document.getElementById("comparison-summary");
  summary.textContent = changes.length
    ? `Compared with the baseline period, ${changes.join("; ")}. These are calculated differences only; no causal interpretation or performance rating is applied.`
    : "The selected periods have no change in the reported comparable indicators.";
}

function renderComparison(baseline, comparison, referenceText) {
  const metrics = calculatePeriodChanges(baseline.summary, comparison.summary);
  const body = document.getElementById("comparison-rows");
  const fragment = document.createDocumentFragment();
  for (const metric of metrics) {
    const row = document.createElement("tr");
    const values = [
      metric.label === "Available temperature span" ? referenceSpanLabel() : metric.label,
      metric.before === null ? "—" : `${numberFormat.format(metric.before)} ${metric.unit}`,
      metric.after === null ? "—" : `${numberFormat.format(metric.after)} ${metric.unit}`,
      metric.absolute === null ? "—" : `${signedFormat.format(metric.absolute)} ${metric.deltaUnit}`,
      metric.relative === null ? "—" : `${signedFormat.format(metric.relative)}%`,
    ];
    values.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = value;
      row.append(cell);
    });
    fragment.append(row);
  }
  body.replaceChildren(fragment);
  const outdoor = (value) => value === null ? "not available" : `${numberFormat.format(value)} °C`;
  document.getElementById("comparison-context").textContent = `Baseline: ${numberFormat.format(baseline.durationDays)} days · ${baseline.points.length} accepted intervals · η_VET bounds valid for ${baseline.summary.potentialIntervalCount}/${baseline.points.length} intervals · ${numberFormat.format(baseline.summary.totalSoldEnergyMWh)} MWh sold · time-weighted average outdoor temperature ${outdoor(baseline.summary.timeWeightedOutdoorTemperatureC)}. Comparison: ${numberFormat.format(comparison.durationDays)} days · ${comparison.points.length} accepted intervals · η_VET bounds valid for ${comparison.summary.potentialIntervalCount}/${comparison.points.length} intervals · ${numberFormat.format(comparison.summary.totalSoldEnergyMWh)} MWh sold · time-weighted average outdoor temperature ${outdoor(comparison.summary.timeWeightedOutdoorTemperatureC)}. Duration spans selected timestamps. Different energy, duration, or weather conditions affect direct comparability; no weather correction is applied.`;
  document.getElementById("comparison-floor-reference").textContent = referenceText;
  comparisonSummary(metrics, baseline, comparison);
  document.getElementById("comparison-results").hidden = false;
}

compareForm.addEventListener("submit", event => {
  event.preventDefault();
  const error = document.getElementById("compare-error");
  error.textContent = "";
  try {
    const baselineRange = periodForRange(importedPoints, document.getElementById("baseline-start"), document.getElementById("baseline-end"));
    const comparisonRange = periodForRange(importedPoints, document.getElementById("comparison-start"), document.getElementById("comparison-end"));
    const comparisonAnalysis = comparePeriods(importedPoints, {
      baselineStartMs: baselineRange.start,
      baselineEndMs: baselineRange.end,
      comparisonStartMs: comparisonRange.start,
      comparisonEndMs: comparisonRange.end,
      floorReference: document.getElementById("floor-reference").value,
      temperatureMethod: getMethodOptions([]),
    });
    let referenceText = "FLOOR reference is not used by the selected potential method.";
    if (potentialMethod.value === "automatic") {
      const referencePoints = document.getElementById("floor-reference").value === "baseline" ? baselineRange.points : importedPoints;
      const floorAnalysis = comparisonAnalysis.floorAnalysis;
      renderFloorAnalysis(referencePoints, floorAnalysis);
      document.getElementById("floor-reference-note").textContent = document.getElementById("floor-reference").value === "baseline"
        ? `Displayed FLOOR curve calibrated from the baseline period (${referencePoints.length} selected rows; ${floorAnalysis.observationCount} return/outdoor observations).`
        : `Displayed FLOOR curve calibrated from the full historical dataset (${referencePoints.length} selected rows; ${floorAnalysis.observationCount} return/outdoor observations).`;
      referenceText = document.getElementById("floor-reference").value === "baseline"
        ? `Frozen FLOOR curve calibrated from baseline period (${baselineRange.points.length} rows selected; ${floorAnalysis.observationCount} return/outdoor observations; ${comparisonAnalysis.floorCurve.length} supported bins). The same curve was applied to both periods.`
        : `Frozen FLOOR curve calibrated from the full historical dataset (${importedPoints.length} rows selected; ${floorAnalysis.observationCount} return/outdoor observations; ${comparisonAnalysis.floorCurve.length} supported bins). The same curve was applied to both periods.`;
    }
    const derived = comparisonAnalysis.calculatedPoints;
    if (potentialMethod.value === "automatic") {
      renderSummary(derived);
      const outsideCount = derived.filter(point => point.floorOutsideRange).length;
      const unavailableCount = derived.filter(point => !Number.isFinite(point.maximumPotentialKWhM3)).length;
      methodStatus.textContent = `Automatic T_cap uses measured supply. One frozen FLOOR curve from the selected reference is used for the full-series summary and both comparison periods.${unavailableCount ? ` Temperature potential is unavailable for ${unavailableCount} intervals.` : ""}${outsideCount ? ` ${outsideCount} intervals are outside its calibrated outdoor-temperature range and use the nearest supported value.` : ""}`;
      methodStatus.classList.toggle("method-warning", unavailableCount > 0 || outsideCount > 0);
    }
    renderComparison(comparisonAnalysis.baseline, comparisonAnalysis.comparison, referenceText);
  } catch (reason) {
    document.getElementById("comparison-results").hidden = true;
    error.textContent = reason.message;
  }
});

const interventionForm = document.getElementById("intervention-form");
const interventionResults = document.getElementById("intervention-results");
const interventionCharts = document.getElementById("intervention-charts");

function calendarDayCount(startMs, endMs) {
  const start = calendarDateValue(startMs).split("-").map(Number);
  const end = calendarDateValue(endMs).split("-").map(Number);
  return Math.round((Date.UTC(end[0], end[1] - 1, end[2]) - Date.UTC(start[0], start[1] - 1, start[2])) / 86400000) + 1;
}

function interventionDateRange(startField, endField) {
  if (!startField.value || !endField.value) throw new RangeError("Choose dates for both intervention comparison periods.");
  const start = parseCalendarDateMs(startField.value);
  const end = parseCalendarDateMs(endField.value, true);
  if (start > end) throw new RangeError("Each period start must be before or equal to its end.");
  const points = importedPoints.filter(point => point.timestampMs >= start && point.timestampMs <= end);
  if (!points.length) throw new RangeError("Each selected period must include at least one accepted CSV row.");
  return { start, end, points, durationDays: (end - start + 1) / 86400000 };
}

function prepareInterventionRanges(points) {
  const first = calendarDateValue(points[0].timestampMs);
  const last = calendarDateValue(points.at(-1).timestampMs);
  const datesByYear = new Map();
  for (const point of points) {
    const date = calendarDateValue(point.timestampMs);
    const year = Number(date.slice(0, 4));
    const range = datesByYear.get(year) ?? { first: date, last: date };
    range.first = date < range.first ? date : range.first;
    range.last = date > range.last ? date : range.last;
    datesByYear.set(year, range);
  }
  const completeYears = [...datesByYear.entries()]
    .filter(([year, range]) => range.first <= `${year}-01-02` && range.last >= `${year}-12-30`)
    .map(([year]) => year)
    .sort((a, b) => a - b);
  const completePair = completeYears.filter(year => completeYears.includes(year + 1)).at(-1);
  let eventDate;
  let baselineStart;
  let baselineEnd;
  let afterStart;
  let afterEnd;
  if (completePair !== undefined) {
    // Default to equivalent full calendar years, with the intervention at their boundary.
    eventDate = `${completePair + 1}-01-01`;
    baselineStart = `${completePair}-01-01`;
    baselineEnd = `${completePair}-12-31`;
    afterStart = eventDate;
    afterEnd = `${completePair + 1}-12-31`;
  } else {
    eventDate = calendarDateValue(points[Math.floor((points.length - 1) / 2)].timestampMs);
    const eventMs = parseCalendarDateMs(eventDate);
    const previous = calendarDateValue(eventMs - 86400000);
    const next = calendarDateValue(eventMs + 86400000);
    baselineStart = first;
    baselineEnd = previous < first ? first : previous;
    afterStart = next > last ? last : next;
    afterEnd = last;
  }
  document.getElementById("intervention-date").min = first;
  document.getElementById("intervention-date").max = last;
  document.getElementById("intervention-date").value = eventDate;
  document.getElementById("intervention-baseline-start").min = first;
  document.getElementById("intervention-baseline-start").max = last;
  document.getElementById("intervention-baseline-start").value = baselineStart;
  document.getElementById("intervention-baseline-end").min = first;
  document.getElementById("intervention-baseline-end").max = last;
  document.getElementById("intervention-baseline-end").value = baselineEnd;
  document.getElementById("intervention-after-start").min = first;
  document.getElementById("intervention-after-start").max = last;
  document.getElementById("intervention-after-start").value = afterStart;
  document.getElementById("intervention-after-end").min = first;
  document.getElementById("intervention-after-end").max = last;
  document.getElementById("intervention-after-end").value = afterEnd;
  interventionResults.hidden = true;
  document.getElementById("intervention-error").textContent = "";
}

function interventionMethodOptions() {
  return getMethodOptions([]);
}

function updateInterventionAvailability() {
  const empty = document.getElementById("intervention-empty");
  const workspace = document.getElementById("intervention-workspace");
  empty.hidden = importedPoints.length > 0;
  workspace.hidden = importedPoints.length === 0;
  if (!importedPoints.length) {
    interventionResults.hidden = true;
    return;
  }
  const method = potentialMethod.value;
  document.getElementById("intervention-floor-reference-label").hidden = method !== "automatic";
  document.getElementById("intervention-method-note").textContent = method === "automatic"
    ? "Temperature method: Automatic / Historical — T_cap uses measured supply; empirical FLOOR is calibrated once from the selected reference and frozen for both periods. η_VET is relative to that historical reference and may exceed 100%; that means measured VET is above the empirical reference, not a physical maximum."
    : method === "engineering"
      ? "Temperature method: Engineering curve — the currently selected curve and fallback CAP/FLOOR values from Time series are used for both periods."
      : "Temperature method: Manual / Scenario — the fixed CAP/FLOOR values entered in Time series are used for both periods.";
}

function interventionSummary(metrics, type) {
  const find = label => metrics.find(metric => metric.label === label);
  const describeChange = (metric, label, unit = metric?.deltaUnit) => {
    if (!metric || metric.absolute === null || metric.absolute === 0) return null;
    return `${label} ${metric.absolute > 0 ? "increased" : "decreased"} by ${numberFormat.format(Math.abs(metric.absolute))} ${unit}${metric.relative === null ? "" : ` (${signedFormat.format(metric.relative)}%)`}`;
  };
  const vet = describeChange(find("VET"), "VET");
  const volume = describeChange(find("Pumped primary volume"), "pumped primary-water volume", "m³");
  const energy = describeChange(find("Sold energy"), "sold energy", "MWh");
  const supply = describeChange(find("Measured supply temperature"), "volume-weighted measured supply temperature", "K");
  const returned = describeChange(find("Measured return temperature"), "volume-weighted measured return temperature", "K");
  const measuredDelta = describeChange(find("Measured ΔT"), "volume-weighted measured ΔT", "K");
  const eta = find("η_VET");
  const potentialReference = historicalFloorActive() ? "the frozen historical temperature-potential reference" : "the selected practical temperature potential";
  const etaText = eta?.absolute !== null && eta?.absolute !== undefined && eta.absolute !== 0
    ? `VET utilization relative to ${potentialReference} changed from ${percentFormat.format(eta.before)}% to ${percentFormat.format(eta.after)}% (${signedFormat.format(eta.absolute)} percentage points).`
    : "VET utilization did not change between the selected periods.";
  const measured = [supply, returned, measuredDelta].filter(Boolean).join("; ");
  const calculated = [vet, volume, energy].filter(Boolean).join("; ");
  const typeNote = type.startsWith("Three-pipe · decentralized heat producer")
    ? "For decentralized heat injection, only heat reflected in sold energy relative to pumped primary volume contributes to VET; a return-temperature change alone is not credited as improved VET."
    : "VET describes sold heat per pumped primary volume; measured return temperature by itself is not a performance rating.";
  return `Measured change: ${measured || "no change in the available measured temperature indicators"}. Calculated change: ${calculated || "no change in VET, energy, or volume"}. ${etaText} Interpretation: ${typeNote} These before/after differences do not establish that the intervention caused them.`;
}

function renderInterventionMetrics(baseline, comparison) {
  const metrics = calculatePeriodChanges(baseline.summary, comparison.summary);
  const body = document.getElementById("intervention-metric-rows");
  const shown = new Set(["VET", "η_VET", "Pumped primary volume", "Sold energy", "Measured supply temperature", "Measured return temperature", "Measured ΔT", "Available temperature span", "Time-weighted average outdoor temperature"]);
  body.replaceChildren();
  for (const metric of metrics.filter(item => shown.has(item.label))) {
    const row = document.createElement("tr");
    const entries = [
      metric.label === "Available temperature span" ? referenceSpanLabel() : metric.label,
      metric.before === null ? "—" : `${numberFormat.format(metric.before)} ${metric.unit}`,
      metric.after === null ? "—" : `${numberFormat.format(metric.after)} ${metric.unit}`,
      metric.absolute === null ? "—" : `${signedFormat.format(metric.absolute)} ${metric.deltaUnit}`,
      metric.relative === null ? "—" : `${signedFormat.format(metric.relative)}%`,
    ];
    entries.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = value;
      row.append(cell);
    });
    body.append(row);
  }
  return metrics;
}

function renderInterventionCharts(baselinePoints, afterPoints, eventTimestampMs) {
  interventionCharts.replaceChildren();
  const baselineSet = new Set(baselinePoints);
  const afterSet = new Set(afterPoints);
  const points = [...baselinePoints, ...afterPoints].sort((a, b) => a.timestampMs - b.timestampMs);
  const historical = historicalFloorActive();
  const configs = [
    { title: "VET", note: "kWh/m³ · interval values", key: point => point.VET, unit: "kWh/m³", zeroBased: true },
    { title: "VET utilization", note: `% relative to ${utilizationReferenceText()} · values above 100% are permitted`, key: point => point.utilizationPercent, unit: "%", zeroBased: true },
    { title: "Pumped primary volume", note: "m³ per interval", key: point => point.pumpedVolumeM3, unit: "m³", zeroBased: true },
    { title: "Sold heat energy", note: "MWh per interval", key: point => point.soldEnergyMWh, unit: "MWh", zeroBased: true },
    { title: "Measured supply temperature", note: "°C · measured operating data", key: point => point.supplyTemperatureC, unit: "°C", zeroBased: false },
    { title: "Measured return temperature", note: "°C · measured operating data", key: point => point.returnTemperatureC, unit: "°C", zeroBased: false },
    { title: "Measured ΔT", note: "K · measured supply minus measured return", key: point => point.measuredDeltaK, unit: "K", zeroBased: false },
    { title: referenceSpanLabel(), note: historical ? "K · empirical historical FLOOR reference span" : "K · T_cap − T_floor using selected practical bounds", key: point => point.availableDeltaK, unit: "K", zeroBased: false },
    { title: "Outdoor temperature", note: "°C · measured outdoor conditions", key: point => point.outdoorTemperatureC, unit: "°C", zeroBased: false },
  ];
  for (const config of configs) {
    if ((config.title.startsWith("Measured") && !points.some(point => Number.isFinite(config.key(point))))
      || (config.title === "Outdoor temperature" && !points.some(point => Number.isFinite(point.outdoorTemperatureC)))) continue;
    const phaseSeries = (label, color, set) => ({
      label,
      unit: config.unit,
      color,
      values: points.map(point => set.has(point) ? config.key(point) ?? NaN : NaN),
    });
    renderChart({
      title: config.title,
      note: config.note,
      points,
      zeroBased: config.zeroBased,
      root: interventionCharts,
      eventTimestampMs,
      series: [
        phaseSeries("Baseline", "#4d78a8", baselineSet),
        phaseSeries("After intervention", "#8264a6", afterSet),
      ],
    });
  }
}

function renderFloorDevelopment(analysis, outdoorTemperatureC) {
  const output = document.getElementById("floor-development-result");
  const details = document.getElementById("post-floor-development");
  details.hidden = potentialMethod.value !== "automatic";
  if (details.hidden) return;
  const fillBins = (id, floorAnalysis) => {
    const body = document.getElementById(id);
    body.replaceChildren();
    for (const bin of floorAnalysis?.bins ?? []) {
      const row = document.createElement("tr");
      const cells = [
        `${numberFormat.format(bin.lowerC)} to ${numberFormat.format(bin.upperC)} °C`,
        String(bin.count),
        bin.supported ? `${numberFormat.format(bin.floorC)} °C` : "—",
      bin.supported ? "Supported reference bin" : `Low-confidence / unsupported · needs ${Math.max(0, floorAnalysis.minimumObservations - bin.count)} more`,
      ];
      for (const value of cells) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  };
  fillBins("intervention-reference-bins", analysis.floorAnalysis);
  fillBins("intervention-post-bins", analysis.postFloorAnalysis);
  if (!Number.isFinite(outdoorTemperatureC)) {
    output.textContent = "Enter a finite outdoor temperature to compare the baseline and post-intervention FLOOR curves.";
    return;
  }
  const baselineFloor = interpolateCurve(analysis.floorCurve, outdoorTemperatureC);
  const postCurve = analysis.postFloorAnalysis?.curve ?? [];
  const postFloor = interpolateCurve(postCurve, outdoorTemperatureC);
  if (baselineFloor.value === null || postFloor.value === null) {
    output.textContent = `A supported historical FLOOR cannot be compared at ${numberFormat.format(outdoorTemperatureC)} °C. Baseline curve: ${analysis.floorCurve.length} supported bins; post-intervention curve: ${postCurve.length} supported bins. Each 2 °C bin requires at least ${analysis.postFloorAnalysis?.minimumObservations ?? 20} observations.`;
    return;
  }
  const shift = postFloor.value - baselineFloor.value;
  output.textContent = `At ${numberFormat.format(outdoorTemperatureC)} °C outdoor: baseline reference FLOOR ${numberFormat.format(baselineFloor.value)} °C; post-intervention observed FLOOR ${numberFormat.format(postFloor.value)} °C; observed shift ${signedFormat.format(shift)} K. ${baselineFloor.outsideRange || postFloor.outsideRange ? "At least one value uses the nearest supported FLOOR outside its calibrated outdoor-temperature range." : "Both values are within their supported outdoor-temperature ranges."} The post-intervention curve is a separate observed operational benchmark and was not used to calculate the formal η_VET comparison.`;
}

function runInterventionAnalysis(event) {
  event.preventDefault();
  const error = document.getElementById("intervention-error");
  error.textContent = "";
  interventionResults.hidden = true;
  try {
    const eventDate = document.getElementById("intervention-date").value;
    if (!eventDate) throw new RangeError("Enter the intervention date.");
    const stabilizationValue = document.getElementById("intervention-stabilization").value;
    if (stabilizationValue === "") throw new RangeError("Enter a whole-number stabilization period of zero or more days.");
    const stabilizationDays = Number(stabilizationValue);
    const baseline = interventionDateRange(document.getElementById("intervention-baseline-start"), document.getElementById("intervention-baseline-end"));
    const after = interventionDateRange(document.getElementById("intervention-after-start"), document.getElementById("intervention-after-end"));
    const analysis = analyzeIntervention(importedPoints, {
      interventionDateMs: parseCalendarDateMs(eventDate),
      stabilizationDays,
      baselineStartMs: baseline.start,
      baselineEndMs: baseline.end,
      comparisonStartMs: after.start,
      comparisonEndMs: after.end,
      floorReference: document.getElementById("intervention-floor-reference").value,
      temperatureMethod: interventionMethodOptions(),
    });
    analysis.baseline.durationDays = calendarDayCount(baseline.start, Math.min(baseline.end, analysis.excludedStartMs - 1));
    analysis.comparison.durationDays = calendarDayCount(Math.max(after.start, analysis.excludedEndMs + 1), after.end);
    const name = document.getElementById("intervention-name").value.trim();
    const type = document.getElementById("intervention-type").value;
    document.getElementById("intervention-result-title").textContent = name || type;
    const b = analysis.baseline;
    const a = analysis.comparison;
    document.getElementById("intervention-period-count").textContent = `${b.points.length} baseline · ${a.points.length} after intervals`;
    const floorText = potentialMethod.value === "automatic"
      ? document.getElementById("intervention-floor-reference").value === "baseline"
        ? `FLOOR reference: Baseline period — ${analysis.floorAnalysis.observationCount} return/outdoor observations; ${analysis.floorCurve.length} supported bins. The same frozen curve was applied to baseline and after-intervention periods.`
        : `FLOOR reference: Full historical dataset — ${analysis.floorAnalysis.observationCount} return/outdoor observations; ${analysis.floorCurve.length} supported bins. The same frozen curve was applied to baseline and after-intervention periods.`
      : `FLOOR reference: ${potentialMethod.value === "engineering" ? "Engineering curve" : "Manual / Scenario values"}; identical settings were applied to both periods.`;
    document.getElementById("intervention-floor-result").textContent = floorText;
    const outdoor = value => value === null ? "not available" : `${numberFormat.format(value)} °C`;
    const exclusion = `${calendarDateValue(analysis.excludedStartMs)} to ${calendarDateValue(analysis.excludedEndMs)}`;
    document.getElementById("intervention-context").textContent = `Intervention date: ${eventDate} UTC. Stabilization/exclusion: ${stabilizationDays} day${stabilizationDays === 1 ? "" : "s"} on each side, ${exclusion} UTC dates excluded. Baseline: ${numberFormat.format(b.durationDays)} calendar days · ${b.points.length} accepted intervals · ${numberFormat.format(b.summary.totalSoldEnergyMWh)} MWh sold · time-weighted average outdoor temperature ${outdoor(b.summary.timeWeightedOutdoorTemperatureC)}. After: ${numberFormat.format(a.durationDays)} calendar days · ${a.points.length} accepted intervals · ${numberFormat.format(a.summary.totalSoldEnergyMWh)} MWh sold · time-weighted average outdoor temperature ${outdoor(a.summary.timeWeightedOutdoorTemperatureC)}. Different period duration, delivered energy, and weather conditions affect direct comparability; no weather correction is applied.${document.getElementById("intervention-notes").value.trim() ? ` Notes: ${document.getElementById("intervention-notes").value.trim()}` : ""}`;
    const metrics = renderInterventionMetrics(b, a);
    document.getElementById("intervention-summary").textContent = interventionSummary(metrics, type);
    const outdoorInput = document.getElementById("floor-development-outdoor");
    renderFloorDevelopment(analysis, outdoorInput.value === "" ? NaN : outdoorInput.valueAsNumber);
    renderInterventionCharts(b.points, a.points, parseCalendarDateMs(eventDate));
    interventionResults.hidden = false;
  } catch (reason) {
    error.textContent = reason.message;
  }
}

interventionForm.addEventListener("submit", runInterventionAnalysis);
document.getElementById("floor-development-outdoor").addEventListener("input", () => {
  if (!interventionResults.hidden) runInterventionAnalysis(new Event("submit", { cancelable: true }));
});
potentialMethod.addEventListener("change", updateInterventionAvailability);
