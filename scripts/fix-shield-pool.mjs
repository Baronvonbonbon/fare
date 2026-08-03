// Point FareVault's shieldPool back at the pool that can actually pay out.
//
// The canonical v7 pool 0x3068490C… accepts deposits and reverts every
// withdrawal (docs/KUSAMA-SHIELD-FINDINGS.md Issue 7), so a driver shielding a
// payout through depositShieldNoteZK loses it. This flips the pointer.
//
// Refuses to run with notes outstanding: switching the pointer under existing
// notes would send them somewhere their commitments do not exist. Set
// ALLOW_INFLIGHT=1 only if you know those notes are already unreachable.
import { ethers } from "ethers";
import fs from "node:fs";

const WORKING = "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const BOOK = JSON.parse(fs.readFileSync("deployed-addresses.json", "utf8"));
const key = process.env.DEPLOYER_PRIVATE_KEY
  || fs.readFileSync(".env", "utf8").match(/DEPLOYER_PRIVATE_KEY=(\S+)/)[1];

const prov = new ethers.JsonRpcProvider("https://eth-rpc-testnet.polkadot.io/", undefined,
  { staticNetwork: true, batchMaxCount: 1 });
const w = new ethers.Wallet(key, prov);
const vault = new ethers.Contract(BOOK.vault, [
  "function shieldPool() view returns (address)",
  "function nextNoteIndex() view returns (uint32)",
  "function owner() view returns (address)",
  "function setShieldPool(address)",
], w);

const owner = await vault.owner();
if (owner.toLowerCase() !== w.address.toLowerCase()) throw new Error(`not owner: ${w.address} vs ${owner}`);

const before = await vault.shieldPool();
const idx = await vault.nextNoteIndex();
console.log("vault        ", BOOK.vault);
console.log("shieldPool   ", before);
console.log("nextNoteIndex", idx.toString());
if (before.toLowerCase() === WORKING.toLowerCase()) { console.log("already correct — nothing to do"); process.exit(0); }
if (idx > 1n && process.env.ALLOW_INFLIGHT !== "1") {
  throw new Error(`nextNoteIndex=${idx}: notes are outstanding, flipping would orphan them (ALLOW_INFLIGHT=1 to override)`);
}

// Prove the destination can actually pay out before pointing at it — the exact
// check whose absence caused this.
const probe = new ethers.Contract(WORKING, ["function isKnownRoot(uint256) view returns (bool)"], prov);
try { await probe.isKnownRoot(1n); } catch (e) {
  throw new Error(`destination pool fails isKnownRoot: ${e.shortMessage ?? e.message} — refusing to point at it`);
}
console.log("destination isKnownRoot(1) returns without panicking ✓");

const tx = await vault.setShieldPool(WORKING, { gasLimit: 5_000_000n, gasPrice: 1_000_000_000_000n });
const rc = await tx.wait();
console.log("tx", rc.hash, "status", rc.status, "gasUsed", rc.gasUsed.toString());
console.log("shieldPool now", await vault.shieldPool());
