"use strict";

const assert = require("node:assert/strict");
const {estimateNr, designNr, formedNr, sumKnown, factorySummary, fitBounds, matchesTyreType, aggregateNr, sumRanges} = require("../site/assets/capacity.js");
const model = {kg_per_tire_range: {"PCR/LTR": [2.6, 3.0], TBR: [22, 23]}};

assert.deepEqual(estimateNr({type: "PCR/LTR", output_2025_wan: 100}, model), {low: 2600, high: 3000, kind: "ESTIMATE · 产量×单耗区间"});
assert.equal(estimateNr({type: "TBR", formed_capacity_2025: 100, utilization_2025_pct: 80, capacity_unit: "万条/年"}, model), null);
assert.deepEqual(designNr({type: "TBR", design_capacity: 100, capacity_unit: "万条/年"}, model), {low: 22000, high: 23000});
assert.deepEqual(formedNr({type: "TBR", formed_capacity: 80, capacity_unit: "万条/年"}, model), {low: 17600, high: 18400});
assert.equal(formedNr({type: "TBR", formed_capacity: null, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "TBR", design_capacity: 100, capacity_approximate: true, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "OTR", design_capacity: 10, capacity_unit: "万吨轮胎/年"}, model), null);
assert.deepEqual(sumKnown([null, undefined]), {value: null, known: 0, total: 2});
assert.deepEqual(sumKnown([0, 100, null]), {value: 100, known: 2, total: 3});
const summary = factorySummary({lines: [
  {type: "PCR/LTR", design_capacity: 100, formed_capacity: 80, output_2025_wan: 70, capacity_unit: "万条/年"},
  {type: "PCR/LTR", design_capacity: 50, formed_capacity: null, capacity_unit: "万条/年"},
  {type: "PCR/LTR", design_capacity: 10000, capacity_unit: "条/日"},
  {type: "TBR", design_capacity: 10, formed_capacity: 10, capacity_unit: "万条/年"},
  {type: "OTR", design_capacity: 20, capacity_unit: "万吨轮胎/年"}
]}, model);
assert.equal(summary.types["PCR/LTR"].design.value, 150);
assert.equal(summary.types["PCR/LTR"].formed.value, 80);
assert.equal(summary.types["PCR/LTR"].design.known, 2);
assert.equal(summary.types["PCR/LTR"].otherUnits.length, 1);
assert.equal(summary.types.TBR.design.value, 10);
assert.equal(summary.designNr.low, 6100);
assert.equal(summary.designNr.high, 6800);
assert.equal(summary.actualNr.known, 1);
assert.equal(summary.actualEstimated, true);
assert.equal(factorySummary({lines: []}, model).actualNr.low, null);
assert.equal(factorySummary({lines: [{type: "TBR", design_capacity: 100, formed_capacity: 80, formed_capacity_approximate: true, capacity_unit: "万条/年"}]}, model).types.TBR.formed.value, null);
const bounds = fitBounds([{latitude: null, longitude: null}, {latitude: 35, longitude: 110}]);
assert.equal(bounds.west, 108);
assert.equal(bounds.east, 112);
assert.ok(fitBounds([]).west < 0);
const historical = {lines: [{type: "OTHER"}], survey_observations: [{comparable_type: "PCR/LTR"}]};
assert.equal(matchesTyreType(historical, "PCR/LTR"), true);
assert.equal(matchesTyreType(historical, "TBR"), false);
assert.equal(matchesTyreType({lines: []}, "all"), true);

assert.deepEqual(sumRanges([null]), {low: null, high: null, known: 0, total: 1});
assert.deepEqual(estimateNr({actual_nr_2025_t: 100}, model), {low: 100, high: 100, kind: "FACT · 企业披露"});
const annual = {comparable_type: "PCR/LTR", unit: "u/y", value: 1000000};
const daily = {comparable_type: "PCR/LTR", unit: "u/d", value: 1000};
const factory = (id, status, lines = [], survey_observations = []) => ({id, status, lines, survey_observations, source_ids: []});
const line = {type: "PCR/LTR", capacity_unit: "万条/年", design_capacity: 120, formed_capacity: 100};
const sample = [
  factory("active", "OPERATING", [line], [annual]),
  factory("history", "UNKNOWN", [], [annual]),
  factory("daily", "UNKNOWN", [], [daily]),
  factory("planned", "PLANNED", [{...line, formed_capacity: null}]),
  factory("closed", "CLOSED", [line], [annual]),
  factory("mixed", "UNKNOWN", [], [{...annual, comparable_type: "OTHER"}])
];
const totals = aggregateNr(sample, model);
assert.equal(totals.formed.low, 2600);
assert.equal(totals.historical.low, 2600);
assert.equal(totals.combined.low, 5200);
assert.equal(totals.pipeline.low, 3640); // 20 gap + 120 future; not added to 5200.
assert.equal(totals.coveredFactories, 2);
assert.equal(totals.excluded.overlap, 1);
assert.equal(totals.excluded.closed, 1);
assert.equal(totals.excluded.daily, 1);
assert.equal(totals.excluded.mixed, 1);
const withDays = aggregateNr(sample, model, {days: 330, loadPct: 80});
assert.equal(withDays.combined.low, 6058);
assert.ok(Math.abs(withDays.scenario.low - 4846.4) < 0.0001);
assert.equal(aggregateNr([], model).combined.low, null);
assert.equal(aggregateNr(sample, model, {loadPct: 0}).scenario.low, 0);
assert.throws(() => aggregateNr(sample, model, {days: -1}));
assert.throws(() => aggregateNr(sample, model, {days: NaN}));
assert.throws(() => aggregateNr(sample, model, {loadPct: 110}));
assert.equal(aggregateNr([factory("duplicate-history", "UNKNOWN", [], [annual, annual])], model).combined.low, null);
assert.equal(aggregateNr([{...factory("failed", "OPERATING", [line]), quality: "FAIL"}], model).combined.low, null);
assert.equal(aggregateNr([factory("failed-line", "OPERATING", [{...line, quality: "FAIL"}])], model).combined.low, null);
assert.equal(aggregateNr([factory("failed-history", "UNKNOWN", [], [{...annual, quality: "FAIL"}])], model).combined.low, null);
assert.equal(factorySummary({...factory("failed-summary", "OPERATING", [line]), quality: "FAIL"}, model).formedNr.low, null);
const dailyLine = factory("new-daily", "OPERATING", [{...line, capacity_unit: "条/日", formed_capacity: 1000}], [annual]);
assert.equal(aggregateNr([dailyLine], model).combined.low, null);
assert.equal(aggregateNr([dailyLine], model).excluded.daily, 1);
assert.equal(aggregateNr([dailyLine], model).excluded.overlap, 1);
assert.equal(aggregateNr([dailyLine], model, {days: 330}).formed.low, 858);
assert.equal(aggregateNr([dailyLine], model, {days: 330}).historical.low, null);
require("./test_capacity_map.js");
