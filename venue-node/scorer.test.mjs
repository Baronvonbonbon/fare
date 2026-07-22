// DA scorer math (F5) — the pure scoring/blending logic. The network challenge
// round needs live nodes, so it isn't unit-tested here; this covers the parts
// that decide a node's published score. Run: npm test  (node --test, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreOf, decayReports, sameBytes, leaderboard, recordReport, state } from "./scorer.mjs";

test("sameBytes: exact match only", () => {
  assert.equal(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test("scoreOf: challenge-only when there are no client reports", () => {
  const st = state("https://a.example/");
  st.challenge = 0.8;
  assert.equal(scoreOf(st), 0.8);
});

test("scoreOf: client-only when there is no challenge yet", () => {
  const st = state("https://b.example/");
  st.challenge = null;
  recordReport("https://b.example/", true);
  recordReport("https://b.example/", true);
  recordReport("https://b.example/", false);
  // 2/3 good, no challenge → equals the client score
  assert.ok(Math.abs(scoreOf(st) - 2 / 3) < 1e-9);
});

test("scoreOf: blends challenge and client at CHALLENGE_WEIGHT (0.7 default)", () => {
  const st = state("https://c.example/");
  st.challenge = 1.0;
  recordReport("https://c.example/", false); // client score 0/1 = 0
  // 0.7*1 + 0.3*0 = 0.7
  assert.ok(Math.abs(scoreOf(st) - 0.7) < 1e-9);
});

test("scoreOf: null when neither signal exists", () => {
  const st = state("https://d.example/");
  st.challenge = null;
  assert.equal(scoreOf(st), null);
});

test("decayReports: totals halve after one half-life", () => {
  const r = { good: 8, total: 10, at: Date.now() - 3_600_000 }; // default half-life = 1h
  decayReports(r);
  assert.ok(Math.abs(r.total - 5) < 0.05);
  assert.ok(Math.abs(r.good - 4) < 0.05);
});

test("leaderboard: sorts by score descending, unscored nodes last", () => {
  state("https://high.example/").challenge = 0.9;
  state("https://low.example/").challenge = 0.2;
  state("https://none.example/").challenge = null; // no signal → null score, sorts last
  const board = leaderboard();
  const scored = board.nodes.filter((n) => n.score !== null).map((n) => n.node);
  const highIdx = scored.indexOf("https://high.example/");
  const lowIdx = scored.indexOf("https://low.example/");
  assert.ok(highIdx < lowIdx, "higher score ranks first");
  assert.equal(board.nodes[board.nodes.length - 1].score, null, "unscored node is last");
  assert.equal(board.kind, "fare-da-leaderboard");
});
