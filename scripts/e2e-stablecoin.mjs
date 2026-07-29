// Live stablecoin (C3) e2e on Paseo — the full delivery lifecycle escrowed and
// settled ENTIRELY in REAL Asset Hub USDC (asset 1337, via its ERC-20
// precompile), the ERC-20 path:
//   KS-shielded gas + KS-shielded USDC → approve → createOrderERC20 → commitBid →
//   acceptSealedBidERC20 → confirmPickup
//   → confirmDropoffZK → withdrawToken payouts.
// Reuses the registered venue (id 3) + driver from the native e2e; a fresh
// customer holds USDC (escrow) + PAS (gas). Settlement is submitted by the
// venue-node relay wallet (the F6 rebate accrues in USDC). Every tx is recorded.
import { ethers } from "ethers";
import { poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import { WITHDRAW_WASM, loadWithdrawZkey } from "./shield/zkey.mjs";
import fs from "fs";
import path from "path";
import {
  ROOT, provider, book, env, loadState, waitTx, leanGas, GAS_PRICE_WEI, fmt, eth, runScript,
  KS_POOL, ksShieldedFund,
} from "./shield/e2e-lib.mjs";

// Sealed bids are the only bid path. A fixed salt is fine for a scripted run:
// in production the driver picks it and it travels to the customer off-chain.
const BID_SALT = ethers.keccak256(ethers.toUtf8Bytes("fare-e2e-bid"));
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

const OUT = path.join(ROOT, "e2e-runs", "e2e-stablecoin");
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
  const NEED = ORDER_VALUE + TIP + FARE + usdc(5); // + headroom for the service fee
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
    await rec(prov, { step: "S.ksGasWithdraw", party: "ks-submitter", action: "KS.proxy_withdraw→burner(PAS)", hash: kg.withdrawHash });

    console.log(`\n1b. KS shield USDC ESCROW → burner (${fmt6(NEED)} USDC, asset 1337, unlinked)`);
    const ku = await ksShieldedFund({ ...ks, amount: NEED, assetId: 1337 });
    await rec(prov, { step: "S.ksUsdcDeposit", party: "customer-main", action: "KS.depositAsset(USDC)", hash: ku.depositHash, tokenValue: NEED });
    await rec(prov, { step: "S.ksUsdcWithdraw", party: "ks-submitter", action: "KS.proxy_withdraw→burner(USDC)", hash: ku.withdrawHash, tokenValue: NEED });

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
  console.log(`   status ${await orders.statusOf(orderId)} (2=Assigned)`);

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
    // THE economics assertion: this is the reward-bearing call, so the guard
    // values the USDC service fee in native and compares it to the order's
    // cumulative relayed gas x RELAY_MIN_MARGIN. A 402 means a token order does
    // not pay for itself.
    const out = await relayPost("/submit", { method: "confirmDropoffZK", args: [dAtt, dSig, proofBytes, pub] });
    await rec(prov, { step: "S.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", hash: out.txHash });
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

runScript(main, (e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  console.error(e?.stack?.split("\n").slice(0, 3).join("\n"));
});
