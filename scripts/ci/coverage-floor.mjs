#!/usr/bin/env node
// Enforce a coverage floor on an Istanbul json-summary (TEST-PLAN E2).
//
// solidity-coverage has no threshold option of its own — it prints a table and
// exits 0 whatever the numbers say — so the ratchet has to live here. Vitest
// does its own floors in web/vite.config.ts; this is the contract tier.
//
//   node scripts/ci/coverage-floor.mjs coverage/coverage-summary.json coverage-floor.json
//
// The floors are committed in coverage-floor.json, so lowering one is a diff
// somebody has to justify in review rather than a flag someone quietly passes.
import fs from "node:fs";

const [summaryPath, floorPath] = process.argv.slice(2);
if (!summaryPath || !floorPath) {
  console.error("usage: coverage-floor.mjs <coverage-summary.json> <coverage-floor.json>");
  process.exit(2);
}

const read = (p, what) => {
  if (!fs.existsSync(p)) {
    console.error(`✗ no ${what} at ${p}`);
    if (p === summaryPath) {
      console.error("  Did the coverage run finish? It needs a raised heap:");
      console.error("  NODE_OPTIONS=--max-old-space-size=6144 npx hardhat coverage");
    }
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

const summary = read(summaryPath, "coverage summary");
const floors = read(floorPath, "floor file");
const total = summary.total;
if (!total) {
  console.error(`✗ ${summaryPath} has no \`total\` — is it an Istanbul json-summary?`);
  process.exit(2);
}

const METRICS = ["statements", "branches", "functions", "lines"];
let failed = 0;
const rows = [];

for (const m of METRICS) {
  const got = total[m]?.pct;
  const floor = floors[m];
  if (typeof floor !== "number") continue; // an unset metric is deliberately unpinned
  if (typeof got !== "number") {
    console.error(`✗ ${m}: not reported`);
    failed++;
    continue;
  }
  const ok = got >= floor;
  if (!ok) failed++;
  rows.push({ m, got, floor, ok, covered: total[m].covered, of: total[m].total });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\ncoverage vs floor (${summaryPath})\n`);
for (const r of rows) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${pad(r.m, 11)} ${String(r.got.toFixed(2)).padStart(6)}%  `
    + `floor ${String(r.floor).padStart(5)}%   (${r.covered}/${r.of})`);
}

// Drifting UP without raising the floor is the normal, healthy case — but it is
// worth saying, because a floor left far below reality stops being a ratchet.
const slack = rows.filter((r) => r.ok && r.got - r.floor >= 5);
if (slack.length) {
  console.log(`\n  note: ${slack.map((r) => r.m).join(", ")} now exceed${slack.length === 1 ? "s" : ""} `
    + `the floor by ≥5 points — consider raising ${floorPath} so the ratchet keeps its grip.`);
}

if (failed) {
  console.error(`\n✗ ${failed} metric(s) below floor. Coverage went backwards.`);
  console.error("  Raise the tests, not the floor.");
  process.exit(1);
}
console.log("\n✓ all pinned metrics at or above their floor");
