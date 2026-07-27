#!/usr/bin/env node
// Refuse to publish an artifact that carries key material (TEST-PLAN E3).
//
// The live runs write their working state under e2e-runs/, and some of it is
// secret: live-order-e2e.mjs writes actors.json with the customer's and
// driver's PRIVATE KEYS, the relay lab writes relays.json with three funded
// relay keys, and the note files carry nullifiers and salts — the values whose
// whole purpose is that nobody else has them. That directory is gitignored, so
// nothing stops it reaching a CI artifact, and artifacts on a public repository
// are downloadable by anyone.
//
// So the nightly uploads an allowlist, and this checks the allowlist before it
// goes. Usage:
//
//   node scripts/ci/artifact-guard.mjs --self-test        # prove it can see
//   node scripts/ci/artifact-guard.mjs path [path ...]    # then check these
//
// Deliberately keyed on FIELD NAMES rather than value shapes. A private key and
// a transaction hash are both 32 bytes of hex and no regex tells them apart —
// these files are full of legitimate hashes, roots and commitments, so a
// value-shaped matcher would either cry wolf on every report or be tuned until
// it saw nothing. What the writers actually do is name the field.
import fs from "node:fs";
import path from "node:path";

/// Field names that mean "this value is supposed to be secret". Matched
/// case-insensitively against JSON keys at any depth.
/// The separator class matters: these appear as `privateKey` in JSON and as
/// `DEPLOYER_PRIVATE_KEY=` in captured output, and a pattern without it silently
/// misses the second form — which the self-test caught when this was written.
///
/// `nullifier` is excluded when it is `nullifierHash`: the hash is a PUBLIC
/// signal — the vault publishes it to prevent a double-spend — while the bare
/// nullifier is its secret preimage. Flagging the published one would block
/// every legitimate ZK report, which is how a guard gets switched off.
const SECRET_KEYS = /private[_-]?key|mnemonic|pass(word|phrase)|nullifier(?![_-]?hash)|secret|\bsalt\b|seed[_-]?phrase/i;

/// Files known to exist only to hold secrets. Belt and braces: if one of these
/// is ever added to an upload path, say so by name rather than by field.
const DENY_FILENAMES = new Set([
  "actors.json", "relays.json", "note.json", "notes.json", "ks-note.json", "keeper.json",
  ".env", ".dev.vars",
]);

function walk(p, out = []) {
  let st;
  try { st = fs.statSync(p); } catch { return out; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  } else {
    out.push(p);
  }
  return out;
}

/// Every JSON path whose key looks secret. Returns dotted paths, not values —
/// this output goes into a public build log.
function secretFields(value, trail = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => secretFields(v, `${trail}[${i}]`, found));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) found.push(`${trail}.${k}`);
      secretFields(v, `${trail}.${k}`, found);
    }
  }
  return found;
}

function inspect(file) {
  const problems = [];
  if (DENY_FILENAMES.has(path.basename(file))) {
    problems.push("file is known to hold key material");
    return problems; // no need to read it
  }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return problems; }

  if (file.endsWith(".json")) {
    try {
      for (const f of secretFields(JSON.parse(text))) problems.push(`secret field ${f}`);
    } catch {
      // Unparseable JSON gets the text treatment below rather than a pass.
    }
  }
  // Non-JSON (logs, .env-style dumps) still gets a field-name sweep, since the
  // same names appear as `PRIVATE_KEY=` or `"privateKey":` in captured output.
  for (const line of text.split("\n")) {
    if (SECRET_KEYS.test(line) && /[=:]\s*['"]?(0x)?[0-9a-fA-F]{32,}/.test(line)) {
      problems.push("a line names a secret field and carries a long hex value");
      break;
    }
  }
  return problems;
}

/// The control. Zero findings is the healthy state, which is indistinguishable
/// from a broken walker or a regex that matches nothing — so before trusting a
/// clean result, require a dirty one to be caught. This is B2's lesson applied
/// to the thing that decides what leaves the build.
function selfTest() {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || "/tmp", "guard-"));
  const planted = [
    // clean: a tx hash and a PUBLISHED nullifier hash — both 32 bytes of hex,
    // neither secret. If these ever fail, the guard has become unusable rather
    // than strict, and someone will delete the step instead of the finding.
    ["report.json", JSON.stringify({ ok: true, tx: "0x" + "ab".repeat(32), nullifierHash: "0x" + "cd".repeat(32) })],
    ["leaky.json", JSON.stringify({ actors: [{ privateKey: "0x" + "11".repeat(32) }] })], // dirty: nested
    ["actors.json", JSON.stringify({ harmless: 1 })],                                     // dirty: by name
    ["run.log", "DEPLOYER_PRIVATE_KEY=0x" + "22".repeat(32)],                             // dirty: plain text
    ["note.txt", JSON.stringify({ nullifier: "0x" + "33".repeat(32) })],                  // dirty: the preimage
  ];
  for (const [name, body] of planted) fs.writeFileSync(path.join(dir, name), body);

  const results = Object.fromEntries(
    walk(dir).map((f) => [path.basename(f), inspect(f).length])
  );
  fs.rmSync(dir, { recursive: true, force: true });

  // The clean file must be exactly clean; the dirty ones need at least one
  // finding each. Not "exactly one" — a planted key trips both the field sweep
  // and the text sweep, and pinning the count would make the control fail
  // whenever the guard got better.
  const bad = [];
  if (results["report.json"] !== 0) bad.push(`report.json: expected 0 findings, got ${results["report.json"]}`);
  for (const f of ["leaky.json", "actors.json", "run.log", "note.txt"]) {
    if (!(results[f] > 0)) bad.push(`${f}: planted secret NOT caught`);
  }
  if (bad.length) {
    console.error("✗ artifact guard self-test FAILED — the guard cannot see what it claims to:");
    for (const b of bad) console.error(`   ${b}`);
    process.exit(2);
  }
  console.log("✓ artifact guard self-test passed (4 planted secrets caught; tx hash and nullifierHash passed)");
}

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  selfTest();
  process.exit(0);
}
if (!args.length) {
  console.error("usage: artifact-guard.mjs [--self-test] <path> [path ...]");
  process.exit(2);
}

selfTest(); // always, before trusting a clean sweep

let failures = 0;
let scanned = 0;
for (const target of args) {
  for (const file of walk(target)) {
    scanned++;
    const problems = inspect(file);
    for (const p of problems) {
      console.error(`✗ ${file}: ${p}`);
      failures++;
    }
  }
}

if (!scanned) {
  console.log("no files matched — nothing to upload, nothing to leak");
} else if (failures) {
  console.error(`\n${failures} problem(s) across ${scanned} file(s). Refusing to publish.`);
  process.exit(1);
} else {
  console.log(`✓ ${scanned} file(s) clean`);
}
