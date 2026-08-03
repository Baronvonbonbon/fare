// Aggregate the live e2e ledgers into a per-action and per-role cost table.
//
// The numbers here are PASEO (PolkaVM) receipts, not the EVM figures in
// gas-snapshot.json. The two are not the same unit and must not be added: the
// hardhat suite measures EVM gas on a local node, while pallet-revive meters a
// PolkaVM execution — a dropoff is ~214k in gas-snapshot.json and ~20M on
// Paseo. Only receipts tell you what a delivery actually costs.
//
// Usage: node scripts/cost-report.mjs [--json] [--book <addresses.json>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAS_PRICE_WEI = 1_000_000_000_000n; // 1000 gwei, Paseo Asset Hub
const asJson = process.argv.includes("--json");

const BOOK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
const CURRENT = new Set(Object.values(BOOK).map((a) => String(a).toLowerCase()));

/// Which ledgers describe the deployment we run today? A ledger whose `to`
/// addresses are all strangers is describing a torn-down deployment, and
/// averaging it into today's costs would be quietly wrong.
function relevance(rows) {
  const tos = rows.map((r) => String(r.to || "").toLowerCase()).filter(Boolean);
  const hits = tos.filter((t) => CURRENT.has(t)).length;
  return tos.length ? hits / tos.length : 0;
}

const ledgers = [];
for (const dir of fs.readdirSync(path.join(ROOT, "e2e-runs"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const f = path.join(ROOT, "e2e-runs", dir.name, "ledger.json");
  if (!fs.existsSync(f)) continue;
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.entries ?? raw.steps ?? [];
  ledgers.push({ name: dir.name, rows, rel: relevance(rows) });
}

const fmtPas = (wei) => Number(ethers.formatEther(wei)).toFixed(6);
const num = (x) => (x === undefined || x === null || x === "" ? 0n : BigInt(x));

// ── per action ───────────────────────────────────────────────────────────────
const byAction = new Map();
const byParty = new Map();
let skipped = 0;

for (const { rows, rel } of ledgers) {
  if (rel < 0.5) { skipped += rows.length; continue; } // stale deployment
  for (const r of rows) {
    const gas = num(r.gasUsed);
    if (gas === 0n) continue; // no receipt recorded (off-chain step)
    const feeWei = r.feePAS ? ethers.parseEther(String(r.feePAS)) : gas * GAS_PRICE_WEI;

    const a = byAction.get(r.action) ?? { action: r.action, n: 0, gas: [], fee: 0n };
    a.n++; a.gas.push(gas); a.fee += feeWei;
    byAction.set(r.action, a);

    const p = byParty.get(r.party) ?? { party: r.party, n: 0, fee: 0n, actions: new Set() };
    p.n++; p.fee += feeWei; p.actions.add(r.action);
    byParty.set(r.party, p);
  }
}

const med = (xs) => { const s = [...xs].sort((x, y) => (x < y ? -1 : 1)); return s[Math.floor(s.length / 2)]; };

const actions = [...byAction.values()]
  .map((a) => ({ action: a.action, n: a.n, medianGas: med(a.gas), avgFeePAS: fmtPas(a.fee / BigInt(a.n)) }))
  .sort((x, y) => Number(y.medianGas - x.medianGas));

const parties = [...byParty.values()]
  .map((p) => ({ party: p.party, txs: p.n, totalPAS: fmtPas(p.fee), actions: [...p.actions].length }))
  .sort((x, y) => Number(y.totalPAS) - Number(x.totalPAS));

if (asJson) {
  console.log(JSON.stringify({ gasPriceGwei: 1000, actions, parties,
    ledgers: ledgers.map((l) => ({ name: l.name, rows: l.rows.length, relevance: l.rel })) }, null, 2));
} else {
  console.log(`\nLIVE PASEO COSTS  (gas price ${Number(GAS_PRICE_WEI) / 1e9} gwei)\n`);
  console.log("ledgers used:");
  for (const l of ledgers) {
    console.log(`  ${l.rel >= 0.5 ? "✓" : "✗"} ${l.name.padEnd(20)} ${String(l.rows.length).padStart(3)} rows  ` +
      `${(l.rel * 100).toFixed(0)}% on current contracts${l.rel < 0.5 ? "  (SKIPPED — stale deployment)" : ""}`);
  }
  if (skipped) console.log(`  ${skipped} rows skipped as stale\n`);

  console.log("\nPER ACTION");
  console.log("action".padEnd(42) + "n".padStart(4) + "median gas".padStart(14) + "avg fee (PAS)".padStart(16));
  console.log("-".repeat(76));
  for (const a of actions) {
    console.log(String(a.action).slice(0, 41).padEnd(42) + String(a.n).padStart(4) +
      a.medianGas.toLocaleString("en-US").padStart(14) + a.avgFeePAS.padStart(16));
  }

  console.log("\nPER ROLE (who actually paid)");
  console.log("role".padEnd(28) + "txs".padStart(5) + "distinct actions".padStart(18) + "total gas (PAS)".padStart(18));
  console.log("-".repeat(69));
  for (const p of parties) {
    console.log(String(p.party).slice(0, 27).padEnd(28) + String(p.txs).padStart(5) +
      String(p.actions).padStart(18) + p.totalPAS.padStart(18));
  }
  const total = parties.reduce((s, p) => s + Number(p.totalPAS), 0);
  console.log("-".repeat(69));
  console.log("TOTAL".padEnd(28) + String(parties.reduce((s, p) => s + p.txs, 0)).padStart(5) +
    "".padStart(18) + total.toFixed(6).padStart(18));
  console.log();
}
