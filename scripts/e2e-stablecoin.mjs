// Live stablecoin (C3) e2e on Paseo — the full delivery lifecycle escrowed and
// settled ENTIRELY in REAL Asset Hub USDC (asset 1337, via its ERC-20
// precompile), the ERC-20 path:
//   KS-shielded gas + KS-shielded USDC → approve → createOrderERC20 → commitBid →
//   acceptSealedBidERC20 → confirmPickup → confirmDropoffZK → payouts, and then
//   BOTH exits: the venue takes the public `withdrawToken`, and the driver takes
//   the private one — insertShieldNoteToken → depositShieldNoteTokenZK → pool →
//   withdraw to a fresh address. That second half is the whole reason a USDC
//   order can be private at both ends rather than only at funding.
// Reuses the registered venue (id 3) + driver from the native e2e; a fresh
// customer holds USDC (escrow) + PAS (gas). Settlement is submitted by the
// venue-node relay wallet (the F6 rebate accrues in USDC). Every tx is recorded.
import { ethers } from "ethers";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import { WITHDRAW_WASM, loadWithdrawZkey } from "./shield/zkey.mjs";
import fs from "fs";
import path from "path";
import {
  ROOT, provider, book, env, loadState, waitTx, leanGas, GAS_PRICE_WEI, fmt, eth, runScript,
  KS_POOL, ksShieldedFund, ksPrecompileFor,
} from "./shield/e2e-lib.mjs";

// Sealed bids are the only bid path. A fixed salt is fine for a scripted run:
// in production the driver picks it and it travels to the customer off-chain.
const BID_SALT = ethers.keccak256(ethers.toUtf8Bytes("fare-e2e-bid"));
const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const usdc = (n) => BigInt(Math.round(n * 1e6)); // 6 decimals
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;

// Mirror of FareVault's incremental note tree, for building authentication paths
// the way the client does from the vault's own events. Empty subtrees
// short-circuit to a precomputed zero, so a root is O(leaves) not O(2^depth).
const NOTE_DEPTH = 16; // must match FareVault.NOTE_DEPTH and the circuit
const noteZeros = (() => { const z = [0n]; for (let i = 1; i <= NOTE_DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]])); return z; })();
class NoteTree {
  constructor(leaves = []) { this.leaves = leaves; this.memo = new Map(); }
  node(lv, i) {
    if (i * 2 ** lv >= this.leaves.length) return noteZeros[lv];
    if (lv === 0) return this.leaves[i];
    const k = `${lv}:${i}`;
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit;
    const v = poseidon2([this.node(lv - 1, i * 2), this.node(lv - 1, i * 2 + 1)]);
    this.memo.set(k, v);
    return v;
  }
  root() { return this.node(NOTE_DEPTH, 0); }
  path(index) {
    const elements = [], indices = [];
    let idx = index;
    for (let lv = 0; lv < NOTE_DEPTH; lv++) {
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

// amounts (USDC)
const ORDER_VALUE = usdc(3), TIP = usdc(0.5), MAX_FARE = usdc(2), FARE = usdc(1.5);
// geometry (same SF venue as the native run)
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 };
const snap = (v) => Math.round(v / 300) * 300;
const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));

const OUT = path.join(ROOT, "e2e-runs", "e2e-stablecoin");
const LEDGER = path.join(OUT, "ledger.json");
const STATE = path.join(process.env.E2E_SCRATCH || "/tmp/claude-1000/-home-k-Documents-fare/b72267a7-e6ed-4ea1-a42c-ce13603eacaa/scratchpad", "e2e-stablecoin-state.json");
/// Resume is OPT-IN. Every phase below is guarded on a persisted `st.*` flag, so
/// with a state file left over from a finished order a bare run skipped all of
/// them, asserted nothing, sent no transaction, and still printed ✅ (finding 28
/// in docs/TEST-FINDINGS.md). A run that does nothing must not look like a run
/// that passed, so the default is now a fresh order and `RESUME=1` is required
/// to continue an interrupted one.
const RESUME = process.env.RESUME === "1";
const loadSt = () => (RESUME && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const saveSt = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

/// Assert an on-chain status instead of printing it next to a hardcoded label.
/// The old code did `console.log(\`status ${await statusOf(id)} (2=Assigned)\`)`,
/// which prints the actual value beside the expected one and compares neither —
/// so a finished order printed "status 4 (2=Assigned)" three times, matching
/// none of them, and the run still ended green.
const STATUS_NAME = { 1: "Open", 2: "Assigned", 3: "PickedUp", 4: "Delivered", 5: "Cancelled" };

/// Polls, because Paseo's hosted RPC is load-balanced and a read issued right
/// after a CONFIRMED write can land on a node that has not caught up — order #14
/// read 3 immediately after a successful confirmDropoffZK receipt and was 4
/// moments later. Bounded and still fatal: it fails if the status never arrives,
/// and a genuinely wrong status (a stale resume showing 4 where 2 is wanted)
/// never becomes right no matter how long we wait, so this does not weaken the
/// check that finding 28 was about.
/// Asserts the order has reached AT LEAST `want`. The lifecycle is monotonic
/// (Open → Assigned → PickedUp → Delivered), and under RESUME the order is by
/// definition already part-way through, so demanding equality would fail every
/// resumed run at its first checkpoint.
///
/// That leniency is NOT what stops finding 28 — `txCount` below is. A run that
/// only reads is caught at the end, whatever the statuses said.
async function expectStatus(orders, orderId, want, { tries = 15, delayMs = 2000 } = {}) {
  let got;
  for (let i = 0; i < tries; i++) {
    got = Number(await orders.statusOf(orderId));
    if (got >= want) {
      const note = got > want ? ` — already past ${STATUS_NAME[want]}` : "";
      console.log(`   status ${got} (${STATUS_NAME[got] ?? "?"}) ✓${i ? ` after ${i} retr${i === 1 ? "y" : "ies"}` : ""}${note}`);
      return;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `order #${orderId}: expected status ≥ ${want} (${STATUS_NAME[want]}), got ${got} (${STATUS_NAME[got] ?? "?"}) ` +
    `after ${tries} reads over ${(tries * delayMs) / 1000}s`
  );
}
function appendLedger(e) { fs.mkdirSync(OUT, { recursive: true }); const l = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : []; l.push(e); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

/// How many transactions this run actually sent. The whole point of finding 28:
/// a run that skipped every phase still printed ✅. Statuses can look right
/// without anything having happened; this cannot.
let txCount = 0;

async function rec(prov, { step, party, action, hash, tokenValue }) {
  txCount++;
  const rc = await waitTx(prov, hash, action);
  const fee = (rc.gasUsed ?? 0n) * GAS_PRICE_WEI;
  const e = { step, party, action, from: rc.from, to: rc.to, usdc: tokenValue != null ? (Number(tokenValue) / 1e6).toString() : "", hash, block: rc.blockNumber, status: rc.status, gasUsed: (rc.gasUsed ?? 0n).toString(), feePAS: ethers.formatEther(fee) };
  appendLedger(e);
  // A REVERTED receipt is status 0, and this used to print the same "✓" for it
  // as for a success — the sibling of finding 28 and of the e2e-lib `record()`
  // bug: a run in which every call reverted still read as green, and the first
  // symptom was some later step failing for an unrelated-looking reason.
  // Mined is not succeeded.
  if (rc.status !== 1) {
    console.log(`   ✗ ${action} [${party}] REVERTED (status 0) gas ${e.gasUsed} — ${hash}`);
    throw new Error(`${action} reverted on-chain (tx ${hash}); see ${path.relative(ROOT, LEDGER)}`);
  }
  console.log(`   ✓ ${action} [${party}] status ${rc.status} gas ${e.gasUsed} fee ${e.feePAS} PAS${tokenValue != null ? ` value ${e.usdc} USDC` : ""}`);
  return rc;
}

async function main() {
  const prov = provider();
  const b = book();
  const e2e = loadState(); // native-run state (venue/driver registered)
  const st = loadSt();
  const chainId = e2e.chainId ?? Number((await prov.getNetwork()).chainId);
  const deployer = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), prov);
  const V = new ethers.Wallet(e2e.wallets.venue.privateKey, prov);
  const D = new ethers.Wallet(e2e.wallets.driver.privateKey, prov);
  const R = new ethers.Wallet(e2e.wallets.relay.privateKey, prov); // settlement submitter (relayer)
  const venueId = e2e.venueId;

  st.customer = st.customer || (() => { const w = ethers.Wallet.createRandom(); return { address: w.address, privateKey: w.privateKey }; })();
  saveSt(st);
  const C = new ethers.Wallet(st.customer.privateKey, prov);
  console.log(`stablecoin ${b.stablecoin} (USDC, 6dp)  venueId ${venueId}`);
  console.log(`customer ${C.address}  driver ${D.address}  venue ${V.address}`);

  // REAL Asset Hub USDC (asset 1337) through its ERC-20 precompile. There is no
  // `mint` — the precompile is a bare IERC20 over a real pallet-assets balance.
  const USDC = new ethers.Contract(b.stablecoin, [
    "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)",
    "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
    "function symbol() view returns(string)",
  ], deployer);
  const orders = new ethers.Contract(b.orders, [
    "function createOrderERC20(address,uint64,bytes32,uint96,uint96,uint96,uint64,uint64) returns(uint256)",
    "function bidHashOf(uint256,address,uint96,bytes32) pure returns (bytes32)", "function commitBid(uint256,bytes32,bytes32)", "function acceptSealedBid(uint256,address,uint96,bytes32) payable", "function acceptSealedBidERC20(uint256,address,uint96,bytes32)",
    "function nextOrderId() view returns(uint256)", "function statusOf(uint256) view returns(uint8)",
    "function dropCommitOf(uint256) view returns(bytes32)", "function treasury() view returns(address)", "function feeBps() view returns(uint16)",
    "function relayServiceFee(address) view returns(uint96)",
  ], prov);
  const vault = new ethers.Contract(b.vault, ["function tokenBalanceOf(address,address) view returns(uint256)", "function withdrawToken(address)"], prov);

  // ── 1. Fund the customer burner THROUGH KUSAMA SHIELD ─────────────────────
  // This used to be two direct transfers from the deployer — 30 PAS and the
  // USDC — which handed every observer the one edge the per-order burner exists
  // to destroy. A funded-by-transfer burner is not a burner; it is the funder
  // wearing a different address.
  //
  // Both legs now go through the shielded pool. KS is multi-asset, so the USDC
  // escrow shields exactly like the gas does: deposit names the funder and a
  // commitment, withdrawal names the burner and a nullifier, and nothing ties
  // them together. The relay submits the withdrawals, so the burner needs no
  // prior balance to receive its first one.
  // READ the service fee; do not budget a magic constant for it. It is governed
  // (`setRelayServiceFee`) and moves without a redeploy — it went 4.25 → 0.85
  // USDC on 2026-08-03 — so a hardcoded `+ usdc(5)` headroom is wrong in both
  // directions: it over-funds after a cut, and silently under-funds after a
  // raise, which is how the native scripts hit "bad-value" in July.
  const SERVICE_FEE = await orders.relayServiceFee(b.stablecoin);
  const NEED = ORDER_VALUE + TIP + FARE + SERVICE_FEE + usdc(0.5); // + slack for rounding/approve
  console.log(`   service fee (live): ${fmt6(SERVICE_FEE)} USDC → needs ${fmt6(NEED)} USDC total`);
  if (!st.funded) {
    const held = await USDC.balanceOf(deployer.address);
    if (held < NEED) {
      throw new Error(
        `deployer holds ${fmt6(held)} USDC, needs ${fmt6(NEED)}. There is no mint — ` +
        `buy some first:  WANT_USDC=${Math.ceil(Number(NEED) / 1e6) + 5} node scripts/swap-local-dex.mjs`
      );
    }
    // The submitter is the VENUE wallet, deliberately NOT the relay's key: the
    // relay service is running with that key and caches its own nonce, so a
    // script signing with it in parallel desynchronises the service and every
    // later /submit fails with "could not coalesce error". Who submits a
    // proxy_withdraw is public but creates NO link — the recipient is bound
    // inside the proof — so the only thing that matters is that it is not the
    // funder, and that it is an account that already exists and is funded.
    const ks = { pool: KS_POOL, provider: prov, funder: deployer, submitter: V, recipient: C.address,
                 poseidon2, snarkjs, wasm: WITHDRAW_WASM, zkey: loadWithdrawZkey() };

    console.log(`\n1a. KS shield GAS → burner (${fmt(eth("30"))} PAS, unlinked)`);
    const kg = await ksShieldedFund({ ...ks, amount: eth("30"), assetId: 0 });
    await rec(prov, { step: "S.ksGasDeposit", party: "customer-main", action: "KS.depositNative", hash: kg.depositHash });
    await rec(prov, { step: "S.ksGasWithdraw", party: "ks-submitter", action: "KS.withdraw→burner(PAS)", hash: kg.withdrawHash });

    console.log(`\n1b. KS shield USDC ESCROW → burner (${fmt6(NEED)} USDC, asset 1337, unlinked)`);
    const ku = await ksShieldedFund({ ...ks, amount: NEED, assetId: 1337 });
    await rec(prov, { step: "S.ksUsdcDeposit", party: "customer-main", action: "KS.depositAsset(USDC)", hash: ku.depositHash, tokenValue: NEED });
    await rec(prov, { step: "S.ksUsdcWithdraw", party: "ks-submitter", action: "KS.withdraw→burner(USDC)", hash: ku.withdrawHash, tokenValue: NEED });

    // NOT MaxUint256: the asset precompile narrows to u128 and reverts
    // "Balance conversion failed" on an unlimited approval.
    const ua = await USDC.connect(C).approve(b.orders, NEED, { gasLimit: await leanGas(USDC.connect(C).approve, [b.orders, NEED]) });
    await rec(prov, { step: "S.approve", party: "customer", action: "USDC.approve(orders)", hash: ua.hash });
    st.funded = true; saveSt(st);
  }
  console.log(`   customer USDC ${fmt6(await USDC.balanceOf(C.address))}  allowance ${fmt6(await USDC.allowance(C.address, b.orders))}`);

  // ── 2. createOrderERC20 ────────────────────────────────────────────────────
  if (!st.orderId) {
    const salt = rand();
    const dropCommit = positionCommit(DROP.lat, DROP.lon, salt);
    console.log(`\n2. createOrderERC20 (orderValue ${fmt6(ORDER_VALUE)} + tip ${fmt6(TIP)} USDC)`);
    const oc = orders.connect(C);
    const nextId = await orders.nextOrderId();
    const args = [b.stablecoin, venueId, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0];
    const gl = await leanGas(oc.createOrderERC20, args);
    const tx = await oc.createOrderERC20(...args, { gasLimit: gl });
    await rec(prov, { step: "S.create", party: "customer", action: "createOrderERC20", hash: tx.hash, tokenValue: ORDER_VALUE + TIP });
    st.orderId = nextId.toString(); st.salt = salt.toString(); st.dropCommit = dropCommit; saveSt(st);
    console.log(`   orderId ${st.orderId}`);
  }
  const orderId = BigInt(st.orderId);

  // ── 3. driver commitBid (sealed) ───────────────────────────────────────────
  if (!st.bid) {
    console.log(`\n3. driver commitBid ${fmt6(FARE)} USDC (sealed — the chain sees only a hash)`);
    const od = orders.connect(D);
    const h = await orders.bidHashOf(orderId, D.address, FARE, BID_SALT);
    const tx = await od.commitBid(orderId, h, ethers.ZeroHash, { gasLimit: await leanGas(od.commitBid, [orderId, h, ethers.ZeroHash]) });
    await rec(prov, { step: "S.bid", party: "driver", action: "commitBid", hash: tx.hash });
    st.bid = true; saveSt(st);
  }

  // ── 4. acceptSealedBidERC20 (pulls fare in USDC) ───────────────────────────
  if (!st.accepted) {
    console.log(`\n4. customer acceptSealedBidERC20 (escrows fare ${fmt6(FARE)} USDC)`);
    const oc = orders.connect(C);
    const a = [orderId, D.address, FARE, BID_SALT];
    const tx = await oc.acceptSealedBidERC20(...a, { gasLimit: await leanGas(oc.acceptSealedBidERC20, a) });
    await rec(prov, { step: "S.accept", party: "customer", action: "acceptSealedBidERC20", hash: tx.hash, tokenValue: FARE });
    st.accepted = true; saveSt(st);
  }
  await expectStatus(orders, orderId, 2);

  // Settlement goes through the RELAY'S HTTP ENDPOINT, not the relay's key
  // directly. That distinction is the whole point: submitting with the key
  // proves the calls work, but never asks the relay whether settling a TOKEN
  // order pays for itself. The profitability guard values the USDC service fee
  // in native (via the asset-conversion quote) and refuses below
  // RELAY_MIN_MARGIN, and until this went through /submit that decision was
  // completely untested — a 402 here is a real failure, not a warning.
  const RELAY_URL = (process.env.RELAY_URL ?? "http://127.0.0.1:8788").replace(/\/$/, "");
  const relayPost = async (route, body) => {
    const r = await fetch(`${RELAY_URL}${route}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const json = await r.json().catch(() => ({}));
    if (r.status !== 200) {
      throw new Error(`relay ${route} → ${r.status} ${JSON.stringify(json)}`);
    }
    return json;
  };

  // ── 5. confirmPickup (dual-sig, relayed) ───────────────────────────────────
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: b.settlement };
  const settle = new ethers.Contract(b.settlement, [
    "function confirmPickup((uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes,(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes)",
    "function confirmDropoffZK((uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp),bytes,bytes,uint256[5])",
    "function dropoffRadiusMeters() view returns(uint32)",
  ], prov); // reads only — settlement WRITES go through the relay's /submit
  if (!st.pickup) {
    console.log(`\n5. confirmPickup (driver+venue dual-sign, relay submits)`);
    const now = Number((await prov.getBlock("latest")).timestamp);
    const dC = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
    const LOC = { LocationAttestation: [ { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" } ] };
    const dAtt = { orderId, phase: 1, actor: D.address, lat: dC.lat, lon: dC.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const dSig = await D.signTypedData(domain, LOC, dAtt), vSig = await V.signTypedData(domain, LOC, vAtt);
    const out = await relayPost("/submit", { method: "confirmPickup", args: [dAtt, dSig, vAtt, vSig] });
    await rec(prov, { step: "S.pickup", party: "relay(venue-node)", action: "confirmPickup", hash: out.txHash });
    st.pickup = true; st.pickupCoarse = dC; saveSt(st);
  }
  await expectStatus(orders, orderId, 3);

  // ── 6. confirmDropoffZK (real Groth16 proof, relay submits) ────────────────
  if (!st.dropoff) {
    console.log(`\n6. confirmDropoffZK (Groth16 proximity, relay submits)`);
    const salt = BigInt(st.salt), drvSalt = rand();
    const driverCommit = positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt);
    const nul = b32(poseidon2([salt, orderId]));
    const radius = 100n;
    const input = { orderId: orderId.toString(), dropCommit: BigInt(st.dropCommit).toString(), driverCommit: BigInt(driverCommit).toString(), radiusMeters: radius.toString(), nullifier: BigInt(nul).toString(), custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: salt.toString(), drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString() };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
    const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]);
    const pub = [orderId.toString(), BigInt(st.dropCommit).toString(), BigInt(driverCommit).toString(), radius.toString(), BigInt(nul).toString()];
    const now = Number((await prov.getBlock("latest")).timestamp);
    const DC = { DriverCommitAttestation: [ { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" } ] };
    const dAtt = { orderId, phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
    const dSig = await D.signTypedData(domain, DC, dAtt);
    // THE economics assertion: this is the reward-bearing call, so the guard
    // values the USDC service fee in native and compares it to the order's
    // cumulative relayed gas x RELAY_MIN_MARGIN. A 402 means a token order does
    // not pay for itself.
    const out = await relayPost("/submit", { method: "confirmDropoffZK", args: [dAtt, dSig, proofBytes, pub] });
    await rec(prov, { step: "S.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", hash: out.txHash });
    st.dropoff = true; saveSt(st);
  }
  await expectStatus(orders, orderId, 4);

  // ── 7. token payouts + verify splits ───────────────────────────────────────
  const treasury = await orders.treasury(), feeBps = await orders.feeBps();
  const [bV, bD, bT, bR] = await Promise.all([vault.tokenBalanceOf(b.stablecoin, V.address), vault.tokenBalanceOf(b.stablecoin, D.address), vault.tokenBalanceOf(b.stablecoin, treasury), vault.tokenBalanceOf(b.stablecoin, R.address)]);
  console.log(`\n7. Vault USDC balances — venue ${fmt6(bV)}  driver ${fmt6(bD)}  treasury ${fmt6(bT)}  relay ${fmt6(bR)} (feeBps ${feeBps})`);
  st.payouts = { venue: bV.toString(), driver: bD.toString(), treasury: bT.toString(), relay: bR.toString(), treasuryAddr: treasury }; saveSt(st);

  // The VENUE takes the public path. A venue is a business address — its
  // location and menu are public by design, so naming it at settlement leaks
  // nothing the chain does not already say.
  if (!st.venuePaid && bV > 0n) { const tx = await vault.connect(V).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(V).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "S.payout-venue", party: "venue", action: "withdrawToken", hash: tx.hash, tokenValue: bV }); st.venuePaid = true; saveSt(st); }

  // ── 8. The DRIVER takes the PRIVATE path (this is the new half) ────────────
  // Until now the shield-note path was native-only, so a driver settled in USDC
  // could only do what the venue just did: withdraw to a persistent, named
  // address, publishing their whole revenue history. This is the token
  // equivalent — earnings → note → ZK spend → pool → fresh address.
  //
  // The asset binding is the note TREE, not a circuit signal: the shield-note
  // circuit's public inputs are [root, nullifierHash, bucket, ksCommitment] and
  // carry no asset, so a proof built over the USDC tree simply cannot satisfy
  // the native root window. That is why this needed no new trusted setup.
  if (!st.driverShielded && bD > 0n) {
    const vaultT = new ethers.Contract(b.vault, [
      "function insertShieldNoteToken(address token, uint96 bucket, uint256 commitment)",
      "function depositShieldNoteTokenZK(bytes proof, uint256 root, uint256 nullifierHash, address token, uint96 bucket, bytes32 ksCommitment)",
      "function noteRootOf(address) view returns (uint256)",
      "function shieldBucketCountToken(address) view returns (uint256)",
      "function shieldBucketsToken(address,uint256) view returns (uint96)",
      "function shieldAssetId(address) view returns (uint64)",
      "event ShieldNoteInsertedToken(address indexed token, address account, uint96 bucket, uint256 commitment, uint32 index)",
    ], prov);

    // Read the ladder from the chain. Hardcoding rungs is how a script starts
    // reverting "bad-bucket" the first time governance retunes them.
    const nB = Number(await vaultT.shieldBucketCountToken(b.stablecoin));
    const rungs = [];
    for (let i = 0; i < nB; i++) rungs.push(await vaultT.shieldBucketsToken(b.stablecoin, i));
    const plan = [];
    let left = bD;
    for (const r of [...rungs].sort((x, y) => (x > y ? -1 : 1))) while (left >= r) { plan.push(r); left -= r; }
    console.log(`\n8. driver shields USDC earnings — ladder [${rungs.map(fmt6).join(", ")}]`);
    console.log(`   ${fmt6(bD)} USDC → ${plan.length} note(s) [${plan.map(fmt6).join(", ")}], ${fmt6(left)} stays unshielded`);
    if (plan.length === 0) throw new Error(`driver earned ${fmt6(bD)} USDC, below the smallest rung ${fmt6(rungs[0])}`);

    const BUCKET = plan[0]; // one note is enough to prove the path
    const note = { nullifier: rand(), secret: rand() };
    const commitment = poseidon2([poseidon2([note.nullifier, note.secret]), BUCKET]);
    const vdT = vaultT.connect(D);
    const iTx = await vdT.insertShieldNoteToken(b.stablecoin, BUCKET, commitment, {
      gasLimit: await leanGas(vdT.insertShieldNoteToken, [b.stablecoin, BUCKET, commitment]),
    });
    await rec(prov, { step: "S.shield-insert", party: "driver", action: "insertShieldNoteToken", hash: iTx.hash, tokenValue: BUCKET });

    // Rebuild the USDC tree from the vault's own events. Filtered by the token
    // topic, which is indexed FIRST precisely so Paseo can filter it server-side
    // — it rejects null topic placeholders and mishandles the [] wildcard, so a
    // non-leading indexed param cannot be filtered at the node.
    const inserted = await vaultT.queryFilter(vaultT.filters.ShieldNoteInsertedToken(b.stablecoin), 0, "latest");
    const leaves = inserted.map((l) => ({ i: Number(l.args.index), c: ethers.toBigInt(l.args.commitment) }))
      .sort((a, x) => a.i - x.i).map((x) => x.c);
    const tree = new NoteTree(leaves);
    if ((await vaultT.noteRootOf(b.stablecoin)) !== tree.root())
      throw new Error("USDC note tree disagrees with the client");
    const myIndex = leaves.findIndex((l) => l === commitment);
    console.log(`   ✓ USDC tree matches the client; our leaf is #${myIndex} of ${leaves.length}`);

    // THE TRAP: the pool note must commit to the ERC-20 PRECOMPILE ADDRESS, not
    // the asset id. depositAsset takes the id, but the pool credits
    // escrow[precompileAddress] and reads the withdraw proof's asset signal back
    // as an address. Commit the id and the later withdrawal looks up an escrow
    // holding nothing and reverts "Insufficient balance" while the money sits
    // safely under the other key — 0.3 USDC is permanently stuck that way.
    const assetId = await vaultT.shieldAssetId(b.stablecoin);
    const ksAsset = ksPrecompileFor(assetId);
    const ksOut = { nullifier: rand(), secret: rand(), value: BUCKET, asset: ksAsset };
    const ksCommitment = poseidon2([poseidon2([ksOut.value, ksAsset]), poseidon2([ksOut.nullifier, ksOut.secret])]);

    const { elements, indices } = tree.path(myIndex);
    const spend = await snarkjs.groth16.fullProve({
      root: tree.root().toString(), nullifierHash: poseidon1([note.nullifier]).toString(),
      bucket: BUCKET.toString(), ksCommitment: ksCommitment.toString(),
      nullifier: note.nullifier.toString(), secret: note.secret.toString(),
      pathElements: elements.map(String), pathIndices: indices,
    }, path.join(ROOT, "circuits/build/shieldnote_js/shieldnote.wasm"),
       path.join(ROOT, "circuits/build/shieldnote.zkey"));
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[4]", "uint256[2]"],
      [[spend.proof.pi_a[0], spend.proof.pi_a[1]],
       [spend.proof.pi_b[0][1], spend.proof.pi_b[0][0], spend.proof.pi_b[1][1], spend.proof.pi_b[1][0]],
       [spend.proof.pi_c[0], spend.proof.pi_c[1]]]);

    const pool = new ethers.Contract(KS_POOL, [
      "function withdraw(uint[2],uint[2][2],uint[2],uint[8],address)",
      "function treeSize() view returns(uint256)", "function sideNodes(uint256) view returns(uint256)",
      "function currentRoot() view returns(uint256)",
    ], prov);
    const ksStart = Number(await pool.treeSize());
    const preSide = [];
    for (let lv = 0; lv < 128; lv++) preSide.push((await pool.sideNodes(lv)).toString());

    // Submitted by the VENUE, not the driver: the call is permissionless and the
    // proof binds the destination, so the submitter can neither be linked to the
    // note nor redirect it. Using a third party is the point.
    const sTx = await vaultT.connect(V).depositShieldNoteTokenZK(
      encoded, tree.root(), spend.publicSignals[1], b.stablecoin, BUCKET, b32(ksCommitment),
      { gasLimit: 5_000_000n });
    const sRec = await rec(prov, { step: "S.shield-spend", party: "venue(third party)", action: "depositShieldNoteTokenZK", hash: sTx.hash, tokenValue: BUCKET });

    // The privacy claim, checked rather than asserted.
    const sFull = await prov.getTransaction(sTx.hash);
    const blob = (sFull.data + sRec.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    if (blob.includes(D.address.slice(2).toLowerCase())) throw new Error("the spend leaked the driver's address");
    if (blob.includes(commitment.toString(16).padStart(64, "0"))) throw new Error("the spend leaked the note commitment");
    console.log(`   ✓ the spend names neither the driver nor the note`);

    // ── 9. Out of the pool, to an address that has never been seen ───────────
    const ksIndex = ksStart; // our leaf is the one just inserted
    const siblings = [];
    for (let lv = 0; lv < 128; lv++) siblings.push(((BigInt(ksIndex) >> BigInt(lv)) & 1n) === 1n ? preSide[lv] : "0");
    let node = ksCommitment;
    for (let lv = 0; lv < 128; lv++) if (((BigInt(ksIndex) >> BigInt(lv)) & 1n) === 1n) node = poseidon2([BigInt(siblings[lv]), node]);
    const ksRoot = await pool.currentRoot();
    if (node !== ksRoot) throw new Error("KS: our leaf is not the last one (deposit race) — re-run");

    const fresh = ethers.Wallet.createRandom().address;
    const change = { nullifier: rand(), secret: rand() };
    const ctx = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [fresh]))) % BN254_R;
    const w = await snarkjs.groth16.fullProve({
      withdrawnValue: BUCKET.toString(), treeDepth: "128", context: ctx.toString(),
      root: ksRoot.toString(), asset: ksAsset.toString(), existingValue: BUCKET.toString(),
      existingNullifier: ksOut.nullifier.toString(), existingSecret: ksOut.secret.toString(),
      newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(),
      siblings, leafIndex: String(ksIndex),
    }, WITHDRAW_WASM, loadWithdrawZkey());
    const wPB = [[w.proof.pi_b[0][1], w.proof.pi_b[0][0]], [w.proof.pi_b[1][1], w.proof.pi_b[1][0]]];
    console.log(`\n9. withdraw ${fmt6(BUCKET)} USDC from the pool → fresh address ${fresh}`);
    const before = await USDC.balanceOf(fresh);
    const wTx = await pool.connect(V).withdraw(
      [w.proof.pi_a[0], w.proof.pi_a[1]], wPB, [w.proof.pi_c[0], w.proof.pi_c[1]], w.publicSignals, fresh,
      { gasLimit: 3_000_000n });
    await rec(prov, { step: "S.pool-withdraw", party: "venue(third party)", action: "KS.withdraw→fresh(USDC)", hash: wTx.hash, tokenValue: BUCKET });
    const after = await USDC.balanceOf(fresh);
    if (after <= before) throw new Error("the fresh address received no USDC");
    console.log(`   ✓ fresh address holds ${fmt6(after)} USDC, and nothing on-chain ties it to the driver`);
    st.driverShielded = { bucket: BUCKET.toString(), fresh, received: after.toString() }; saveSt(st);
  }

  // Whatever was below the smallest rung leaves by the public path — the
  // residue is deliberate, since a bespoke small note would be unique and
  // therefore self-identifying.
  const bDLeft = await vault.tokenBalanceOf(b.stablecoin, D.address);
  if (!st.driverPaid && bDLeft > 0n) { const tx = await vault.connect(D).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(D).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "S.payout-driver-residue", party: "driver", action: "withdrawToken (residue)", hash: tx.hash, tokenValue: bDLeft }); st.driverPaid = true; saveSt(st); }

  console.log(`\n   venue wallet USDC now: ${fmt6(await USDC.balanceOf(V.address))}   driver wallet USDC now: ${fmt6(await USDC.balanceOf(D.address))}`);
  // Finding 28: this is the line that used to lie. Every phase is guarded on a
  // persisted flag, so a run over finished state skipped all of them and still
  // got here. Reaching the end is not the claim — sending transactions is.
  if (txCount === 0) {
    throw new Error(
      "this run sent NO transactions — every phase was skipped as already done, so nothing was verified. " +
      (RESUME ? "Drop RESUME=1 to run a fresh order." : "Delete the state file or investigate.")
    );
  }
  console.log(`\n✅ STABLECOIN e2e complete. orderId=${st.orderId}. ${txCount} transaction${txCount === 1 ? "" : "s"} sent this run.`);
  console.log(`   Ledger: ${path.relative(ROOT, LEDGER)}`);
}
const fmt6 = (x) => (Number(x) / 1e6).toString();

runScript(main, (e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  console.error(e?.stack?.split("\n").slice(0, 3).join("\n"));
});
