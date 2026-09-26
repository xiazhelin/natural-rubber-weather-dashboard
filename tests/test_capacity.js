"use strict";

const assert = require("node:assert/strict");
const {estimateNr, designNr, formedNr} = require("../site/assets/capacity.js");
const model = {kg_per_tire: {"PCR/LTR": 2.1327, TBR: 22.5510}};

assert.equal(estimateNr({type: "PCR/LTR", output_2025_wan: 100}, model).tons, 2132.7);
assert.equal(estimateNr({type: "TBR", formed_capacity_2025: 100, utilization_2025_pct: 80, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "TBR", design_capacity: 100, capacity_unit: "万条/年"}, model), 22551);
assert.equal(formedNr({type: "TBR", formed_capacity: 80, capacity_unit: "万条/年"}, model), 18040.8);
assert.equal(formedNr({type: "TBR", formed_capacity: null, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "TBR", design_capacity: 100, capacity_approximate: true, capacity_unit: "万条/年"}, model), null);
assert.equal(designNr({type: "OTR", design_capacity: 10, capacity_unit: "万吨轮胎/年"}, model), null);
