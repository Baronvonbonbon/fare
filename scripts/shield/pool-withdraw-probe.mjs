// Diagnose the canonical v7 pool withdrawal. Deposits a SMALL amount, persists
// the note before anything can fail, then STATIC-CALLs proxy_withdraw so a
// revert costs nothing and names itself.
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { WITHDRAW_WASM, loadWithdrawZkey } from "./zkey.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ks = await import(pathToFileURL(path.join(ROOT, "web/src/shieldpool.ts")).href);
const BOOK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
const POOL = process.env.SHIELD_POOL || BOOK.shieldPool;
const NOTE_FILE = path.join(ROOT, "e2e-runs", "ks-diag-note.json");

// `withdraw` and `proxy_withdraw` take IDENTICAL arguments and differ only in
// the final step: withdraw does _transfer(asset, recipient, amount) straight
// from the pool; proxy_withdraw does `new SimpleTokenForwarder{value}(recipient)`,
// a full CREATE whose constructor forwards and then leaves a dead contract
// behind. Both take `recipient`, so BOTH let a relay submit on someone else's
// behalf — the recipient never signs either way. The forwarder's only added
// property is that the value lands from a fresh address instead of visibly from
// the pool. MODE=withdraw prices that difference.
const MODE = (process.env.MODE || "proxy").toLowerCase() === "withdraw" ? "withdraw" : "proxy_withdraw";
const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function treeSize() view returns (uint256)",
  "function currentRoot() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
];
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const key = () => process.env.DEPLOYER_PRIVATE_KEY
  || fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/DEPLOYER_PRIVATE_KEY=(\S+)/)[1];

// ethers has no socket timeout, so a stalled Paseo RPC hangs the run forever
// rather than failing — a documented recurring failure mode in this repo. It
// bit this very script: a deposit confirmed, the snapshot call then hung, and
// the note was never persisted, stranding the leaf. Bound every request.
const REQUEST_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 45_000);
const req = new ethers.FetchRequest(process.env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/");
req.timeout = REQUEST_TIMEOUT_MS;
const prov = new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true, batchMaxCount: 1 });
const D0 = new ethers.Wallet(key(), prov);
const pool = new ethers.Contract(POOL, POOL_ABI, D0);
const GAS_LIMIT = 500_000_000n; // matches the e2e scripts; reserved up front on Paseo
const GAS = { gasLimit: GAS_LIMIT, gasPrice: 1_000_000_000_000n };

console.log("pool     ", POOL);
console.log("treeSize ", (await pool.treeSize()).toString());
console.log("root     ", (await pool.currentRoot()).toString());

const value = ethers.parseEther(process.env.AMOUNT || "0.5");

// Reuse a persisted note if one survived a previous run — a stranded leaf is
// worth retrying before minting another.
let record;
if (fs.existsSync(NOTE_FILE) && !process.env.FRESH) {
  record = JSON.parse(fs.readFileSync(NOTE_FILE, "utf8"));
  console.log("\nreusing persisted note, index", record.index, "value", ethers.formatEther(record.value));
} else {
  // Deliberately NOT ks.depositAndSnapshot: that mints the note, deposits, and
  // only returns after snapshotting, so the secrets exist on chain but nowhere
  // else for the whole of that call. A stall in the snapshot leg — which is
  // what happened here on 2026-08-03 — strands the leaf permanently. Minting
  // and writing the secrets BEFORE the value moves makes the same failure
  // recoverable: index + note is enough, and the left path can be read back
  // afterwards because those levels never change once inserted.
  const index = Number(await pool.treeSize());
  const note = ks.makeNote(value);
  const bit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;
  const persist = (extra = {}) => {
    fs.mkdirSync(path.dirname(NOTE_FILE), { recursive: true });
    fs.writeFileSync(NOTE_FILE, JSON.stringify({ ...note, index, ...extra },
      (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  };
  persist({ depositBlock: 0, leftSnapshot: {}, pending: true });
  console.log("note secrets persisted BEFORE deposit → index", index);

  console.log("depositing", ethers.formatEther(value), "PAS");
  const tx = await pool.depositNative(ethers.zeroPadValue(ethers.toBeHex(ks.commitmentOf(note)), 32),
    { value, gasLimit: GAS_LIMIT, gasPrice: GAS.gasPrice });
  const receipt = await tx.wait();
  console.log("deposit", receipt.hash, "gasUsed", receipt.gasUsed.toString());

  const leftSnapshot = {};
  for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) leftSnapshot[lv] = (await pool.sideNodes(lv)).toString();
  const depositBlock = Math.max(0, Number(receipt.blockNumber) - 1);
  persist({ depositBlock, leftSnapshot });
  record = { ...note, index, leftSnapshot, depositBlock };
  console.log("note complete →", path.relative(ROOT, NOTE_FILE), "index", index);
}

const recipient = ethers.Wallet.createRandom().address;
console.log("\nreconstructing path…");
const { siblings, root } = await ks.reconstructPath(prov, POOL, record);
console.log("proof root  ", root);
console.log("chain root  ", (await pool.currentRoot()).toString());
console.log("roots match ", root === (await pool.currentRoot()).toString());

const withdrawn = BigInt(record.value);
const change = ks.makeNote(0n);
const input = {
  withdrawnValue: withdrawn.toString(), treeDepth: "128",
  context: ks.contextFor(recipient).toString(),
  root, asset: "0", existingValue: record.value,
  existingNullifier: record.nullifier, existingSecret: record.secret,
  newNullifier: change.nullifier, newSecret: change.secret,
  siblings, leafIndex: String(record.index),
};
console.log("\nproving…");
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WITHDRAW_WASM, loadWithdrawZkey());
console.log("pubSignals:", publicSignals.map(String));
console.log("  [7] asset =", publicSignals[7], "(0 = native)");

const args = [
  [proof.pi_a[0], proof.pi_a[1]],
  [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
  [proof.pi_c[0], proof.pi_c[1]],
  publicSignals, recipient,
];

console.log(`\nSTATIC CALL ${MODE} (no gas spent)…`);
try {
  await pool[MODE].staticCall(...args);
  console.log("✅ would SUCCEED");
  if (process.env.SEND) {
    const tx = await pool[MODE](...args, GAS);
    const rc = await tx.wait();
    const feePas = ethers.formatEther(rc.gasUsed * GAS.gasPrice);
    console.log(`sent: ${rc.hash} status ${rc.status}`);
    console.log(`MODE=${MODE}  gasUsed=${rc.gasUsed.toString()}  fee=${feePas} PAS`);
    console.log("recipient balance:", ethers.formatEther(await prov.getBalance(recipient)));
    fs.rmSync(NOTE_FILE, { force: true });
  }
} catch (e) {
  console.log("❌ REVERT:", e.shortMessage ?? e.reason ?? e.message);
  if (e.data) console.log("   data:", e.data);
  const m = /reverted with reason string '([^']+)'|revert (.+)/.exec(String(e.message ?? ""));
  if (m) console.log("   reason:", m[1] ?? m[2]);
}
await prov.destroy?.();
