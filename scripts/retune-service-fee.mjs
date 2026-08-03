// Retune FareOrders.relayServiceFee against what a settlement now actually costs.
//
// The flat fee was sized when a shielded withdrawal cost 0.773 PAS — the
// forwarder CREATE dominated everything and 1.25 PAS was a reasonable guess
// around it. Switching to `withdraw` cut that to 0.031, so the fee is now ~17×
// the cost it was meant to cover, and the customer escrows it on every order:
// on a 1 PAS order the relay fee was 125% of the food.
//
// The guard compares the relay's comp against the order's CUMULATIVE relayed
// gas — pickup + every /forward + the dropoff (relay.mjs `recordOrderGas`) —
// times MIN_MARGIN. So the fee has to cover the whole relayed lifecycle, not
// just the dropoff. Median live PolkaVM gas at 1000 gwei:
//
//   confirmPickup       12,649   0.012649 PAS
//   confirmDropoffZK    20,757   0.020757 PAS
//   commitBid (forward)  7,735   0.007735 PAS  ← once per competing bid
//   shield-withdraw     31,287   0.031287 PAS  ← subsidy budget, not the order comp
//
//   quiet order (no bids relayed)   0.0334 × 1.25 = 0.042
//   typical (3 bids)                0.0566 × 1.25 = 0.071
//   busy (8 bids + cancel + rate)   0.1104 × 1.25 = 0.138
//   busy + a sponsored funding      0.1417 × 1.25 = 0.177
//
// 0.25 PAS clears the worst of those by 1.4× and the typical case by 3.5×,
// while cutting what the customer escrows by 5×. Headroom is deliberate: gas
// price moves, retries and extra forwards all land on the relay, and a fee set
// too low reproduces the bps-rebate failure where the guard declined every
// realistic order.
//
// The token fee moves by the same divisor rather than being recomputed, so this
// changes ONE variable. 4.25/1.25 = 3.4 USDC per PAS is the FX the current
// setting implies; re-deriving it from a live quote is a separate decision.
import { ethers } from "ethers";
import fs from "node:fs";

const BOOK = JSON.parse(fs.readFileSync("deployed-addresses.json", "utf8"));
const NATIVE = "0x0000000000000000000000000000000000000000";
const NEW_NATIVE = ethers.parseEther(process.env.FEE_PAS || "0.25");
const NEW_TOKEN = ethers.parseUnits(process.env.FEE_USDC || "0.85", 6);

const key = process.env.DEPLOYER_PRIVATE_KEY
  || fs.readFileSync(".env", "utf8").match(/DEPLOYER_PRIVATE_KEY=(\S+)/)[1];
const req = new ethers.FetchRequest("https://eth-rpc-testnet.polkadot.io/");
req.timeout = 45_000;
const prov = new ethers.JsonRpcProvider(req, undefined, { staticNetwork: true, batchMaxCount: 1 });
const w = new ethers.Wallet(key, prov);
const orders = new ethers.Contract(BOOK.orders, [
  "function relayServiceFee(address) view returns (uint96)",
  "function setRelayServiceFee(address token, uint96 amount)",
  "function owner() view returns (address)",
], w);

const owner = await orders.owner();
if (owner.toLowerCase() !== w.address.toLowerCase()) throw new Error(`not owner: ${w.address} vs ${owner}`);

const beforeNative = await orders.relayServiceFee(NATIVE);
const beforeToken = await orders.relayServiceFee(BOOK.stablecoin);
console.log("orders", BOOK.orders);
console.log(`native : ${ethers.formatEther(beforeNative)} → ${ethers.formatEther(NEW_NATIVE)} PAS`);
console.log(`USDC   : ${ethers.formatUnits(beforeToken, 6)} → ${ethers.formatUnits(NEW_TOKEN, 6)} USDC`);

if (process.env.DRY_RUN === "1") { console.log("\nDRY_RUN=1 — nothing sent"); process.exit(0); }

const GAS = { gasLimit: 5_000_000n, gasPrice: 1_000_000_000_000n };
for (const [label, token, amount] of [["native", NATIVE, NEW_NATIVE], ["USDC", BOOK.stablecoin, NEW_TOKEN]]) {
  const tx = await orders.setRelayServiceFee(token, amount, GAS);
  const rc = await tx.wait();
  console.log(`${label}: tx ${rc.hash} status ${rc.status}`);
}

console.log("\nafter:");
console.log("  native:", ethers.formatEther(await orders.relayServiceFee(NATIVE)), "PAS");
console.log("  USDC  :", ethers.formatUnits(await orders.relayServiceFee(BOOK.stablecoin), 6), "USDC");
console.log("\nNOTE: in-flight orders escrowed the OLD fee and pay it out from their own");
console.log("snapshot (Order.serviceFee), so this only affects orders created from now on.");
