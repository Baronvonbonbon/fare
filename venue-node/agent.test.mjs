// Replication-agent region logic — single-venue vs hosted super-node (F7). The
// chain scan / pinning need a live chain + Kubo, so this covers the pure pieces:
// parsing home centers and building the region set one box serves. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCenters, regionSetFor, regionOf } from "./agent.mjs";

const SF = { lat: 37_774_900, lon: -122_419_400 };
const NYC = { lat: 40_712_800, lon: -74_006_000 };

test("parseCenters: single venue via HOME_LAT/HOME_LON", () => {
  assert.deepEqual(parseCenters({ HOME_LAT: "37774900", HOME_LON: "-122419400" }), [SF]);
});

test("parseCenters: many venues via HOME_COORDS (hosted super-node)", () => {
  const centers = parseCenters({ HOME_COORDS: "37774900,-122419400; 40712800,-74006000" });
  assert.deepEqual(centers, [SF, NYC]);
});

test("parseCenters: HOME_COORDS wins over HOME_LAT/HOME_LON", () => {
  const centers = parseCenters({ HOME_COORDS: "40712800,-74006000", HOME_LAT: "37774900", HOME_LON: "-122419400" });
  assert.deepEqual(centers, [NYC]);
});

test("parseCenters: malformed pairs are dropped, valid ones kept", () => {
  assert.deepEqual(parseCenters({ HOME_COORDS: "37774900,-122419400; junk; 40712800" }), [SF]);
});

test("parseCenters: nothing configured → empty (agent refuses to boot)", () => {
  assert.deepEqual(parseCenters({}), []);
});

test("regionSetFor: a venue at a center is in that center's region set", () => {
  const set = regionSetFor([SF], 60);
  assert.ok(set.has(regionOf(SF.lat, SF.lon)));
});

test("regionSetFor: super-node union covers every venue's region", () => {
  const one = regionSetFor([SF], 60);
  const many = regionSetFor([SF, NYC], 60);
  assert.ok(many.has(regionOf(SF.lat, SF.lon)));
  assert.ok(many.has(regionOf(NYC.lat, NYC.lon)));
  // NYC's region isn't in the SF-only set, so the union is strictly larger.
  assert.ok(!one.has(regionOf(NYC.lat, NYC.lon)));
  assert.ok(many.size > one.size);
});

test("regionSetFor: overlapping/duplicate centers dedupe (Set union)", () => {
  assert.equal(regionSetFor([SF, SF], 60).size, regionSetFor([SF], 60).size);
});
