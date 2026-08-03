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
export const OUT = path.join(ROOT, "e2e-runs", "e2e-live");
export const STATE_FILE = path.join(SCRATCH, "e2e-state.json");
export const LEDGER_FILE = path.join(OUT, "ledger.json");

export const RPC = env("TESTNET_RPC") || "https://eth-rpc-testnet.polkadot.io/";
export const GAS_PRICE_WEI = 1_000_000_000_000n; // 1000 gwei on Paseo AH
// NOT the "canonical" v7 pool 0x3068490C…. Its isKnownRoot panics with
// Panic(0x32) for every non-zero root, so withdraw and proxy_withdraw both
// revert at step 2 and nothing deposited can ever come out. See
// docs/KUSAMA-SHIELD-FINDINGS.md Issue 7.
export const KS_POOL = process.env.SHIELD_POOL || "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";

export function env(k) {
  try {
    const s = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    return (s.match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}

// Every provider ethers hands out starts a block poller, and that timer keeps
// the event loop alive forever. A script whose main() resolved would therefore
// sit there looking like it was still working until something killed it — in CI,
// until the job timed out. Track them so `shutdown()` can stop them.
const _providers = new Set();

export function provider() {
  const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
  _providers.add(p);
  return p;
}

/// Stop the pollers so the process can exit on its own.
export function shutdown() {
  for (const p of _providers) { try { p.destroy(); } catch { /* already gone */ } }
  _providers.clear();
}

/// Standard tail for a live script: run `main`, then leave — successfully, and
/// without waiting on a poller nobody is reading. `onError` keeps whatever
/// bespoke failure handling a script already had (writing a partial report, and
/// so on) and runs BEFORE the exit.
export function runScript(main, onError) {
  main()
    .then(() => { shutdown(); process.exit(0); })
    .catch(async (e) => {
      try { await onError?.(e); } catch { /* reporting must not mask the failure */ }
      shutdown();
      process.exit(1);
    });
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
  // A mined-but-REVERTED transaction is status 0. This used to print the same
  // "✓" as a success and carry on, so a run in which every single call reverted
  // still ended with "✅ complete" — the ledger recorded the truth and nobody
  // read it. Fail loudly instead: an e2e that cannot tell success from failure
  // is worse than no e2e.
  if (rc.status !== 1) {
    console.log(`   ✗ ${action} [${party}] tx ${hash} REVERTED (status ${rc.status}, gas ${gasUsed})`);
    throw new Error(`${action} reverted on-chain (tx ${hash})`);
  }
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

// ── Kusama Shield funding: deposit → prove → proxy_withdraw ──────────────────
// One helper for BOTH native and asset funding, because the two differ only in
// which deposit call is made and which value the note commits to — and getting
// that second part wrong is silent (see below).
//
// A burner funded this way has NO on-chain edge to whoever funded it: the
// deposit names the funder and a commitment, the withdrawal names a recipient
// and a nullifier, and nothing links the two. Transferring to a burner instead
// — which the e2e scripts used to do — hands that link to any observer for free.

/// The pool's ERC-20 precompile address for an Asset Hub asset id, exactly as
/// FixedIlopPhase2Paseo_v7's `getPrecompileAddress` derives it.
///
/// THE TRAP: `depositAsset(assetId, …)` takes the ASSET ID, but the pool credits
/// `escrow[precompileAddress]` and `proxy_withdraw` reads the proof's asset
/// signal straight back as an address. So the NOTE must commit to this ADDRESS.
/// Commit the id and the withdrawal looks up an escrow key that was never
/// credited, reverting "Insufficient balance" while the money sits safely under
/// the address key — an error that names the symptom and hides the cause.
export const ksPrecompileFor = (assetId) => {
  const id = BigInt(assetId);
  if (id === 0n) return 0n; // native
  if (id >= 1n << 64n) throw new Error("assetId too large (pool requires < 2^64)");
  return (id << 128n) | (0x0120n << 16n);
};

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ksRand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
const ksBit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;

const KS_FUND_ABI = [
  "function depositNative(bytes32 commitment) payable",
  // First arg is the ASSET ID, not the address — see ksPrecompileFor.
  "function depositAsset(uint256 assetId, uint256 amount, bytes32 commitment)",
  // `withdraw`, matching the relay. See docs/SHIELDED-POOL-INTEGRATION.md — the
  // forwarder in proxy_withdraw is 96% of a withdrawal's gas and hides nothing.
  "function withdraw(uint[2],uint[2][2],uint[2],uint[8],address)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
];

/// Shield `amount` from `funder` and deliver it to `recipient`, with `submitter`
/// (a relay) paying for the withdrawal so the recipient needs no prior balance.
///
/// `assetId` 0 = native PAS; otherwise an Asset Hub asset (1337 = USDC), which
/// the funder must already hold — the pool pulls it with transferFrom, so this
/// approves first.
///
/// Uses last-leaf path reconstruction: we just inserted, so our leaf is the
/// rightmost and its siblings are exactly the current sideNodes. If another
/// deposit races in between, the root check below fails loudly rather than
/// producing a proof against a tree that has moved.
export async function ksShieldedFund({
  pool, provider, funder, submitter, recipient, amount, assetId = 0,
  poseidon2, snarkjs, wasm, zkey, depositGas = 2_000_000n, withdrawGas = 3_000_000n, log = () => {},
}) {
  const asset = ksPrecompileFor(assetId);
  const value = BigInt(amount);
  const note = { nullifier: ksRand(), secret: ksRand(), value };
  const commitmentOf = (n) =>
    poseidon2([poseidon2([n.value, asset]), poseidon2([n.nullifier, n.secret])]);
  const b32 = (x) => "0x" + x.toString(16).padStart(64, "0");

  const ksW = new ethers.Contract(pool, KS_FUND_ABI, funder);
  const ksR = new ethers.Contract(pool, KS_FUND_ABI, provider);

  let depositTx;
  if (asset === 0n) {
    depositTx = await ksW.depositNative(b32(commitmentOf(note)), {
      value, gasLimit: depositGas, nonce: await provider.getTransactionCount(funder.address, "latest"),
    });
  } else {
    const token = ethers.getAddress("0x" + asset.toString(16).padStart(40, "0"));
    const erc = new ethers.Contract(token,
      ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"], funder);
    if ((await erc.allowance(funder.address, pool)) < value) {
      // NOT MaxUint256: the asset precompile narrows to u128 and reverts
      // "Balance conversion failed" on an unlimited approval.
      // Explicit "latest" nonce: ethers' automatic "pending" nonce makes Paseo
      // answer "could not coalesce error".
      await (await erc.approve(pool, value, {
        gasLimit: 5_000_000n, nonce: await provider.getTransactionCount(funder.address, "latest"),
      })).wait();
    }
    depositTx = await ksW.depositAsset(assetId, value, b32(commitmentOf(note)), {
      gasLimit: depositGas, nonce: await provider.getTransactionCount(funder.address, "latest"),
    });
  }
  await depositTx.wait();
  log(`KS deposit ${depositTx.hash}`);

  const idx = Number(await ksR.treeSize()) - 1;
  const siblings = [];
  for (let lv = 0; lv < 128; lv++) siblings.push(ksBit(idx, lv) ? (await ksR.sideNodes(lv)).toString() : "0");
  let node = commitmentOf(note);
  for (let lv = 0; lv < 128; lv++) if (ksBit(idx, lv)) node = poseidon2([BigInt(siblings[lv]), node]);
  const root = await ksR.currentRoot();
  if (node !== root) throw new Error("KS: our leaf is not the last one (deposit race) — retry");

  const change = { nullifier: ksRand(), secret: ksRand(), value: 0n };
  const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [recipient]))) % BN254_R;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({
    withdrawnValue: value.toString(), treeDepth: "128", context: context.toString(),
    root: root.toString(), asset: asset.toString(), existingValue: value.toString(),
    existingNullifier: note.nullifier.toString(), existingSecret: note.secret.toString(),
    newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(),
    siblings, leafIndex: idx.toString(),
  }, wasm, zkey);

  const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];
  const withdrawTx = await new ethers.Contract(pool, KS_FUND_ABI, submitter).withdraw(
    [proof.pi_a[0], proof.pi_a[1]], pB, [proof.pi_c[0], proof.pi_c[1]], publicSignals, recipient,
    { gasLimit: withdrawGas, nonce: await provider.getTransactionCount(submitter.address, "latest") }
  );
  await withdrawTx.wait();
  log(`KS withdraw ${withdrawTx.hash} → ${recipient}`);
  return { depositHash: depositTx.hash, withdrawHash: withdrawTx.hash, leafIndex: idx, asset };
}
