import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  applyTemperatureMethod,
  analyzeIntervention,
  calculatePeriodChanges,
  calculateVET,
  calendarDateValue,
  comparePeriods,
  FLOOR_MIN_OBSERVATIONS,
  identifyFloorCurve,
  interpolateCurve,
  parseCalendarDateMs,
  parseEngineeringCurveCsv,
  parseTimestampMs,
  parseVETCsv,
  summarizeSeries,
} from "./vet-model.mjs";

const closeTo = (actual, expected, tolerance = .001) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};
assert.equal(FLOOR_MIN_OBSERVATIONS, 20);
const janFirstUtc = Date.UTC(2026, 0, 1);
assert.equal(parseTimestampMs("2026-01-01"), janFirstUtc);
assert.equal(parseTimestampMs("2026-01-01T00:00"), janFirstUtc);
assert.equal(parseCalendarDateMs("2026-01-01"), janFirstUtc);
assert.equal(parseCalendarDateMs("2026-01-01", true), janFirstUtc + 86400000 - 1);
assert.equal(calendarDateValue(janFirstUtc), "2026-01-01");
assert.equal(parseTimestampMs("2026-01-01T02:00:00+02:00"), janFirstUtc);

const timezoneCheck = `
  import assert from "node:assert/strict";
  import { analyzeIntervention, calendarDateValue, parseCalendarDateMs, parseTimestampMs, parseVETCsv } from "./vet-model.mjs";
  const jan1 = Date.UTC(2026, 0, 1);
  assert.equal(parseTimestampMs("2026-01-01"), jan1);
  assert.equal(parseTimestampMs("2026-01-01T00:00"), jan1);
  assert.equal(calendarDateValue(jan1), "2026-01-01");
  const rows = parseVETCsv([
    "timestamp,sold_energy_MWh,pumped_volume_m3,supply_temperature_C,return_temperature_C,outdoor_temperature_C",
    "2025-12-31,1,10,70,40,0",
    "2026-01-01,1,10,70,40,1",
    "2026-01-02,1,10,70,40,2",
  ].join("\\n")).acceptedRows;
  assert.deepEqual(rows.map(row => row.timestampMs), [Date.UTC(2025, 11, 31), jan1, Date.UTC(2026, 0, 2)]);
  const result = analyzeIntervention(rows, {
    interventionDateMs: parseCalendarDateMs("2026-01-01"),
    stabilizationDays: 0,
    baselineStartMs: parseCalendarDateMs("2025-12-31"),
    baselineEndMs: parseCalendarDateMs("2025-12-31", true),
    comparisonStartMs: parseCalendarDateMs("2026-01-01"),
    comparisonEndMs: parseCalendarDateMs("2026-01-02", true),
    temperatureMethod: { method: "manual", manualTcapC: 80, manualTfloorC: 30 },
  });
  assert.equal(result.excludedStartMs, jan1);
  assert.equal(calendarDateValue(result.excludedEndMs), "2026-01-01");
  assert.deepEqual(result.baseline.points.map(row => row.timestamp), ["2025-12-31"]);
  assert.deepEqual(result.comparison.points.map(row => row.timestamp), ["2026-01-02"]);
`;
for (const timezone of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
  const timezoneResult = spawnSync(process.execPath, ["--input-type=module", "-e", timezoneCheck], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: timezone },
    encoding: "utf8",
  });
  assert.equal(timezoneResult.status, 0, `${timezone} date regression: ${timezoneResult.stderr}`);
}

const cases = [
  { name: "Winter", TcapC: 85, TfloorC: 40, soldEnergyMWh: 18, pumpedVolumeM3: 450, vet: 40, potential: 52, eta: .77 },
  { name: "Mild period", TcapC: 75, TfloorC: 38, soldEnergyMWh: 10, pumpedVolumeM3: 350, vet: 29, potential: 43, eta: .67 },
  { name: "Summer", TcapC: 65, TfloorC: 35, soldEnergyMWh: 6, pumpedVolumeM3: 300, vet: 20, potential: 35, eta: .57 },
];
for (const item of cases) {
  const result = calculateVET(item);
  closeTo(result.VET, item.vet, .5);
  closeTo(result.maximumPotentialKWhM3, item.potential, .5);
  closeTo(result.utilization, item.eta, .01);
  console.log(`${item.name}: VET ${result.VET.toFixed(2)} kWh/m³, potential ${result.maximumPotentialKWhM3.toFixed(2)} kWh/m³, utilization ${(result.utilization * 100).toFixed(1)}%`);
}

const snapshot = calculateVET({ soldEnergyMWh: 18, pumpedVolumeM3: 450, TcapC: 85, TfloorC: 40, supplyTemperatureC: 70, returnTemperatureC: 30 });
assert.equal(snapshot.availableDeltaK, 45);
assert.equal(snapshot.measuredDeltaK, 40);
assert.equal(snapshot.VET, 40);
assert.equal(snapshot.maximumPotentialKWhM3, 52.335);
closeTo(snapshot.utilizationPercent, 76.433, .01);
assert.throws(() => calculateVET({ soldEnergyMWh: 1, pumpedVolumeM3: 0, TcapC: 80, TfloorC: 40 }), /greater than zero/);
assert.throws(() => calculateVET({ soldEnergyMWh: -1, pumpedVolumeM3: 1, TcapC: 80, TfloorC: 40 }), /cannot be negative/);
assert.throws(() => calculateVET({ soldEnergyMWh: 1, pumpedVolumeM3: 1, TcapC: 40, TfloorC: 40 }), /lower than T_cap/);

const floorObservations = [];
for (let index = 0; index < 20; index += 1) {
  floorObservations.push({ outdoorTemperatureC: .5, returnTemperatureC: 30 + index });
  floorObservations.push({ outdoorTemperatureC: 2.5, returnTemperatureC: 20 + index });
}
const floorAnalysis = identifyFloorCurve(floorObservations);
assert.equal(floorAnalysis.curve.length, 2);
closeTo(floorAnalysis.curve[0].floorC, 31.9);
closeTo(floorAnalysis.curve[1].floorC, 21.9);
closeTo(interpolateCurve(floorAnalysis.curve, 2).value, 26.9);
const outsideCold = interpolateCurve(floorAnalysis.curve, -8);
assert.equal(outsideCold.outsideRange, true);
closeTo(outsideCold.value, 31.9);
const tooFew = identifyFloorCurve(floorObservations.slice(0, 4));
assert.equal(tooFew.curve.length, 0);
assert.equal(tooFew.observationCount, 4);
assert.equal(tooFew.minimumObservations, 20);
assert.equal(tooFew.bins.every(bin => !bin.supported && bin.count === 2), true);
const oneShortBin = identifyFloorCurve(floorObservations.slice(0, 19));
assert.equal(oneShortBin.curve.length, 0);
assert.equal(oneShortBin.bins[0].count, 10);

const oldCsv = parseVETCsv([
  "timestamp,sold_energy_MWh,pumped_volume_m3,T_cap_C,T_floor_C,supply_temperature_C,return_temperature_C",
  "2025-01-01,10,200,80,35,75,40",
].join("\n"));
assert.equal(oldCsv.acceptedRows.length, 1);
assert.equal(oldCsv.acceptedRows[0].outdoorTemperatureC, null);
assert.equal(oldCsv.acceptedRows[0].VET, 50);
const legacyEngineering = applyTemperatureMethod(oldCsv.acceptedRows, { method: "engineering" }).points[0];
assert.equal(legacyEngineering.TcapC, 80);
assert.equal(legacyEngineering.TfloorC, 35);
const manualScenario = applyTemperatureMethod(oldCsv.acceptedRows, { method: "manual", manualTcapC: 82, manualTfloorC: 38 }).points[0];
assert.equal(manualScenario.TcapC, 82);
assert.equal(manualScenario.TfloorC, 38);
assert.equal(manualScenario.VET, oldCsv.acceptedRows[0].VET);
const noOutdoor = applyTemperatureMethod(oldCsv.acceptedRows, { method: "automatic", floorCurve: [] });
assert.equal(noOutdoor.points[0].VET, 50);
assert.equal(noOutdoor.points[0].TcapC, 75);
assert.equal(noOutdoor.missingFloorCount, 1);
assert.equal(identifyFloorCurve(oldCsv.acceptedRows).curve.length, 0);
const rejected = parseVETCsv([
  "timestamp,sold_energy_MWh,pumped_volume_m3,supply_temperature_C,T_floor_C,T_cap_C",
  "not-a-date,1,5,70,30,80",
  "2025-01-02,1,0,70,30,80",
  "2025-01-03,-1,5,70,30,80",
  "2025-01-04,1,5,70,80,70",
  "2025-01-05,1,5,invalid,30,80",
].join("\n"));
assert.equal(rejected.acceptedRows.length, 0);
assert.equal(rejected.rejectedCount, 5);
assert.equal(parseVETCsv("timestamp,sold_energy_MWh\n2025-01-01,1").globalErrors.length, 1);

const engineering = parseEngineeringCurveCsv([
  "outdoor_temperature_C,T_floor_C,T_cap_C",
  "0,32,78",
  "10,27,72",
].join("\n"));
assert.equal(engineering.length, 2);
const engineeringEstimate = applyTemperatureMethod([{ ...oldCsv.acceptedRows[0], outdoorTemperatureC: 5 }], { method: "engineering", engineeringCurve: engineering }).points[0];
assert.equal(engineeringEstimate.TcapC, 75);
assert.equal(engineeringEstimate.TfloorC, 29.5);

const csvRows = [
  "timestamp,sold_energy_MWh,pumped_volume_m3,supply_temperature_C,return_temperature_C,outdoor_temperature_C",
  ...Array.from({ length: 40 }, (_, index) => {
    const outdoor = index < 20 ? .5 : 2.5;
    const returned = index < 20 ? 30 + index : 20 + index - 20;
    const timestamp = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
    return `${timestamp},2,50,${70 - index},${returned},${outdoor}`;
  }),
];
const imported = parseVETCsv(csvRows.join("\n"));
assert.equal(imported.acceptedRows.length, 40);
const calibrated = identifyFloorCurve(imported.acceptedRows);
const derived = applyTemperatureMethod(imported.acceptedRows, { method: "automatic", floorCurve: calibrated.curve });
assert.equal(derived.points[0].TcapC, imported.acceptedRows[0].supplyTemperatureC);
assert.equal(derived.points[0].TfloorC, calibrated.curve[0].floorC);
const aboveReferenceInput = { ...imported.acceptedRows[0], soldEnergyMWh: 100, pumpedVolumeM3: 1000 };
aboveReferenceInput.VET = aboveReferenceInput.soldEnergyMWh * 1000 / aboveReferenceInput.pumpedVolumeM3;
const aboveReference = applyTemperatureMethod([aboveReferenceInput], { method: "automatic", floorCurve: calibrated.curve }).points[0];
assert.ok(aboveReference.utilizationPercent > 100);
closeTo(aboveReference.VET, aboveReferenceInput.soldEnergyMWh * 1000 / aboveReferenceInput.pumpedVolumeM3);
closeTo(aboveReference.utilizationPercent, aboveReference.VET / aboveReference.maximumPotentialKWhM3 * 100);
const comparisonRows = imported.acceptedRows.slice(20).map(point => ({ ...point, returnTemperatureC: point.returnTemperatureC - 4 }));
const frozenFloor = interpolateCurve(calibrated.curve, comparisonRows[0].outdoorTemperatureC).value;
const comparisonApplied = applyTemperatureMethod(comparisonRows, { method: "automatic", floorCurve: calibrated.curve });
assert.equal(comparisonApplied.points[0].TfloorC, frozenFloor);
assert.notEqual(identifyFloorCurve(comparisonRows).curve[0].floorC, frozenFloor);

const baselineSummary = summarizeSeries(derived.points.slice(0, 10));
const comparisonSummary = summarizeSeries(derived.points.slice(10, 20));
assert.equal(baselineSummary.totalSoldEnergyMWh, 20);
assert.equal(baselineSummary.totalPumpedVolumeM3, 500);
assert.equal(baselineSummary.periodVET, 40);
closeTo(baselineSummary.aggregateUtilizationPercent, 40 / (1.163 * (65.5 - calibrated.curve[0].floorC)) * 100);
closeTo(baselineSummary.volumeWeightedSupplyTemperatureC, 65.5);
closeTo(baselineSummary.volumeWeightedReturnTemperatureC, 34.5);
const changes = calculatePeriodChanges(baselineSummary, comparisonSummary);
const vetChange = changes.find(change => change.label === "VET");
assert.equal(vetChange.absolute, 0);
assert.equal(vetChange.relative, 0);
const volumeChange = changes.find(change => change.label === "Pumped primary volume");
assert.equal(volumeChange.absolute, 0);
assert.equal(volumeChange.relative, 0);
const weighted = summarizeSeries([
  { soldEnergyMWh: 1, pumpedVolumeM3: 10, VET: 100, maximumPotentialKWhM3: 46.52, TcapC: 70, TfloorC: 30, availableDeltaK: 40, supplyTemperatureC: 68, returnTemperatureC: 40, measuredDeltaK: 28, outdoorTemperatureC: 5, timestampMs: Date.UTC(2025, 0, 1) },
  { soldEnergyMWh: 6, pumpedVolumeM3: 30, VET: 200, maximumPotentialKWhM3: 23.26, TcapC: 60, TfloorC: 40, availableDeltaK: 20, supplyTemperatureC: 50, returnTemperatureC: 30, measuredDeltaK: 20, outdoorTemperatureC: 15, timestampMs: Date.UTC(2025, 0, 1, 2) },
]);
assert.equal(weighted.periodVET, 175);
assert.notEqual(weighted.periodVET, (100 + 200) / 2);
closeTo(weighted.aggregateUtilizationPercent, 7000 / (46.52 * 10 + 23.26 * 30) * 100);
closeTo(weighted.volumeWeightedSupplyTemperatureC, 54.5);
closeTo(weighted.volumeWeightedReturnTemperatureC, 32.5);
closeTo(weighted.volumeWeightedMeasuredDeltaK, 22);
closeTo(weighted.volumeWeightedAvailableDeltaK, 25);
assert.equal(weighted.timeWeightedOutdoorTemperatureC, 10);
assert.notEqual(weighted.timeWeightedOutdoorTemperatureC, (5 * 10 + 15 * 30) / 40);
const regularlySampledWeather = summarizeSeries([
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 10, timestampMs: Date.UTC(2025, 0, 1) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 20, timestampMs: Date.UTC(2025, 0, 2) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 30, timestampMs: Date.UTC(2025, 0, 3) },
]);
assert.equal(regularlySampledWeather.timeWeightedOutdoorTemperatureC, 20);
const irregularWeather = summarizeSeries([
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 0, timestampMs: Date.UTC(2025, 0, 1) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1000, outdoorTemperatureC: 10, timestampMs: Date.UTC(2025, 0, 1, 1) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 30, timestampMs: Date.UTC(2025, 0, 1, 3) },
]);
closeTo(irregularWeather.timeWeightedOutdoorTemperatureC, 16);
const weatherWithGap = summarizeSeries([
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 0, timestampMs: Date.UTC(2025, 0, 1) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: null, timestampMs: Date.UTC(2025, 0, 2) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: null, timestampMs: Date.UTC(2025, 0, 4) },
  { soldEnergyMWh: 1, pumpedVolumeM3: 1, outdoorTemperatureC: 40, timestampMs: Date.UTC(2025, 0, 7) },
]);
assert.equal(weatherWithGap.timeWeightedOutdoorTemperatureC, 30);

const sampleBaseline = { periodVET: 31.4, aggregateUtilizationPercent: 64.1, totalPumpedVolumeM3: 42100, totalSoldEnergyMWh: 1321, volumeWeightedReturnTemperatureC: 43.2, volumeWeightedSupplyTemperatureC: 70, volumeWeightedMeasuredDeltaK: 26.8, volumeWeightedAvailableDeltaK: 41 };
const sampleComparison = { periodVET: 34, aggregateUtilizationPercent: 68.7, totalPumpedVolumeM3: 39300, totalSoldEnergyMWh: 1336, volumeWeightedReturnTemperatureC: 41.1, volumeWeightedSupplyTemperatureC: 70.3, volumeWeightedMeasuredDeltaK: 29.2, volumeWeightedAvailableDeltaK: 42 };
const changeExample = calculatePeriodChanges(sampleBaseline, sampleComparison);
const exampleVET = changeExample.find(change => change.label === "VET");
closeTo(exampleVET.absolute, 2.6);
closeTo(exampleVET.relative, 2.6 / 31.4 * 100);
const exampleEta = changeExample.find(change => change.label === "η_VET");
closeTo(exampleEta.absolute, 4.6);
const exampleVolume = changeExample.find(change => change.label === "Pumped primary volume");
assert.equal(exampleVolume.absolute, -2800);
closeTo(exampleVolume.relative, -2800 / 42100 * 100);
closeTo(changeExample.find(change => change.label === "Measured return temperature").absolute, -2.1);

const sampleCsv = readFileSync(new URL("./sample-vet-data.csv", import.meta.url), "utf8");
const sample = parseVETCsv(sampleCsv);
const demoLoadedThroughSharedCsvParser = parseVETCsv(sampleCsv);
assert.deepEqual(demoLoadedThroughSharedCsvParser, sample, "demo CSV parsing must match a manually imported copy");
assert.equal(sample.rowCount, 730);
assert.equal(sample.acceptedRows.length, 730);
assert.equal(sample.rejectedCount, 0);
const sampleFloor = identifyFloorCurve(sample.acceptedRows);
assert.ok(sampleFloor.curve.length >= 5);
const sampleDerived = applyTemperatureMethod(sample.acceptedRows, { method: "automatic", floorCurve: sampleFloor.curve });
const sampleSummary = summarizeSeries(sampleDerived.points);
assert.equal(sampleSummary.potentialIntervalCount, 730);
assert.ok(sampleSummary.periodVET > 0);
assert.ok(sampleSummary.aggregateUtilizationPercent > 0 && sampleSummary.aggregateUtilizationPercent < 100);
const sampleBaselineRaw = sample.acceptedRows.filter(point => point.timestamp.startsWith("2022-"));
const baselineFloor = identifyFloorCurve(sampleBaselineRaw);
assert.ok(baselineFloor.curve.length >= 5);
const comparisonYearStart = sample.acceptedRows.findIndex(point => point.timestamp === "2023-01-01");
const samplePeriods = comparePeriods(sample.acceptedRows, {
  baselineStartMs: sample.acceptedRows[0].timestampMs,
  baselineEndMs: sampleBaselineRaw.at(-1).timestampMs,
  comparisonStartMs: sample.acceptedRows[comparisonYearStart].timestampMs,
  comparisonEndMs: sample.acceptedRows.at(-1).timestampMs,
  floorReference: "baseline",
  temperatureMethod: { method: "automatic" },
});
assert.deepEqual(samplePeriods.floorCurve, baselineFloor.curve);
const fullReferencePeriods = comparePeriods(sample.acceptedRows, {
  baselineStartMs: sample.acceptedRows[0].timestampMs,
  baselineEndMs: sampleBaselineRaw.at(-1).timestampMs,
  comparisonStartMs: sample.acceptedRows[comparisonYearStart].timestampMs,
  comparisonEndMs: sample.acceptedRows.at(-1).timestampMs,
  floorReference: "history",
  temperatureMethod: { method: "automatic" },
});
assert.deepEqual(fullReferencePeriods.floorCurve, sampleFloor.curve);
const before = samplePeriods.baseline.summary;
const after = samplePeriods.comparison.summary;
closeTo(samplePeriods.calculatedPoints[comparisonYearStart].TfloorC, interpolateCurve(baselineFloor.curve, sample.acceptedRows[comparisonYearStart].outdoorTemperatureC).value);
assert.notEqual(before.periodVET, after.periodVET);
const intervention = analyzeIntervention(sample.acceptedRows, {
  interventionDateMs: Date.parse("2023-01-01T00:00:00Z"),
  stabilizationDays: 0,
  baselineStartMs: Date.parse("2022-01-01T00:00:00Z"),
  baselineEndMs: Date.parse("2022-12-31T23:59:59.999Z"),
  comparisonStartMs: Date.parse("2023-01-01T00:00:00Z"),
  comparisonEndMs: Date.parse("2023-12-31T23:59:59.999Z"),
  floorReference: "baseline",
  temperatureMethod: { method: "automatic" },
});
const interventionBefore = intervention.baseline.summary;
const interventionAfter = intervention.comparison.summary;
assert.equal(intervention.baseline.points.length, 365);
assert.equal(intervention.comparison.points.length, 364);
assert.equal(intervention.excludedEndMs - intervention.excludedStartMs + 1, 86400000);
assert.deepEqual(intervention.floorCurve, identifyFloorCurve(intervention.baseline.points).curve);
assert.equal(intervention.comparison.points.some(point => point.timestamp === "2023-01-01"), false);
assert.ok(intervention.postFloorAnalysis.curve.length > 0);
const beforeAnnual = intervention.baseline.summary;
const afterAnnual = intervention.comparison.summary;
assert.ok(Math.abs(afterAnnual.totalSoldEnergyMWh / beforeAnnual.totalSoldEnergyMWh - 1) < .02, "paired annual sold energy should remain comparable");
assert.ok(Math.abs(afterAnnual.timeWeightedOutdoorTemperatureC - beforeAnnual.timeWeightedOutdoorTemperatureC) < .7, "paired annual outdoor temperatures should be similar");
assert.ok(afterAnnual.volumeWeightedReturnTemperatureC < beforeAnnual.volumeWeightedReturnTemperatureC - 2.5);
assert.ok(afterAnnual.volumeWeightedMeasuredDeltaK > beforeAnnual.volumeWeightedMeasuredDeltaK + 2.5);
assert.ok(afterAnnual.totalPumpedVolumeM3 < beforeAnnual.totalPumpedVolumeM3 * .96);
assert.ok(afterAnnual.periodVET > beforeAnnual.periodVET * 1.05);
assert.ok(afterAnnual.aggregateUtilizationPercent > beforeAnnual.aggregateUtilizationPercent);
const baselineFloorAtZero = interpolateCurve(intervention.floorCurve, 0);
const postFloorAtZero = interpolateCurve(intervention.postFloorAnalysis.curve, 0);
assert.equal(baselineFloorAtZero.outsideRange, false);
assert.equal(postFloorAtZero.outsideRange, false);
assert.ok(postFloorAtZero.value < baselineFloorAtZero.value - 2.5);
const underlyingTypeIndependent = analyzeIntervention(sample.acceptedRows, {
  interventionDateMs: Date.parse("2023-01-01T00:00:00Z"),
  stabilizationDays: 0,
  baselineStartMs: Date.parse("2022-01-01T00:00:00Z"),
  baselineEndMs: Date.parse("2022-12-31T23:59:59.999Z"),
  comparisonStartMs: Date.parse("2023-01-01T00:00:00Z"),
  comparisonEndMs: Date.parse("2023-12-31T23:59:59.999Z"),
  floorReference: "baseline",
  temperatureMethod: { method: "automatic" },
  interventionType: "Other network intervention",
});
assert.equal(underlyingTypeIndependent.baseline.summary.periodVET, intervention.baseline.summary.periodVET);
assert.equal(underlyingTypeIndependent.comparison.summary.aggregateUtilizationPercent, intervention.comparison.summary.aggregateUtilizationPercent);
const expectedAfterVET = intervention.comparison.summary.totalSoldEnergyMWh * 1000 / intervention.comparison.summary.totalPumpedVolumeM3;
closeTo(intervention.comparison.summary.periodVET, expectedAfterVET);
closeTo(intervention.baseline.summary.periodVET, intervention.baseline.summary.totalSoldEnergyMWh * 1000 / intervention.baseline.summary.totalPumpedVolumeM3);
const expectedBaselinePotential = intervention.baseline.points.reduce((sum, point) => sum + point.maximumPotentialKWhM3 * point.pumpedVolumeM3, 0);
closeTo(intervention.baseline.summary.aggregateUtilizationPercent, intervention.baseline.summary.totalSoldEnergyMWh * 1000 / expectedBaselinePotential * 100);
const fixedCurveValue = interpolateCurve(intervention.floorCurve, intervention.comparison.points[0].outdoorTemperatureC).value;
closeTo(intervention.comparison.points[0].TfloorC, fixedCurveValue);
const interventionChanges = calculatePeriodChanges(intervention.baseline.summary, intervention.comparison.summary);
assert.ok(interventionChanges.some(change => change.label === "Time-weighted average outdoor temperature"));
const stabilizedIntervention = analyzeIntervention(sample.acceptedRows, {
  interventionDateMs: Date.parse("2023-07-01T00:00:00Z"),
  stabilizationDays: 2,
  baselineStartMs: Date.parse("2023-01-01T00:00:00Z"),
  baselineEndMs: Date.parse("2023-06-30T23:59:59.999Z"),
  comparisonStartMs: Date.parse("2023-07-02T00:00:00Z"),
  comparisonEndMs: Date.parse("2023-12-31T23:59:59.999Z"),
  temperatureMethod: { method: "automatic" },
});
assert.equal(stabilizedIntervention.excludedEndMs - stabilizedIntervention.excludedStartMs + 1, 5 * 86400000);
assert.equal(stabilizedIntervention.baseline.points.at(-1).timestamp, "2023-06-28");
assert.equal(stabilizedIntervention.comparison.points[0].timestamp, "2023-07-04");
const pagesOrigin = "https://username.github.io/vet-dashboard/";
for (const asset of ["styles.css", "app.mjs", "sample-vet-data.csv", "robots.txt"]) {
  assert.equal(new URL(asset, pagesOrigin).pathname, `/vet-dashboard/${asset}`);
}
assert.equal(new URL("./vet-model.mjs", new URL("app.mjs", pagesOrigin)).pathname, "/vet-dashboard/vet-model.mjs");
assert.equal(new URL("./sample-vet-data.csv", new URL("app.mjs", pagesOrigin)).pathname, "/vet-dashboard/sample-vet-data.csv");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
assert.match(html, /href="styles\.css"/);
assert.match(html, /src="app\.mjs"/);
assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
assert.match(readFileSync(new URL("./robots.txt", import.meta.url), "utf8"), /User-agent: \*\s+Disallow: \/\s*$/);
assert.match(html, /Automatic \/ Historical mode, measured supply temperature at the pumped-volume boundary defines T_cap/);
assert.match(html, /Measured return temperature does not directly define T_floor/);
assert.match(html, /Snapshot \/ Manual mode, entered T_cap and T_floor remain independent/);
assert.match(html, /How to use this dashboard/);
assert.match(html, /The demo dataset is synthetic and does not represent a real district-heating network/);
assert.match(html, /Preparing your CSV file/);
assert.match(html, /Data quality considerations/);
assert.match(html, /Imported datasets are processed locally in the browser and are not uploaded by the dashboard/);
assert.match(html, /id="load-demo-data"[^>]*>Load demo data/);
assert.match(html, /id="clear-demo-data"[^>]*>Clear demo data/);
assert.match(appSource, /const start = parseTimestampMs\(startField\.value\)/);
assert.match(appSource, /const end = parseTimestampMs\(endField\.value\)/);
assert.match(appSource, /function utcDateTime/);
assert.match(appSource, /getUTCFullYear\(\)/);
assert.match(appSource, /time-weighted average outdoor temperature/);
assert.match(appSource, /new URL\("\.\/sample-vet-data\.csv", import\.meta\.url\)/);
assert.match(appSource, /fetch\(demoUrl, \{ credentials: "same-origin" \}\)/);
assert.equal((appSource.match(/fetch\s*\(/g) ?? []).length, 1, "the demo is the only network request in the app");
assert.match(appSource, /return importCsvContent\(file\.name, \(\) => file\.text\(\)\)/);
assert.match(appSource, /const result = parseVETCsv\(await readText\(\)\)/);
assert.match(appSource, /function prefillDemoIntervention/);
assert.match(appSource, /"2022-01-01"/);
assert.match(appSource, /"2023-12-31"/);
assert.doesNotMatch(appSource, /XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|method:\s*["']POST["']/i);
assert.match(stylesheet, /\.help-grid \{ grid-template-columns: 1fr/);
assert.match(stylesheet, /\.help-section pre \{ overflow-x: auto/);
console.log(`Automatic FLOOR: ${sampleFloor.curve.length} supported 2 °C bins from ${sampleFloor.observationCount} observations; VET ${sampleSummary.periodVET.toFixed(2)} kWh/m³; utilization ${sampleSummary.aggregateUtilizationPercent.toFixed(1)}%.`);
console.log(`Sample baseline → comparison with one frozen FLOOR curve (${baselineFloor.curve.length} bins): VET ${before.periodVET.toFixed(2)} → ${after.periodVET.toFixed(2)} kWh/m³; η_VET ${before.aggregateUtilizationPercent.toFixed(1)} → ${after.aggregateUtilizationPercent.toFixed(1)}%; return temperature ${before.volumeWeightedReturnTemperatureC.toFixed(2)} → ${after.volumeWeightedReturnTemperatureC.toFixed(2)} °C; measured ΔT ${before.volumeWeightedMeasuredDeltaK.toFixed(2)} → ${after.volumeWeightedMeasuredDeltaK.toFixed(2)} K.`);
console.log(`Sample intervention (baseline FLOOR frozen): ${intervention.baseline.points.length} baseline / ${intervention.comparison.points.length} after intervals; sold energy ${interventionBefore.totalSoldEnergyMWh.toFixed(0)} → ${interventionAfter.totalSoldEnergyMWh.toFixed(0)} MWh; pumped volume ${interventionBefore.totalPumpedVolumeM3.toFixed(0)} → ${interventionAfter.totalPumpedVolumeM3.toFixed(0)} m³; VET ${interventionBefore.periodVET.toFixed(2)} → ${interventionAfter.periodVET.toFixed(2)} kWh/m³; η_VET ${interventionBefore.aggregateUtilizationPercent.toFixed(1)} → ${interventionAfter.aggregateUtilizationPercent.toFixed(1)}%.`);
console.log(`Measured return ${interventionBefore.volumeWeightedReturnTemperatureC.toFixed(2)} → ${interventionAfter.volumeWeightedReturnTemperatureC.toFixed(2)} °C; measured ΔT ${interventionBefore.volumeWeightedMeasuredDeltaK.toFixed(2)} → ${interventionAfter.volumeWeightedMeasuredDeltaK.toFixed(2)} K; reference FLOOR at 0 °C outdoor ${baselineFloorAtZero.value.toFixed(2)} → ${postFloorAtZero.value.toFixed(2)} °C; ${intervention.postFloorAnalysis.curve.length} post-period supported bins.`);
console.log("Snapshot formulas, CAP/FLOOR identification, 20-observation FLOOR support, frozen comparison, separate post-FLOOR, intervention effect, time-weighted outdoor averages, UTC date handling in positive/negative timezones, local-only data flow, sample CSV, and GitHub Pages subdirectory paths: passed");
