#!/usr/bin/env node
// LIVE Paseo e2e for privacy phase 1 (docs/PRIVACY-TIERS.md §4).
//
// The local e2e (test/privacy-e2e.test.ts) proves the plumbing against a mocked
// pool. Two questions it cannot answer, and this run exists for:
//
//   1. Does the real Kusama Shield pool accept a deposit made BY A CONTRACT?
//      Nothing has ever done that against the live pool — every prior deposit
//      came from an EOA. If it doesn't, the whole batching design is dead.
//   2. Can a batched note actually be spent? The recipient never deposited it
//      and never snapshotted the tree; their path is derived after the fact from
//      the keeper's pre-batch snapshot. A wrong path proves nothing, and the
//      only way to find out is to build a real Groth16 proof and withdraw.
//
// Deploys a STANDALONE FareVault. It does not touch the demo deployment — no
// migration, no re-pointing of live consumers.
//
// Run:  node scripts/privacy/live-e2e.mjs        (from the repo root)
// Env:  DEPLOYER_PRIVATE_KEY (funds everything), SHIELD_POOL, PAYEES, DWELL
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { WITHDRAW_WASM, loadWithdrawZkey } from "../shield/zkey.mjs";
import { createStore, runOnce as keeperTick } from "../../venue-node/shieldkeeper.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const client = await import(pathToFileURL(path.join(ROOT, "web/src/shieldpool.ts")).href);
const { makeNote, commitmentOf, nullifierHashOf, contextFor, batchNotePaths, reconstructPath } = client;

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
// The v7-artifact-matching deployment. The docs' address reverts on deposit —
// see docs/KUSAMA-SHIELD-FINDINGS.md.
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const PAYEES = Number(process.env.PAYEES ?? 4);
// Paseo rejects more than 2 pool deposits in one transaction — at gas far below
// any limit, so it is a proof-size bound EVM gas doesn't express. Because the
// contract consumes tickets FIFO, this ceiling caps the per-batch anonymity set.
const MAX_BATCH = Number(process.env.MAX_BATCH ?? 2);
const MIN_BATCH = Number(process.env.MIN_BATCH ?? 2);
const DWELL = Number(process.env.DWELL ?? 60); // seconds; 5 min in production
const BUCKET = ethers.parseEther("1");
const OUT = path.join(ROOT, "artifacts", "privacy-live");

const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
  "event NewCommitment(bytes32 commitment)",
];

const b32 = (x) => "0x" + x.toString(16).padStart(64, "0");
const log = (...a) => console.log(...a);
const steps = [];
const record = (step, detail) => { steps.push({ step, ...detail }); log(`   ${step}: ${JSON.stringify(detail)}`); };

function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = env.match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error("DEPLOYER_PRIVATE_KEY not set and not in .env");
  return m[1].trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const deployer = new ethers.Wallet(deployerKey(), provider);
  const pool = new ethers.Contract(POOL, POOL_ABI, deployer);

  log(`\nFARE privacy phase 1 — LIVE Paseo run`);
  log(`   deployer ${deployer.address}  ${ethers.formatEther(await provider.getBalance(deployer.address))} PAS`);
  log(`   pool     ${POOL}  treeSize=${await pool.treeSize()}\n`);

  // ── 1. deploy a standalone vault ───────────────────────────────────────────
  log("1. deploying a standalone FareVault (the demo's vault is untouched)");
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/FareVault.sol/FareVault.json"), "utf8"));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
  const vault = await factory.deploy({ gasLimit: 500_000_000n });
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  record("deployed", { vault: vaultAddr, tx: vault.deploymentTransaction().hash });

  // ── 2. configure the shield ────────────────────────────────────────────────
  log("\n2. configuring: pool, 1 PAS bucket, minBatch, dwell, keeper");
  const tx = async (label, p) => { const t = await p; const r = await t.wait(); record(label, { tx: t.hash, gasUsed: String(r.gasUsed) }); return r; };
  await tx("setShieldPool", vault.setShieldPool(POOL, { gasLimit: 100_000_000n }));
  await tx("setShieldBuckets", vault.setShieldBuckets([BUCKET], { gasLimit: 100_000_000n }));
  await tx("setShieldParams", vault.setShieldParams(MIN_BATCH, DWELL, 3600, { gasLimit: 100_000_000n }));
  await tx("setShieldKeeper", vault.setShieldKeeper(deployer.address, true, { gasLimit: 100_000_000n }));
  // The deployer stands in for FareOrders: the only way value enters the vault.
  await tx("setAuthorized", vault.setAuthorized(deployer.address, true, { gasLimit: 100_000_000n }));

  // ── 3. credit payees, then each queues a bucket ────────────────────────────
  log(`\n3. crediting ${PAYEES} payees and queueing ${PAYEES} × 1 PAS`);
  const chainId = (await provider.getNetwork()).chainId;
  const domain = { name: "FareVault", version: "1", chainId, verifyingContract: vaultAddr };
  const types = {
    ShieldCredit: [
      { name: "account", type: "address" },
      { name: "bucket", type: "uint96" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const payees = [];
  const notesFile = path.join(OUT, "notes.json");
  for (let i = 0; i < PAYEES; i++) {
    // Fresh, never-funded keys: they sign, the "relay" (deployer) pays gas —
    // exactly the gasless path a driver uses.
    const w = ethers.Wallet.createRandom();
    const note = makeNote(BUCKET);
    const commitment = b32(commitmentOf(note));

    // Persist the secrets BEFORE anything on-chain spends a ticket against this
    // commitment. A note whose nullifier/secret is lost after its ticket is
    // consumed is unrecoverable — the vault has no admin drain, by design.
    payees.push({ address: w.address, privateKey: w.privateKey, note: { ...note }, commitment });
    fs.writeFileSync(notesFile, JSON.stringify(payees, null, 2));

    await tx(`credit[${i}]`, vault.credit(w.address, { value: BUCKET, gasLimit: 100_000_000n }));
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const signature = await w.signTypedData(domain, types, {
      account: w.address, bucket: BUCKET, nonce: 0, deadline,
    });
    const r = await tx(`queue[${i}]`, vault.queueShieldCreditFor(w.address, BUCKET, deadline, signature, { gasLimit: 100_000_000n }));

    // The invariant, checked against the real chain: the queue transaction must
    // not contain the commitment anywhere.
    const raw = await provider.getTransaction(r.hash);
    const blob = (raw.data + r.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    if (blob.includes(commitment.slice(2).toLowerCase())) throw new Error(`queue tx ${r.hash} leaked a commitment`);

  }
  log(`   buffer ${ethers.formatEther(await vault.shieldBuffer())} PAS · pending ${await vault.shieldPending(BUCKET)}`);

  // ── 4. the keeper batches ──────────────────────────────────────────────────
  log(`\n4. waiting out the ${DWELL}s dwell, then batching`);
  await sleep((DWELL + 5) * 1000);

  const store = createStore(path.join(OUT, "keeper.json"));
  for (const p of payees) store.addPending(BUCKET, p.commitment);

  const poolTreeBefore = Number(await pool.treeSize());
  const batches = [];
  for (let i = 0; i < Math.ceil(PAYEES / MAX_BATCH) + 1; i++) {
    const executed = await keeperTick({
      vault, pool, provider, store, maxBatch: MAX_BATCH,
      submit: (call) => call({ gasLimit: 500_000_000n }),
      log: (m) => log(`   ${m}`),
    });
    if (executed.length === 0) break;
    batches.push(executed[0]);
    record("batch", { tx: executed[0].txHash, count: executed[0].count });
  }
  if (batches.length === 0) throw new Error("keeper produced no batch — see the log above");

  const poolTreeAfter = Number(await pool.treeSize());
  log(`   pool treeSize ${poolTreeBefore} → ${poolTreeAfter}`);
  const landed = batches.reduce((n, b) => n + b.count, 0);
  if (poolTreeAfter - poolTreeBefore < landed) {
    throw new Error(`pool grew by ${poolTreeAfter - poolTreeBefore}, expected ${landed} — the pool rejected contract deposits`);
  }

  // ── 5. a payee derives its own note position and spends it ─────────────────
  log("\n5. deriving a payee's note path and withdrawing it to a fresh address");
  const receipt = store.receiptFor(payees[0].commitment);
  if (!receipt) throw new Error("no batch receipt for the first payee");
  const mine = receipt.commitments.findIndex((c) => c.toLowerCase() === payees[0].commitment.toLowerCase());
  const paths = batchNotePaths(Number(receipt.startIndex), receipt.preSideNodes, receipt.commitments.map((c) => BigInt(c)));
  const { index, leftSnapshot } = paths[mine];
  record("derived", { index, startIndex: receipt.startIndex, replayLen: receipt.commitments.length });

  const rec = {
    ...payees[0].note, index, leftSnapshot, depositBlock: Number(receipt.blockNumber),
  };
  // The same reconstruction the PWA does: snapshot left path + bounded right scan.
  const { siblings, root } = await reconstructPath(provider, POOL, rec);
  record("path", { root: String(root).slice(0, 18) + "…" });

  const recipient = ethers.Wallet.createRandom().address;
  const change = makeNote(0n);
  const input = {
    withdrawnValue: BUCKET.toString(), treeDepth: "128", context: contextFor(recipient).toString(),
    root, asset: "0", existingValue: BUCKET.toString(),
    existingNullifier: rec.nullifier, existingSecret: rec.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    siblings, leafIndex: String(index),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WITHDRAW_WASM, loadWithdrawZkey());
  if (publicSignals[1] !== nullifierHashOf(rec).toString()) throw new Error("nullifierHash mismatch — wrong note");
  record("proof", { nullifierHash: publicSignals[1].slice(0, 18) + "…" });

  const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];
  const before = await provider.getBalance(recipient);
  const wtx = await pool.proxy_withdraw(
    [proof.pi_a[0], proof.pi_a[1]], pB, [proof.pi_c[0], proof.pi_c[1]], publicSignals, recipient,
    { gasLimit: 500_000_000n }
  );
  await wtx.wait();
  const after = await provider.getBalance(recipient);
  record("withdraw", { tx: wtx.hash, recipient, received: ethers.formatEther(after - before) });
  if (after <= before) throw new Error("recipient received nothing — the batched note did not spend");

  // ── report ─────────────────────────────────────────────────────────────────
  const report = {
    ranAt: new Date().toISOString(), rpc: RPC, pool: POOL, vault: vaultAddr,
    payees: PAYEES, bucketPAS: ethers.formatEther(BUCKET), dwellSeconds: DWELL,
    minBatch: MIN_BATCH, maxBatchPerTx: MAX_BATCH,
    batches: batches.map((b) => ({ count: b.count, tx: b.txHash })),
    poolTreeBefore, poolTreeAfter,
    derivedIndex: index, withdrawTx: wtx.hash, recipient,
    receivedPAS: ethers.formatEther(after - before), steps,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  log(`\n✅ contract-originated deposits accepted; a batched note spent to a fresh address`);
  log(`   vault    ${vaultAddr}`);
  log(`   batches  ${batches.length} × ≤${MAX_BATCH} deposits (Paseo per-tx ceiling)`);
  log(`   withdraw ${wtx.hash} → ${recipient} (${ethers.formatEther(after - before)} PAS)`);
  log(`   report   artifacts/privacy-live/report.json\n`);
}

main().catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "failure.json"), JSON.stringify({ error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
