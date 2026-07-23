// Live stablecoin (C3) e2e on Paseo — the full delivery lifecycle escrowed and
// settled ENTIRELY in USDC (6-decimal MockUSDC), the ERC-20 path:
//   mint + approve → createOrderERC20 → placeBid → acceptBidERC20 → confirmPickup
//   → confirmDropoffZK → withdrawToken payouts.
// Reuses the registered venue (id 3) + driver from the native e2e; a fresh
// customer holds USDC (escrow) + PAS (gas). Settlement is submitted by the
// venue-node relay wallet (the F6 rebate accrues in USDC). Every tx is recorded.
import { ethers } from "ethers";
import { poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import {
  ROOT, provider, book, env, loadState, waitTx, leanGas, GAS_PRICE_WEI, fmt, eth,
} from "./shield/e2e-lib.mjs";

const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const usdc = (n) => BigInt(Math.round(n * 1e6)); // 6 decimals
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// amounts (USDC)
const ORDER_VALUE = usdc(3), TIP = usdc(0.5), MAX_FARE = usdc(2), FARE = usdc(1.5);
// geometry (same SF venue as the native run)
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 };
const snap = (v) => Math.round(v / 300) * 300;
const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));

const OUT = path.join(ROOT, "artifacts", "e2e-stablecoin");
const LEDGER = path.join(OUT, "ledger.json");
const STATE = path.join(process.env.E2E_SCRATCH || "/tmp/claude-1000/-home-k-Documents-fare/b72267a7-e6ed-4ea1-a42c-ce13603eacaa/scratchpad", "e2e-stablecoin-state.json");
const loadSt = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const saveSt = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
function appendLedger(e) { fs.mkdirSync(OUT, { recursive: true }); const l = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : []; l.push(e); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }

async function rec(prov, { step, party, action, hash, tokenValue }) {
  const rc = await waitTx(prov, hash, action);
  const fee = (rc.gasUsed ?? 0n) * GAS_PRICE_WEI;
  const e = { step, party, action, from: rc.from, to: rc.to, usdc: tokenValue != null ? (Number(tokenValue) / 1e6).toString() : "", hash, block: rc.blockNumber, status: rc.status, gasUsed: (rc.gasUsed ?? 0n).toString(), feePAS: ethers.formatEther(fee) };
  appendLedger(e);
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

  const USDC = new ethers.Contract(b.stablecoin, [
    "function mint(address,uint256)", "function approve(address,uint256) returns(bool)",
    "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  ], deployer);
  const orders = new ethers.Contract(b.orders, [
    "function createOrderERC20(address,uint64,bytes32,uint96,uint96,uint96,uint64,uint64) returns(uint256)",
    "function placeBid(uint256,uint96)", "function acceptBidERC20(uint256,address)",
    "function nextOrderId() view returns(uint256)", "function statusOf(uint256) view returns(uint8)",
    "function dropCommitOf(uint256) view returns(bytes32)", "function treasury() view returns(address)", "function feeBps() view returns(uint16)",
  ], prov);
  const vault = new ethers.Contract(b.vault, ["function tokenBalanceOf(address,address) view returns(uint256)", "function withdrawToken(address)"], prov);

  // ── 1. Fund customer: PAS (gas) from deployer + mint USDC + approve ─────────
  if (!st.funded) {
    console.log(`\n1. Fund customer — PAS gas + mint 100 USDC + approve orders`);
    let nonce = await prov.getTransactionCount(deployer.address);
    const t1 = await deployer.sendTransaction({ to: C.address, value: eth("30"), gasLimit: 200_000n, nonce: nonce++ });
    await rec(prov, { step: "S.fund", party: "infra", action: "fund-customer-gas", hash: t1.hash });
    const t2 = await USDC.mint(C.address, usdc(100), { gasLimit: 5_000_000n, nonce: nonce++ });
    await rec(prov, { step: "S.mint", party: "infra", action: "mint-USDC→customer", hash: t2.hash, tokenValue: usdc(100) });
    const ua = await USDC.connect(C).approve(b.orders, ethers.MaxUint256, { gasLimit: await leanGas(USDC.connect(C).approve, [b.orders, ethers.MaxUint256]) });
    await rec(prov, { step: "S.approve", party: "customer", action: "USDC.approve(orders)", hash: ua.hash });
    st.funded = true; saveSt(st);
  }
  console.log(`   customer USDC ${fmt6(await USDC.balanceOf(C.address))}  allowance ${(await USDC.allowance(C.address, b.orders)) === ethers.MaxUint256 ? "MAX" : "set"}`);

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

  // ── 3. driver placeBid ─────────────────────────────────────────────────────
  if (!st.bid) {
    console.log(`\n3. driver placeBid ${fmt6(FARE)} USDC`);
    const od = orders.connect(D);
    const tx = await od.placeBid(orderId, FARE, { gasLimit: await leanGas(od.placeBid, [orderId, FARE]) });
    await rec(prov, { step: "S.bid", party: "driver", action: "placeBid", hash: tx.hash });
    st.bid = true; saveSt(st);
  }

  // ── 4. acceptBidERC20 (pulls fare in USDC) ─────────────────────────────────
  if (!st.accepted) {
    console.log(`\n4. customer acceptBidERC20 (escrows fare ${fmt6(FARE)} USDC)`);
    const oc = orders.connect(C);
    const tx = await oc.acceptBidERC20(orderId, D.address, { gasLimit: await leanGas(oc.acceptBidERC20, [orderId, D.address]) });
    await rec(prov, { step: "S.accept", party: "customer", action: "acceptBidERC20", hash: tx.hash, tokenValue: FARE });
    st.accepted = true; saveSt(st);
  }
  console.log(`   status ${await orders.statusOf(orderId)} (2=Assigned)`);

  // ── 5. confirmPickup (dual-sig, relay submits) ─────────────────────────────
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: b.settlement };
  const settle = new ethers.Contract(b.settlement, [
    "function confirmPickup((uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes,(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes)",
    "function confirmDropoffZK((uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp),bytes,bytes,uint256[5])",
    "function dropoffRadiusMeters() view returns(uint32)",
  ], R);
  if (!st.pickup) {
    console.log(`\n5. confirmPickup (driver+venue dual-sign, relay submits)`);
    const now = Number((await prov.getBlock("latest")).timestamp);
    const dC = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
    const LOC = { LocationAttestation: [ { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" } ] };
    const dAtt = { orderId, phase: 1, actor: D.address, lat: dC.lat, lon: dC.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const dSig = await D.signTypedData(domain, LOC, dAtt), vSig = await V.signTypedData(domain, LOC, vAtt);
    const tx = await settle.confirmPickup(dAtt, dSig, vAtt, vSig, { gasLimit: 500_000_000n });
    await rec(prov, { step: "S.pickup", party: "relay(venue-node)", action: "confirmPickup", hash: tx.hash });
    st.pickup = true; st.pickupCoarse = dC; saveSt(st);
  }
  console.log(`   status ${await orders.statusOf(orderId)} (3=PickedUp)`);

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
    const tx = await settle.confirmDropoffZK(dAtt, dSig, proofBytes, pub, { gasLimit: 500_000_000n });
    await rec(prov, { step: "S.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", hash: tx.hash });
    st.dropoff = true; saveSt(st);
  }
  console.log(`   status ${await orders.statusOf(orderId)} (4=Delivered)`);

  // ── 7. token payouts + verify splits ───────────────────────────────────────
  const treasury = await orders.treasury(), feeBps = await orders.feeBps();
  const [bV, bD, bT, bR] = await Promise.all([vault.tokenBalanceOf(b.stablecoin, V.address), vault.tokenBalanceOf(b.stablecoin, D.address), vault.tokenBalanceOf(b.stablecoin, treasury), vault.tokenBalanceOf(b.stablecoin, R.address)]);
  console.log(`\n7. Vault USDC balances — venue ${fmt6(bV)}  driver ${fmt6(bD)}  treasury ${fmt6(bT)}  relay ${fmt6(bR)} (feeBps ${feeBps})`);
  st.payouts = { venue: bV.toString(), driver: bD.toString(), treasury: bT.toString(), relay: bR.toString(), treasuryAddr: treasury }; saveSt(st);

  if (!st.venuePaid && bV > 0n) { const tx = await vault.connect(V).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(V).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "S.payout-venue", party: "venue", action: "withdrawToken", hash: tx.hash, tokenValue: bV }); st.venuePaid = true; saveSt(st); }
  if (!st.driverPaid && bD > 0n) { const tx = await vault.connect(D).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(D).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "S.payout-driver", party: "driver", action: "withdrawToken", hash: tx.hash, tokenValue: bD }); st.driverPaid = true; saveSt(st); }

  console.log(`\n   venue wallet USDC now: ${fmt6(await USDC.balanceOf(V.address))}   driver wallet USDC now: ${fmt6(await USDC.balanceOf(D.address))}`);
  console.log(`\n✅ STABLECOIN e2e complete. orderId=${st.orderId}. Ledger: artifacts/e2e-stablecoin/ledger.json`);
}
const fmt6 = (x) => (Number(x) / 1e6).toString();

main().catch((e) => { console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e); console.error(e?.stack?.split("\n").slice(0, 3).join("\n")); process.exit(1); });
