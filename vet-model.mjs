export const WATER_KWH_PER_M3_K = 1.163;
export const FLOOR_BIN_WIDTH_C = 2;
export const FLOOR_PERCENTILE = 10;
export const FLOOR_MIN_OBSERVATIONS = 20;

// VET uses period energy and volume; potential uses the available temperature span.
export function calculateVET({
  soldEnergyMWh,
  pumpedVolumeM3,
  TcapC,
  TfloorC,
  supplyTemperatureC = null,
  returnTemperatureC = null,
}) {
  const required = { soldEnergyMWh, pumpedVolumeM3, TcapC, TfloorC };
  for (const [name, value] of Object.entries(required)) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number.`);
  }
  if (soldEnergyMWh < 0) throw new RangeError("Sold energy cannot be negative.");
  if (pumpedVolumeM3 <= 0) throw new RangeError("Pumped volume must be greater than zero.");
  if (TfloorC >= TcapC) throw new RangeError("T_floor must be lower than T_cap.");

  const optionalTemperature = (value, name) => {
    if (value === null || value === undefined || value === "") return null;
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number when provided.`);
    return value;
  };
  supplyTemperatureC = optionalTemperature(supplyTemperatureC, "Supply temperature");
  returnTemperatureC = optionalTemperature(returnTemperatureC, "Return temperature");

  const VET = soldEnergyMWh * 1000 / pumpedVolumeM3;
  const availableDeltaK = TcapC - TfloorC;
  const maximumPotentialKWhM3 = WATER_KWH_PER_M3_K * availableDeltaK;
  const utilization = VET / maximumPotentialKWhM3;
  const measuredDeltaK = supplyTemperatureC === null || returnTemperatureC === null
    ? null
    : supplyTemperatureC - returnTemperatureC;

  if (![VET, availableDeltaK, maximumPotentialKWhM3, utilization, utilization * 100].every(Number.isFinite)
    || (measuredDeltaK !== null && !Number.isFinite(measuredDeltaK))) {
    throw new RangeError("The entered values are outside the calculable range.");
  }

  return {
    VET,
    availableDeltaK,
    maximumPotentialKWhM3,
    utilization,
    utilizationPercent: utilization * 100,
    measuredDeltaK,
    soldEnergyMWh,
    pumpedVolumeM3,
    TcapC,
    TfloorC,
    supplyTemperatureC,
    returnTemperatureC,
  };
}

function percentile(values, percent) {
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * percent / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

// Bin return observations by outdoor temperature; only sufficiently populated bins define the operational reference curve.
export function identifyFloorCurve(points, {
  binWidthC = FLOOR_BIN_WIDTH_C,
  percentile: percentileValue = FLOOR_PERCENTILE,
  minimumObservations = FLOOR_MIN_OBSERVATIONS,
} = {}) {
  const grouped = new Map();
  for (const point of points) {
    if (!Number.isFinite(point.outdoorTemperatureC) || !Number.isFinite(point.returnTemperatureC)) continue;
    const lowerC = Math.floor(point.outdoorTemperatureC / binWidthC) * binWidthC;
    const bin = grouped.get(lowerC) ?? { lowerC, returns: [] };
    bin.returns.push(point.returnTemperatureC);
    grouped.set(lowerC, bin);
  }
  const bins = [...grouped.values()].sort((a, b) => a.lowerC - b.lowerC).map(bin => ({
    lowerC: bin.lowerC,
    upperC: bin.lowerC + binWidthC,
    centerC: bin.lowerC + binWidthC / 2,
    count: bin.returns.length,
    supported: bin.returns.length >= minimumObservations,
    floorC: bin.returns.length >= minimumObservations ? percentile(bin.returns, percentileValue) : null,
    medianReturnC: bin.returns.length >= minimumObservations ? percentile(bin.returns, 50) : null,
  }));
  return {
    binWidthC,
    percentile: percentileValue,
    minimumObservations,
    observationCount: bins.reduce((sum, bin) => sum + bin.count, 0),
    bins,
    curve: bins.filter(bin => bin.supported).map(({ centerC, floorC, medianReturnC, count }) => ({
      outdoorTemperatureC: centerC, floorC, medianReturnC, count,
    })),
  };
}

// Interpolate supported points and clamp beyond the calibrated range, flagging the clamp for operators.
export function interpolateCurve(curve, outdoorTemperatureC, key = "floorC") {
  if (!curve?.length || !Number.isFinite(outdoorTemperatureC)) return { value: null, outsideRange: false };
  const first = curve[0];
  const last = curve.at(-1);
  if (outdoorTemperatureC <= first.outdoorTemperatureC) {
    return { value: first[key], outsideRange: outdoorTemperatureC < first.outdoorTemperatureC };
  }
  if (outdoorTemperatureC >= last.outdoorTemperatureC) {
    return { value: last[key], outsideRange: outdoorTemperatureC > last.outdoorTemperatureC };
  }
  for (let index = 1; index < curve.length; index += 1) {
    const right = curve[index];
    if (outdoorTemperatureC > right.outdoorTemperatureC) continue;
    const left = curve[index - 1];
    const fraction = (outdoorTemperatureC - left.outdoorTemperatureC) / (right.outdoorTemperatureC - left.outdoorTemperatureC);
    return { value: left[key] + (right[key] - left[key]) * fraction, outsideRange: false };
  }
  return { value: last[key], outsideRange: true };
}

// VET is retained even when a temperature method cannot supply η_VET bounds.
export function applyTemperatureMethod(points, {
  method = "automatic",
  floorCurve = [],
  engineeringCurve = [],
  manualTcapC = null,
  manualTfloorC = null,
} = {}) {
  let missingCapCount = 0;
  let missingFloorCount = 0;
  let invalidBoundsCount = 0;
  let outsideFloorRangeCount = 0;
  const calculatedPoints = points.map(point => {
    let cap = null;
    let floor = null;
    let floorOutside = false;
    if (method === "automatic") {
      cap = point.supplyTemperatureC;
      const estimated = interpolateCurve(floorCurve, point.outdoorTemperatureC);
      floor = estimated.value;
      floorOutside = estimated.outsideRange;
    } else if (method === "engineering") {
      const estimatedFloor = interpolateCurve(engineeringCurve, point.outdoorTemperatureC, "TfloorC");
      floor = estimatedFloor.value ?? point.TfloorC;
      floorOutside = estimatedFloor.outsideRange;
      const engineeringCap = interpolateCurve(engineeringCurve.filter(item => Number.isFinite(item.TcapC)), point.outdoorTemperatureC, "TcapC");
      cap = engineeringCap.value ?? point.TcapC ?? point.supplyTemperatureC;
    } else {
      cap = manualTcapC;
      floor = manualTfloorC;
    }

    const measuredDeltaK = Number.isFinite(point.supplyTemperatureC) && Number.isFinite(point.returnTemperatureC)
      ? point.supplyTemperatureC - point.returnTemperatureC : null;
    const next = { ...point, TcapC: cap, TfloorC: floor, measuredDeltaK, availableDeltaK: null, maximumPotentialKWhM3: null, utilization: null, utilizationPercent: null, floorOutsideRange: floorOutside, potentialError: "" };
    if (!Number.isFinite(cap)) {
      missingCapCount += 1;
      next.potentialError = "T_cap unavailable: measured supply or engineering/manual CAP is required.";
    } else if (!Number.isFinite(floor)) {
      missingFloorCount += 1;
      next.potentialError = method === "automatic"
        ? "T_floor unavailable: return and outdoor temperature history did not produce a supported FLOOR curve."
        : "T_floor unavailable for the selected temperature method.";
    } else if (floor >= cap) {
      invalidBoundsCount += 1;
      next.potentialError = "T_floor must be lower than T_cap.";
    } else {
      next.availableDeltaK = cap - floor;
      next.maximumPotentialKWhM3 = WATER_KWH_PER_M3_K * next.availableDeltaK;
      next.utilization = point.VET / next.maximumPotentialKWhM3;
      next.utilizationPercent = next.utilization * 100;
      if (![next.availableDeltaK, next.maximumPotentialKWhM3, next.utilization, next.utilizationPercent].every(Number.isFinite)) {
        next.availableDeltaK = next.maximumPotentialKWhM3 = next.utilization = next.utilizationPercent = null;
        next.potentialError = "Derived temperature potential is outside the calculable range.";
      }
    }
    if (floorOutside) outsideFloorRangeCount += 1;
    return next;
  });
  return { points: calculatedPoints, missingCapCount, missingFloorCount, invalidBoundsCount, outsideFloorRangeCount };
}

export function parseEngineeringCurveCsv(text) {
  const { rows, malformedRows } = parseCsv(text.replace(/^\uFEFF/, ""));
  if (malformedRows) throw new RangeError("Engineering curve CSV contains an unclosed quoted field.");
  if (!rows.length) throw new RangeError("Engineering curve CSV must include a header row.");
  const headers = rows[0].map(value => value.trim());
  const duplicates = [...new Set(headers.filter(header => headers.filter(item => item === header).length > 1))];
  if (duplicates.length) throw new RangeError(`Engineering curve has duplicate columns: ${duplicates.join(", ")}.`);
  for (const required of ["outdoor_temperature_C", "T_floor_C"]) {
    if (!headers.includes(required)) throw new RangeError(`Engineering curve is missing required column: ${required}.`);
  }
  const indices = Object.fromEntries(headers.map((header, index) => [header, index]));
  const curve = rows.slice(1).map((row, index) => {
    const number = name => {
      const value = row[indices[name]]?.trim() ?? "";
      if (!value) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new RangeError(`Engineering curve row ${index + 2}: ${name} must be numeric.`);
      return parsed;
    };
    const outdoorTemperatureC = number("outdoor_temperature_C");
    const TfloorC = number("T_floor_C");
    const TcapC = indices.T_cap_C === undefined ? null : number("T_cap_C");
    if (outdoorTemperatureC === null || TfloorC === null) throw new RangeError(`Engineering curve row ${index + 2}: outdoor temperature and T_floor are required.`);
    return { outdoorTemperatureC, TfloorC, TcapC };
  }).sort((a, b) => a.outdoorTemperatureC - b.outdoorTemperatureC);
  if (!curve.length) throw new RangeError("Engineering curve needs at least one data row.");
  if (curve.some((point, index) => index && point.outdoorTemperatureC === curve[index - 1].outdoorTemperatureC)) {
    throw new RangeError("Engineering curve outdoor temperatures must be unique.");
  }
  return curve;
}

export function calculatePeriodChanges(baseline, comparison) {
  const specs = [
    ["VET", "periodVET", "kWh/m³", true, "kWh/m³"],
    ["η_VET", "aggregateUtilizationPercent", "%", true, "percentage points"],
    ["Pumped primary volume", "totalPumpedVolumeM3", "m³", true, "m³"],
    ["Sold energy", "totalSoldEnergyMWh", "MWh", true, "MWh"],
    ["Measured return temperature", "volumeWeightedReturnTemperatureC", "°C", false, "K"],
    ["Measured supply temperature", "volumeWeightedSupplyTemperatureC", "°C", false, "K"],
    ["Measured ΔT", "volumeWeightedMeasuredDeltaK", "K", false, "K"],
    ["Available temperature span", "volumeWeightedAvailableDeltaK", "K", true, "K"],
    ["Time-weighted average outdoor temperature", "timeWeightedOutdoorTemperatureC", "°C", false, "K"],
    ["T_cap", "volumeWeightedTcapC", "°C", false, "K"],
    ["T_floor", "volumeWeightedTfloorC", "°C", false, "K"],
  ];
  return specs.map(([label, key, unit, relativeChange, deltaUnit]) => {
    const before = baseline[key] ?? null;
    const after = comparison[key] ?? null;
    const absolute = before === null || after === null ? null : after - before;
    const relative = relativeChange && before !== 0 && absolute !== null ? absolute / before * 100 : null;
    return { label, before, after, unit, absolute, deltaUnit, relative };
  });
}

// Calibrate once from the selected reference, then apply that same curve to both periods.
export function comparePeriods(points, {
  baselineStartMs,
  baselineEndMs,
  comparisonStartMs,
  comparisonEndMs,
  floorReference = "baseline",
  temperatureMethod = {},
}) {
  const selectPeriod = (start, end, label) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new RangeError(`${label} start and end timestamps are invalid.`);
    const selected = points.filter(point => point.timestampMs >= start && point.timestampMs <= end);
    if (!selected.length) throw new RangeError(`${label} must include at least one accepted interval.`);
    return { points: selected, start, end, durationDays: (end - start) / 86400000 };
  };
  const baseline = selectPeriod(baselineStartMs, baselineEndMs, "Baseline period");
  const comparison = selectPeriod(comparisonStartMs, comparisonEndMs, "Comparison period");
  let floorAnalysis = null;
  let floorCurve = temperatureMethod.floorCurve ?? [];
  if ((temperatureMethod.method ?? "automatic") === "automatic") {
    const referencePoints = floorReference === "baseline" ? baseline.points : points;
    floorAnalysis = identifyFloorCurve(referencePoints);
    floorCurve = floorAnalysis.curve;
    if (!floorCurve.length) throw new RangeError(`The selected FLOOR reference has no supported bins. Each 2 °C bin needs at least ${floorAnalysis.minimumObservations} historical return/outdoor observations.`);
  }
  const calculatedPoints = applyTemperatureMethod(points, { ...temperatureMethod, floorCurve }).points;
  const periodPoints = period => calculatedPoints.filter(point => point.timestampMs >= period.start && point.timestampMs <= period.end);
  baseline.points = periodPoints(baseline);
  comparison.points = periodPoints(comparison);
  baseline.summary = summarizeSeries(baseline.points);
  comparison.summary = summarizeSeries(comparison.points);
  return { baseline, comparison, calculatedPoints, floorAnalysis, floorCurve };
}

// Intervention comparisons exclude the commissioning window, then reuse comparePeriods
// so an automatic FLOOR curve is calibrated once and frozen across both periods.
export function analyzeIntervention(points, {
  interventionDateMs,
  stabilizationDays = 0,
  baselineStartMs,
  baselineEndMs,
  comparisonStartMs,
  comparisonEndMs,
  floorReference = "baseline",
  temperatureMethod = {},
}) {
  if (!Number.isFinite(interventionDateMs)) throw new RangeError("Enter a valid intervention date.");
  if (!Number.isInteger(stabilizationDays) || stabilizationDays < 0) throw new RangeError("Stabilization days must be a non-negative whole number.");
  const excludedStartMs = interventionDateMs - stabilizationDays * 86400000;
  const excludedEndMs = interventionDateMs + (stabilizationDays + 1) * 86400000 - 1;
  const effectiveBaselineEndMs = Math.min(baselineEndMs, excludedStartMs - 1);
  const effectiveComparisonStartMs = Math.max(comparisonStartMs, excludedEndMs + 1);
  const analysis = comparePeriods(points, {
    baselineStartMs,
    baselineEndMs: effectiveBaselineEndMs,
    comparisonStartMs: effectiveComparisonStartMs,
    comparisonEndMs,
    floorReference,
    temperatureMethod,
  });
  const postFloorAnalysis = (temperatureMethod.method ?? "automatic") === "automatic"
    ? identifyFloorCurve(analysis.comparison.points)
    : null;
  return { ...analysis, excludedStartMs, excludedEndMs, postFloorAnalysis };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some(value => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (!quoted) {
    row.push(cell);
    if (row.some(value => value.trim() !== "")) rows.push(row);
  }
  return { rows, malformedRows: quoted ? 1 : 0 };
}

export function parseTimestampMs(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/.exec(value);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zulu, offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? 0);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return NaN;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 14 || Number(offsetMinuteText) > 59
    || (Number(offsetHourText) === 14 && Number(offsetMinuteText) !== 0))) return NaN;
  if (zulu || offsetSign) return Date.parse(value);
  const milliseconds = Number((fractionText ?? "").padEnd(3, "0").slice(0, 3) || 0);
  return Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
}

export function calendarDateValue(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "";
  const date = new Date(timestampMs);
  const pad = value => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function parseCalendarDateMs(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const start = parseTimestampMs(value);
  return Number.isFinite(start) ? start + (endOfDay ? 86400000 - 1 : 0) : NaN;
}

// Period utilization compares total sold heat with the volume-weighted available potential.
export function summarizeSeries(points) {
  if (!points.length) throw new RangeError("Import at least one time step.");
  const totalSoldEnergyMWh = points.reduce((sum, point) => sum + point.soldEnergyMWh, 0);
  const totalPumpedVolumeM3 = points.reduce((sum, point) => sum + point.pumpedVolumeM3, 0);
  const volumeWeightedMean = key => {
    const measured = points.filter(point => point[key] !== null && Number.isFinite(point[key]));
    const measuredVolume = measured.reduce((sum, point) => sum + point.pumpedVolumeM3, 0);
    return measuredVolume > 0
      ? measured.reduce((sum, point) => sum + point[key] * point.pumpedVolumeM3, 0) / measuredVolume
      : null;
  };
  const timeWeightedOutdoorMean = () => {
    const grouped = new Map();
    for (const point of points) {
      if (!Number.isFinite(point.timestampMs)) continue;
      const observation = grouped.get(point.timestampMs) ?? [];
      if (Number.isFinite(point.outdoorTemperatureC)) observation.push(point.outdoorTemperatureC);
      grouped.set(point.timestampMs, observation);
    }
    const observations = [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([timestampMs, values]) => ({
        timestampMs,
        temperatureC: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      }));
    if (!observations.some(observation => observation.temperatureC !== null)) return null;
    if (observations.length === 1) return observations[0].temperatureC;
    // Each reading covers the elapsed time to the next timestamp; the final reading uses the prior interval.
    let weightedTemperature = 0;
    let totalDuration = 0;
    observations.forEach((observation, index) => {
      if (observation.temperatureC === null) return;
      const duration = index < observations.length - 1
        ? observations[index + 1].timestampMs - observation.timestampMs
        : observation.timestampMs - observations[index - 1].timestampMs;
      weightedTemperature += observation.temperatureC * duration;
      totalDuration += duration;
    });
    return totalDuration > 0 ? weightedTemperature / totalDuration : null;
  };
  const potentialPoints = points.filter(point => Number.isFinite(point.maximumPotentialKWhM3));
  const totalMaximumPotentialKWh = potentialPoints.reduce((sum, point) => sum + point.maximumPotentialKWhM3 * point.pumpedVolumeM3, 0);
  const potentialVolumeM3 = potentialPoints.reduce((sum, point) => sum + point.pumpedVolumeM3, 0);
  const periodVET = totalSoldEnergyMWh * 1000 / totalPumpedVolumeM3;
  const aggregateUtilizationPercent = potentialPoints.length === points.length
    ? totalSoldEnergyMWh * 1000 / totalMaximumPotentialKWh * 100 : null;
  const volumeWeightedAvailableDeltaK = volumeWeightedMean("availableDeltaK");
  const volumeWeightedSupplyTemperatureC = volumeWeightedMean("supplyTemperatureC");
  const volumeWeightedReturnTemperatureC = volumeWeightedMean("returnTemperatureC");
  const volumeWeightedMeasuredDeltaK = volumeWeightedMean("measuredDeltaK");
  const volumeWeightedTcapC = volumeWeightedMean("TcapC");
  const volumeWeightedTfloorC = volumeWeightedMean("TfloorC");
  const timeWeightedOutdoorTemperatureC = timeWeightedOutdoorMean();

  if (![totalSoldEnergyMWh, totalPumpedVolumeM3, totalMaximumPotentialKWh, periodVET].every(Number.isFinite)
    || [aggregateUtilizationPercent, volumeWeightedAvailableDeltaK, volumeWeightedSupplyTemperatureC, volumeWeightedReturnTemperatureC, volumeWeightedMeasuredDeltaK, volumeWeightedTcapC, volumeWeightedTfloorC, timeWeightedOutdoorTemperatureC].some(value => value !== null && !Number.isFinite(value))) {
    throw new RangeError("Imported period totals are outside the calculable range.");
  }

  return {
    count: points.length,
    totalSoldEnergyMWh,
    totalPumpedVolumeM3,
    totalMaximumPotentialKWh,
    periodVET,
    aggregateUtilizationPercent,
    potentialIntervalCount: potentialPoints.length,
    volumeWeightedAvailableDeltaK,
    volumeWeightedMaximumPotentialKWhM3: potentialPoints.length === points.length ? totalMaximumPotentialKWh / potentialVolumeM3 : null,
    volumeWeightedSupplyTemperatureC,
    volumeWeightedReturnTemperatureC,
    volumeWeightedMeasuredDeltaK,
    volumeWeightedTcapC,
    volumeWeightedTfloorC,
    timeWeightedOutdoorTemperatureC,
  };
}

export function parseVETCsv(text) {
  const { rows, malformedRows } = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!rows.length) {
    return {
      acceptedRows: [], rowCount: malformedRows, rejectedCount: malformedRows,
      rejections: malformedRows ? [{ rowNumber: 1, reason: "Malformed CSV record: unclosed quoted field." }] : [],
      globalErrors: malformedRows ? [] : ["CSV must include a header row."],
    };
  }

  const headers = rows[0].map(value => value.trim());
  const indices = Object.fromEntries(headers.map((header, index) => [header, index]));
  const requiredHeaders = ["timestamp", "sold_energy_MWh", "pumped_volume_m3"];
  const missing = requiredHeaders.filter(header => !headers.includes(header));
  const knownHeaders = [...requiredHeaders, "supply_temperature_C", "return_temperature_C", "outdoor_temperature_C", "T_cap_C", "T_floor_C"];
  const duplicate = [...new Set(headers.filter(header => knownHeaders.includes(header) && headers.filter(item => item === header).length > 1))];
  const rowCount = Math.max(0, rows.length - 1) + malformedRows;
  if (missing.length || duplicate.length) {
    const errors = [];
    if (missing.length) errors.push(`Missing required columns: ${missing.join(", ")}.`);
    if (duplicate.length) errors.push(`Duplicate columns: ${duplicate.join(", ")}.`);
    return { acceptedRows: [], rowCount, rejectedCount: rowCount, rejections: [], globalErrors: errors };
  }

  const valueAt = (row, header) => row[indices[header]]?.trim() ?? "";
  const numberAt = (row, header, errors, optional = false) => {
    const raw = valueAt(row, header);
    if (optional && raw === "") return null;
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      errors.push(`${header} must contain a finite number.`);
      return null;
    }
    return value;
  };

  const acceptedRows = [];
  const rejections = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const rowNumber = index + 2;
    const errors = [];
    const timestamp = valueAt(row, "timestamp");
    const timestampMs = parseTimestampMs(timestamp);
    if (!timestamp || !Number.isFinite(timestampMs)) errors.push("timestamp is malformed or missing.");

    const inputs = {
      soldEnergyMWh: numberAt(row, "sold_energy_MWh", errors),
      pumpedVolumeM3: numberAt(row, "pumped_volume_m3", errors),
      TcapC: indices.T_cap_C === undefined ? null : numberAt(row, "T_cap_C", errors, true),
      TfloorC: indices.T_floor_C === undefined ? null : numberAt(row, "T_floor_C", errors, true),
      supplyTemperatureC: indices.supply_temperature_C === undefined
        ? null : numberAt(row, "supply_temperature_C", errors, true),
      returnTemperatureC: indices.return_temperature_C === undefined
        ? null : numberAt(row, "return_temperature_C", errors, true),
      outdoorTemperatureC: indices.outdoor_temperature_C === undefined
        ? null : numberAt(row, "outdoor_temperature_C", errors, true),
    };

    if (inputs.soldEnergyMWh !== null && inputs.soldEnergyMWh < 0) errors.push("sold_energy_MWh cannot be negative.");
    if (inputs.pumpedVolumeM3 !== null && inputs.pumpedVolumeM3 <= 0) errors.push("pumped_volume_m3 must be greater than zero.");
    if (inputs.TcapC !== null && inputs.TfloorC !== null && inputs.TfloorC >= inputs.TcapC) errors.push("T_floor_C must be lower than T_cap_C.");
    if (errors.length) {
      rejections.push({ rowNumber, timestamp, reason: errors.join(" ") });
      continue;
    }
    try {
      const VET = inputs.soldEnergyMWh * 1000 / inputs.pumpedVolumeM3;
      if (!Number.isFinite(VET)) throw new RangeError("The entered values are outside the calculable range.");
      acceptedRows.push({ timestamp, timestampMs, ...inputs, VET, measuredDeltaK: inputs.supplyTemperatureC !== null && inputs.returnTemperatureC !== null ? inputs.supplyTemperatureC - inputs.returnTemperatureC : null });
    } catch (error) {
      rejections.push({ rowNumber, timestamp, reason: error.message });
    }
  }

  if (malformedRows) {
    rejections.push({ rowNumber: rows.length + 1, timestamp: "", reason: "Malformed CSV record: unclosed quoted field; trailing record rejected." });
  }

  acceptedRows.sort((a, b) => a.timestampMs - b.timestampMs);
  return { acceptedRows, rowCount, rejectedCount: rejections.length, rejections, globalErrors: [] };
}
