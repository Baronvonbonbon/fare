#!/usr/bin/env node
// LIVE Paseo run for privacy phase 3 (docs/PRIVACY-TIERS.md §7).
//
// The local suite proves the cryptography with a mocked pool and a Solidity
// Poseidon. Two things only the real chain can answer, and both are the same
// class of surprise that capped phase 1 at 2-anonymity:
//
//   1. Does a note insert fit? It makes 16 calls to Paseo's PVM-native
//      PoseidonT3 precompile. Paseo's binding limit is proof size, which EVM gas
//      does not express — 3 pool deposits already fail at ~40 k gas.
//   2. Does a spend fit? It runs a Groth16 pairing AND a pool deposit in one
//      transaction, which is strictly more than the deposit that already
//      constrains us.
//
// Deploys a STANDALONE FareVault + verifier. The demo deployment is untouched.
//
// Run:  node scripts/privacy/live-zk.mjs
// Env:  DEPLOYER_PRIVATE_KEY, SHIELD_POOL, POSEIDON, NOTES
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { WITHDRAW_WASM, loadWithdrawZkey } from "../shield/zkey.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ks = await import(pathToFileURL(path.join(ROOT, "web/src/shieldpool.ts")).href);

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
// Paseo's PVM-native Poseidon — the thing that makes on-chain Merkle affordable.
const POSEIDON = process.env.POSEIDON ?? "0x1d165f6fE5A30422E0E2140e91C8A9B800380637";
const NOTES = Number(process.env.NOTES ?? 4);
const BUCKET = ethers.parseEther("1");
const DEPTH = 16;
const OUT = path.join(ROOT, "e2e-runs", "privacy-zk");

const WASM = path.join(ROOT, "circuits/build/shieldnote_js/shieldnote.wasm");
const ZKEY = path.join(ROOT, "circuits/build/shieldnote.zkey");
const VK = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits/build/setShieldVK-calldata.json"), "utf8"));

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
const steps = [];
const log = (...a) => console.log(...a);
const record = (step, detail) => { steps.push({ step, ...detail }); log(`   ${step}: ${JSON.stringify(detail)}`); };

const zeros = (() => { const z = [0n]; for (let i = 1; i <= DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]])); return z; })();
const noteCommitment = (n, s, b) => poseidon2([poseidon2([n, s]), b]);
const randField = () => ethers.toBigInt(ethers.randomBytes(31));

class NoteTree {
  constructor(leaves = []) { this.leaves = leaves; this.memo = new Map(); }
  insert(leaf) { this.leaves.push(leaf); this.memo.clear(); }
  node(level, index) {
    if (index * 2 ** level >= this.leaves.length) return zeros[level];
    if (level === 0) return this.leaves[index];
    const k = `${level}:${index}`;
    if (this.memo.has(k)) return this.memo.get(k);
    const v = poseidon2([this.node(level - 1, index * 2), this.node(level - 1, index * 2 + 1)]);
    this.memo.set(k, v); return v;
  }
  root() { return this.node(DEPTH, 0); }
  path(index) {
    const elements = [], indices = [];
    let idx = index;
    for (let lv = 0; lv < DEPTH; lv++) {
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  return env.match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m)[1].trim();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const deployer = new ethers.Wallet(deployerKey(), provider);
  const pool = new ethers.Contract(POOL, POOL_ABI, deployer);

  log(`\nFARE privacy phase 3 — LIVE Paseo run`);
  log(`   deployer ${deployer.address}  ${ethers.formatEther(await provider.getBalance(deployer.address))} PAS`);
  log(`   poseidon ${POSEIDON}`);
  log(`   pool     ${POOL}  treeSize=${await pool.treeSize()}\n`);

  // Sanity-check the precompile before building anything on it.
  const pos = new ethers.Contract(POSEIDON, ["function hash(uint256[2]) view returns (uint256)"], provider);
  const onChainHash = await pos.hash([1n, 2n]);
  const localHash = poseidon2([1n, 2n]);
  log(`1. PoseidonT3 precompile: hash(1,2) on-chain == poseidon-lite? ${onChainHash === localHash}`);
  if (onChainHash !== localHash) throw new Error("Poseidon precompile disagrees with poseidon-lite — the tree could never match");

  // ── deploy + wire ──────────────────────────────────────────────────────────
  log("\n2. deploying a standalone FareVault + FareShieldVerifier");
  const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `artifacts/contracts/${n}.sol/${n}.json`), "utf8"));
  const vaultArt = art("FareVault"), verArt = art("FareShieldVerifier");
  const vault = await new ethers.ContractFactory(vaultArt.abi, vaultArt.bytecode, deployer).deploy({ gasLimit: 500_000_000n });
  await vault.waitForDeployment();
  const verifier = await new ethers.ContractFactory(verArt.abi, verArt.bytecode, deployer).deploy({ gasLimit: 500_000_000n });
  await verifier.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  record("deployed", { vault: vaultAddr, verifier: await verifier.getAddress() });

  const tx = async (label, p) => { const t = await p; const r = await t.wait(); record(label, { tx: t.hash, gasUsed: String(r.gasUsed) }); return r; };
  await tx("setVerifyingKey", verifier.setVerifyingKey(VK.alpha1, VK.beta2, VK.gamma2, VK.delta2, VK.IC0, VK.IC1, VK.IC2, VK.IC3, VK.IC4, { gasLimit: 500_000_000n }));
  await tx("setShieldPool", vault.setShieldPool(POOL, { gasLimit: 100_000_000n }));
  await tx("setShieldBuckets", vault.setShieldBuckets([BUCKET], { gasLimit: 100_000_000n }));
  await tx("setAuthorized", vault.setAuthorized(deployer.address, true, { gasLimit: 100_000_000n }));
  // 16 Poseidon precompile calls — the first live unknown.
  await tx("setShieldPoseidon", vault.setShieldPoseidon(POSEIDON, { gasLimit: 500_000_000n }));
  await tx("setShieldVerifier", vault.setShieldVerifier(await verifier.getAddress(), { gasLimit: 100_000_000n }));

  const emptyRoot = await vault.noteRoot();
  if (emptyRoot !== new NoteTree().root()) throw new Error("empty-tree root disagrees with the client");
  log("   ✓ empty-tree root matches the client");

  // ── insert notes ───────────────────────────────────────────────────────────
  log(`\n3. inserting ${NOTES} notes (16 Poseidon precompile calls each)`);
  const tree = new NoteTree();
  const notes = [];
  const notesFile = path.join(OUT, "notes.json");
  for (let i = 0; i < NOTES; i++) {
    const note = { nullifier: randField().toString(), secret: randField().toString(), bucket: BUCKET.toString() };
    const commitment = noteCommitment(BigInt(note.nullifier), BigInt(note.secret), BUCKET);
    notes.push({ ...note, commitment: commitment.toString() });
    fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2)); // secrets first, always

    await tx(`credit[${i}]`, vault.credit(deployer.address, { value: BUCKET, gasLimit: 100_000_000n }));
    await tx(`insertNote[${i}]`, vault.insertShieldNote(BUCKET, commitment, { gasLimit: 500_000_000n }));
    tree.insert(commitment);
    const onChainRoot = await vault.noteRoot();
    if (onChainRoot !== tree.root()) throw new Error(`note-tree root diverged after insert ${i}`);
  }
  log(`   ✓ tree root matches the client after every insert (${NOTES} leaves)`);

  // ── prove + spend ──────────────────────────────────────────────────────────
  log("\n4. proving ownership of one note and spending it into the pool");
  const mine = 1 % NOTES; // not the first leaf — exercise a real path
  const target = notes[mine];
  const ksNote = ks.makeNote(BUCKET);            // the KS note the deposit funds
  const ksCommitment = ks.commitmentOf(ksNote);
  fs.writeFileSync(path.join(OUT, "ks-note.json"), JSON.stringify(ksNote, null, 2));

  const { elements, indices } = tree.path(mine);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root: tree.root().toString(),
      nullifierHash: poseidon1([BigInt(target.nullifier)]).toString(),
      bucket: BUCKET.toString(),
      ksCommitment: ksCommitment.toString(),
      nullifier: target.nullifier,
      secret: target.secret,
      pathElements: elements.map(String),
      pathIndices: indices,
    },
    WASM, ZKEY
  );
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [[proof.pi_a[0], proof.pi_a[1]],
     [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
     [proof.pi_c[0], proof.pi_c[1]]]
  );
  record("proved", { leaf: mine, nullifierHash: publicSignals[1].slice(0, 18) + "…" });

  // Snapshot the KS tree before the deposit so the note stays spendable.
  const ksStart = Number(await pool.treeSize());
  const preSideNodes = {};
  for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (await pool.sideNodes(lv)).toString();

  // Permissionless: submitted by the deployer here, but the proof binds the
  // destination, so any submitter would do and none could redirect it.
  const spend = await tx("depositShieldNoteZK", vault.depositShieldNoteZK(
    encoded, tree.root(), publicSignals[1], BUCKET, b32(ksCommitment), { gasLimit: 500_000_000n }
  ));
  const ksAfter = Number(await pool.treeSize());
  log(`   pool treeSize ${ksStart} → ${ksAfter}`);
  if (ksAfter <= ksStart) throw new Error("the pool did not accept the ZK-authorized deposit");

  // ── spend the resulting KS note ────────────────────────────────────────────
  log("\n5. withdrawing the resulting shielded note to a fresh address");
  const paths = ks.batchNotePaths(ksStart, preSideNodes, [ksCommitment]);
  const rec = { ...ksNote, index: paths[0].index, leftSnapshot: paths[0].leftSnapshot, depositBlock: spend.blockNumber };
  const { siblings, root } = await ks.reconstructPath(provider, POOL, rec);
  const recipient = ethers.Wallet.createRandom().address;
  const change = ks.makeNote(0n);
  const wInput = {
    withdrawnValue: BUCKET.toString(), treeDepth: "128", context: ks.contextFor(recipient).toString(),
    root, asset: "0", existingValue: BUCKET.toString(),
    existingNullifier: rec.nullifier, existingSecret: rec.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    siblings, leafIndex: String(rec.index),
  };
  const w = await snarkjs.groth16.fullProve(wInput, WITHDRAW_WASM, loadWithdrawZkey());
  const pB = [[w.proof.pi_b[0][1], w.proof.pi_b[0][0]], [w.proof.pi_b[1][1], w.proof.pi_b[1][0]]];
  const before = await provider.getBalance(recipient);
  const wtx = await pool.proxy_withdraw(
    [w.proof.pi_a[0], w.proof.pi_a[1]], pB, [w.proof.pi_c[0], w.proof.pi_c[1]], w.publicSignals, recipient,
    { gasLimit: 500_000_000n }
  );
  await wtx.wait();
  const after = await provider.getBalance(recipient);
  record("withdraw", { tx: wtx.hash, recipient, received: ethers.formatEther(after - before) });
  if (after <= before) throw new Error("recipient received nothing");

  const report = {
    ranAt: new Date().toISOString(), rpc: RPC, pool: POOL, poseidon: POSEIDON,
    vault: vaultAddr, verifier: await verifier.getAddress(),
    notes: NOTES, bucketPAS: ethers.formatEther(BUCKET), spentLeaf: mine,
    anonymitySet: NOTES, ksTreeBefore: ksStart, ksTreeAfter: ksAfter,
    spendTx: spend.hash, withdrawTx: wtx.hash, recipient,
    receivedPAS: ethers.formatEther(after - before), steps,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  log(`\n✅ ZK-authorized shielded payout, end to end on Paseo`);
  log(`   vault    ${vaultAddr}`);
  log(`   spend    ${spend.hash} (proof + pool deposit in one tx)`);
  log(`   withdraw ${wtx.hash} → ${recipient} (${ethers.formatEther(after - before)} PAS)`);
  log(`   report   e2e-runs/privacy-zk/report.json\n`);
}

// Leave when the work is done. ethers' provider keeps a block poller running, so
// a finished run would otherwise sit there looking unfinished — in CI, until the
// job timed out. Reports above are written synchronously, so there is nothing
// pending to lose. (e2e-lib's runScript does the same for the shield scripts.)
main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "failure.json"), JSON.stringify({ error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
