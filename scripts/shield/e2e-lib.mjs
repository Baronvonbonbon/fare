// Shared helpers for the live Kusama-Shield-funded FARE e2e (scripts/shield/e2e-*).
// One live delivery, funded through the KS shielded pool, every tx recorded.
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
export const SCRATCH =
  process.env.E2E_SCRATCH ||
  "/tmp/claude-1000/-home-k-Documents-fare/b72267a7-e6ed-4ea1-a42c-ce13603eacaa/scratchpad";
export const OUT = path.join(ROOT, "artifacts", "e2e-live");
export const STATE_FILE = path.join(SCRATCH, "e2e-state.json");
export const LEDGER_FILE = path.join(OUT, "ledger.json");

export const RPC = env("TESTNET_RPC") || "https://eth-rpc-testnet.polkadot.io/";
export const GAS_PRICE_WEI = 1_000_000_000_000n; // 1000 gwei on Paseo AH
export const KS_POOL = process.env.SHIELD_POOL || "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";

export function env(k) {
  try {
    const s = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    return (s.match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}

export function provider() {
  return new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
}

export function book() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
}

export function loadState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
}
export function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── transaction ledger ───────────────────────────────────────────────────────
export function loadLedger() {
  return fs.existsSync(LEDGER_FILE) ? JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) : [];
}
export function appendLedger(entry) {
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const l = loadLedger();
  l.push(entry);
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));
}

// Robust receipt wait for the Paseo eth-rpc (tx.wait can be flaky).
export async function waitTx(prov, hash, label = "", maxWait = 240) {
  for (let i = 0; i < maxWait; i++) {
    const r = await prov.getTransactionReceipt(hash).catch(() => null);
    if (r && r.blockNumber) return r;
    if (i % 15 === 0 && i > 0) console.log(`    …waiting for ${label || hash.slice(0, 12)} (${i}s)`);
    await sleep(1000);
  }
  throw new Error(`timeout waiting for receipt ${hash} (${label})`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Record a mined tx into the ledger, computing the PAS fee actually paid.
export async function record(prov, { step, party, action, via = "direct", value = 0n, hash }) {
  const rc = await waitTx(prov, hash, action);
  const gasUsed = rc.gasUsed ?? 0n;
  // Paseo eth-rpc leaves effectiveGasPrice/gasPrice unset (0/undefined) in
  // receipts, but the chain charges ~1000 gwei (verified against balance deltas).
  // gasUsed is authoritative, so price it at the observed GAS_PRICE_WEI.
  const gasPrice = rc.effectiveGasPrice && rc.effectiveGasPrice > 0n ? rc.effectiveGasPrice : GAS_PRICE_WEI;
  const fee = gasUsed * gasPrice;
  const entry = {
    step,
    party,
    action,
    via,
    from: rc.from,
    to: rc.to,
    valuePAS: ethers.formatEther(value),
    hash,
    block: rc.blockNumber,
    status: rc.status,
    gasUsed: gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    feePAS: ethers.formatEther(fee),
    logs: rc.logs?.length ?? 0,
  };
  appendLedger(entry);
  console.log(
    `   ✓ ${action} [${party}] tx ${hash.slice(0, 12)}… status ${rc.status} gas ${gasUsed} fee ${entry.feePAS} PAS`
  );
  return { rc, entry };
}

// Lean gas for a user/burner tx: estimate then buffer ×3 (reservation stays tiny
// at 1000 gwei, unlike the 500M weight limit the rich deployer/relay use).
export async function leanGas(method, args, overrides = {}) {
  let est;
  try {
    est = await method.estimateGas(...args, overrides);
  } catch (e) {
    est = 3_000_000n;
  }
  let gl = (est * 3n);
  if (gl < 2_000_000n) gl = 2_000_000n;
  if (gl > 40_000_000n) gl = 40_000_000n;
  return gl;
}

export const fmt = (wei) => ethers.formatEther(wei);
export const eth = (s) => ethers.parseEther(s);
