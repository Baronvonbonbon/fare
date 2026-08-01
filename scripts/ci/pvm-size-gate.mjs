#!/usr/bin/env node
// Gate PolkaVM blob sizes, the same way gas-snapshot.json gates gas.
//
//   node scripts/ci/pvm-size-gate.mjs [pvm-size-snapshot.json]
//
// Two things it catches, and they fail differently on purpose:
//
//   HARD  a blob over pallet-revive's 256 KiB limit — that contract cannot be
//         deployed at all ("BlobTooLarge"), so this is a build break.
//   SOFT  a blob that grew more than the drift budget against the committed
//         snapshot. PVM blobs run ~8-10x the EVM bytecode, so headroom
//         disappears faster than it does under EIP-170 and is worth watching
//         before it becomes a wall.
//
// Regenerate the snapshot deliberately with `npm run build:pvm -- --snapshot`,
// so a size increase is a diff somebody justifies rather than a silent creep.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "artifacts-pvm");
const BLOB_LIMIT = 256 * 1024;

// Percentage points of the limit a contract may drift before the gate trips.
// Sized so ordinary refactors pass and a structural change does not.
const DRIFT_BUDGET_PCT = 5;

const snapshotPath = process.argv[2] ?? path.join(ROOT, "pvm-size-snapshot.json");

if (!fs.existsSync(snapshotPath)) {
  console.error(`✗ no size snapshot at ${snapshotPath}`);
  console.error("  Create one: npm run build:pvm -- --snapshot");
  process.exit(2);
}
if (!fs.existsSync(OUT_DIR)) {
  console.error(`✗ no PVM artifacts at ${path.relative(ROOT, OUT_DIR)}`);
  console.error("  Build them first: npm run build:pvm");
  process.exit(2);
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const pct = (n) => (100 * n) / BLOB_LIMIT;

let over = 0;
let drifted = 0;
let missing = 0;

console.log(`PolkaVM blob sizes (limit ${BLOB_LIMIT} bytes, drift budget ${DRIFT_BUDGET_PCT} pts)\n`);

for (const [name, was] of Object.entries(snapshot)) {
  const artifact = path.join(OUT_DIR, `${name}.json`);
  if (!fs.existsSync(artifact)) {
    console.error(`  ${name.padEnd(24)} MISSING — not built`);
    missing++;
    continue;
  }
  const now = JSON.parse(fs.readFileSync(artifact, "utf8")).bytes;
  const delta = now - was;
  const driftPts = pct(now) - pct(was);

  let flag = "";
  if (now > BLOB_LIMIT) {
    flag = "  ✗ OVER 256 KiB — undeployable";
    over++;
  } else if (driftPts > DRIFT_BUDGET_PCT) {
    flag = `  ✗ grew ${driftPts.toFixed(1)} pts`;
    drifted++;
  }

  const sign = delta > 0 ? "+" : "";
  console.log(
    `  ${name.padEnd(24)} ${String(now).padStart(7)}  ${pct(now).toFixed(1).padStart(5)}%` +
      `  ${delta === 0 ? "     —" : (sign + delta).padStart(6)}${flag}`,
  );
}

// A contract present on disk but absent from the snapshot is un-gated, which is
// how a new contract quietly escapes the check.
for (const f of fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"))) {
  const name = path.basename(f, ".json");
  if (!(name in snapshot)) {
    console.error(`  ${name.padEnd(24)} not in the snapshot — add it`);
    missing++;
  }
}

console.log();
if (over) {
  console.error(`✗ ${over} blob(s) exceed pallet-revive's ${BLOB_LIMIT}-byte limit`);
  process.exit(1);
}
if (missing) {
  console.error(`✗ ${missing} contract(s) out of sync with the snapshot`);
  process.exit(1);
}
if (drifted) {
  console.error(`✗ ${drifted} blob(s) grew past the drift budget`);
  console.error("  If the growth is intended: npm run build:pvm -- --snapshot");
  process.exit(1);
}
console.log("✓ all blobs within the limit and the drift budget");
