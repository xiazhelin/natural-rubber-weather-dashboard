"use strict";

const assert = require("node:assert/strict");
const {coords, mapViewBox, adjustMapView, fitBounds} = require("../site/assets/capacity.js");
const bounds = fitBounds([{latitude: 11, longitude: 104}, {latitude: 13, longitude: 106}]);
const a = coords({latitude: 12, longitude: 104}, bounds, 920, 460);
const b = coords({latitude: 12, longitude: 105}, bounds, 920, 460);
const c = coords({latitude: 13, longitude: 104}, bounds, 920, 460);
// Mercator x/y share one scale: one degree north is only slightly longer here.
assert.ok((a.y - c.y) / (b.x - a.x) > 1);
assert.ok((a.y - c.y) / (b.x - a.x) < 1.1);
const tall = {west: 100, east: 102, south: 0, north: 50};
const left = coords({latitude: 25, longitude: 100}, tall, 920, 460);
const right = coords({latitude: 25, longitude: 102}, tall, 920, 460);
assert.ok(right.x - left.x < 30); // A narrow country cannot stretch across the whole map.
const view = {zoom: 1, x: 0, y: 0};
assert.equal(mapViewBox(view), "0 0 920 460");
adjustMapView(view, "in");
assert.equal(mapViewBox(view), "230 115 460 230");
adjustMapView(view, "left");
adjustMapView(view, "up");
assert.equal(view.x, -92);
assert.equal(view.y, -46);
for (let i = 0; i < 20; i++) adjustMapView(view, "in");
assert.equal(view.zoom, 16);
for (let i = 0; i < 20; i++) adjustMapView(view, "out");
assert.equal(view.zoom, .25);
adjustMapView(view, "reset");
assert.deepEqual(view, {zoom: 1, x: 0, y: 0});
const otherMap = {zoom: 1, x: 0, y: 0};
adjustMapView(view, "right");
assert.deepEqual(otherMap, {zoom: 1, x: 0, y: 0});
const [, , width, height] = mapViewBox(view).split(" ").map(Number);
assert.equal(width / height, 2);
console.log("capacity map projection, zoom, pan and reset checks passed");
