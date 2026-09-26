"use strict";

const assert = require("node:assert/strict");
const {estimateNr, designNr, formedNr, sumKnown, factorySummary, fitBounds, matchesTyreType} = require("../site/assets/capacity.js");
const model = {kg_per_tire: {"PCR/LTR": 2.1327, TBR: 22.5510}};

assert.equal(estimateNr({type: "PCR/LTR", output_2025_wan: 100}, model).tons, 2132.7);
assert.equal(estimateNr({type: "TBR", formed_capacity_2025: 100, utilization_2025_pct: 80, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "TBR", design_capacity: 100, capacity_unit: "万条/年"}, model), 22551);
assert.equal(formedNr({type: "TBR", formed_capacity: 80, capacity_unit: "万条/年"}, model), 18040.8);
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
assert.equal(summary.designNr.value, (150 * 2.1327 + 10 * 22.551) * 10);
assert.equal(summary.actualNr.known, 1);
assert.equal(summary.actualEstimated, true);
assert.equal(factorySummary({lines: []}, model).actualNr.value, null);
assert.equal(factorySummary({lines: [{type: "TBR", design_capacity: 100, formed_capacity: 80, formed_capacity_approximate: true, capacity_unit: "万条/年"}]}, model).types.TBR.formed.value, null);
const bounds = fitBounds([{latitude: null, longitude: null}, {latitude: 35, longitude: 110}]);
assert.equal(bounds.west, 108);
assert.equal(bounds.east, 112);
assert.ok(fitBounds([]).west < 0);
const historical = {lines: [{type: "OTHER"}], survey_observations: [{comparable_type: "PCR/LTR"}]};
assert.equal(matchesTyreType(historical, "PCR/LTR"), true);
assert.equal(matchesTyreType(historical, "TBR"), false);
assert.equal(matchesTyreType({lines: []}, "all"), true);
