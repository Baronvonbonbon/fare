#!/usr/bin/env node
// COMPLETELY-FRESH shielded e2e on Paseo Asset Hub — real USDC (asset 1337), all
// value routed through Kusama Shield + the local asset-conversion DEX, gaslessly
// via the REAL venue-node relay. Every party is a brand-new wallet.
//
//   phase `setup`  : mint fresh main / relay / driver / venue wallets, seed them
//                    from the deployer, register the driver + venue.  → state file
//   (then launch the relay with RELAY_PRIVATE_KEY = the fresh relay wallet)
//   phase `deliver`: main shields PAS → relay /shield-withdraw funds a fresh burner
//                    → burner COVERAGE-SWAPS PAS→USDC(1337) (the swap.mjs rail) →
//                    gasless createOrderERC20/acceptBidERC20 via relay /forward →
//                    driver bids → relay /submit confirmPickup + confirmDropoffZK →
//                    USDC splits to venue/driver/treasury/relay, each withdraws.
//
// Privacy: no main→burner edge (gas shielded via KS), and the escrow USDC is
// derived from shielded PAS via the burner-side swap — not a mint, not from main.
//
// Run:  node scripts/e2e-fresh-shielded.mjs setup
//       # start relay (see printed command), then:
//       node scripts/e2e-fresh-shielded.mjs deliver
// Deps: ethers, snarkjs, poseidon-lite (root), @polkadot/api (npm i @polkadot/api).
// Env:  DEPLOYER_PRIVATE_KEY, TESTNET_RPC, RELAY_URL (default http://127.0.0.1:8788),
//       AH_WSS.

import { ethers } from "ethers";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { priceNativePerToken, planCoverage, executeSwap, fallbackAccountId, RUNTIME_PALLETS_ADDR } from "../venue-node/swap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRATCH = process.env.E2E_SCRATCH || "/tmp/claude-1000/-home-k-Documents-fare/3ace98c1-e73d-4e80-8567-ffb6e0205219/scratchpad";
const STATE = path.join(SCRATCH, "e2e-fresh-state.json");
const OUT = path.join(ROOT, "e2e-runs", "e2e-fresh-shielded");
const LEDGER = path.join(OUT, "ledger.json");

const RPC = env("TESTNET_RPC") || "https://eth-rpc-testnet.polkadot.io/";
const AH_WSS = process.env.AH_WSS || "wss://asset-hub-paseo-rpc.n.dwellir.com";
const RELAY_URL = (process.env.RELAY_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
const KS_POOL = process.env.SHIELD_POOL || "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const USDC_1337 = "0x0000053900000000000000000000000001200000";
const GAS_PRICE_WEI = 1_000_000_000_000n; // 1000 gwei on Paseo AH

// economics (USDC 6-dp): order 3, tip 0.5, maxFare 2, fare 1.5 → escrow 5 USDC
const usdc = (n) => BigInt(Math.round(n * 1e6));
const ORDER_VALUE = usdc(3), TIP = usdc(0.5), MAX_FARE = usdc(2), FARE = usdc(1.5);
const NEED_USDC = ORDER_VALUE + TIP + FARE;         // total the burner must escrow
const KS_FUND = ethers.parseEther("10");            // PAS main shields for the burner
// Paseo reserves gasLimit × maxFeePerGas (2000 gwei) up-front, so seeds must cover
// each party's reservations: main = KS_FUND(10) + deposit 3M-gas (6); relay must
// cover the 500M-gas settlement reservation (1000 PAS) + proxy_withdraw 8M (16);
// driver/venue cover their 2M-gas actions (4 each).
const SEED = { main: "18", relay: "1100", driver: "6", venue: "6" }; // deployer→party PAS

// geo (San Francisco), ZK dropoff radius 100 m
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 };
const snap = (v) => Math.round(v / 300) * 300;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
const bit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;
const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));
const noteCommit = (n) => poseidon2([poseidon2([n.value, 0n]), poseidon2([n.nullifier, n.secret])]);
const fmt6 = (x) => (Number(x) / 1e6).toString();
const fmtP = (w) => ethers.formatEther(w);

function env(k) { try { return (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1]?.trim(); } catch { return undefined; } }
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const saveState = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
function ledger(entry) { fs.mkdirSync(OUT, { recursive: true }); const l = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : []; l.push(entry); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTx(prov, hash, label = "") {
  for (let i = 0; i < 240; i++) { const r = await prov.getTransactionReceipt(hash).catch(() => null); if (r?.blockNumber) return r; if (i && i % 15 === 0) console.log(`    …waiting ${label || hash.slice(0, 12)} (${i}s)`); await sleep(1000); }
  throw new Error(`receipt timeout ${hash} (${label})`);
}
async function rec(prov, party, action, hash, { usdc: uv, pas } = {}) {
  const rc = await waitTx(prov, hash, action);
  const fee = (rc.gasUsed ?? 0n) * GAS_PRICE_WEI;
  ledger({ party, action, from: rc.from, to: rc.to, usdc: uv != null ? fmt6(uv) : "", pas: pas != null ? fmtP(pas) : "", hash, block: rc.blockNumber, status: rc.status, gasUsed: (rc.gasUsed ?? 0n).toString(), feePAS: fmtP(fee) });
  console.log(`   ✓ ${action} [${party}] status ${rc.status} gas ${rc.gasUsed} fee ${fmtP(fee)} PAS${uv != null ? ` · ${fmt6(uv)} USDC` : ""}${pas != null ? ` · ${fmtP(pas)} PAS` : ""}`);
  return rc;
}
async function relayPost(pathname, body) {
  const res = await fetch(`${RELAY_URL}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.declined) throw new Error(`relay ${pathname} ${res.status}: ${JSON.stringify(j)}`);
  return j;
}
const book = () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
function provider() { return new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true }); }

// ── EIP-2771 ForwardRequest (mirrors web/src/relay.ts) ───────────────────────
const FWD_TYPES = { ForwardRequest: [ { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "gas", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "data", type: "bytes" } ] };
async function buildForward(signer, forwarderAddr, to, data, chainId, prov) {
  const fwd = new ethers.Contract(forwarderAddr, ["function nonces(address) view returns(uint256)"], prov);
  const from = await signer.getAddress();
  const nonce = await fwd.nonces(from);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const gas = 500_000n;
  const domain = { name: "FareForwarder", version: "1", chainId, verifyingContract: forwarderAddr };
  const signature = await signer.signTypedData(domain, FWD_TYPES, { from, to, value: 0n, gas, nonce, deadline: BigInt(deadline), data });
  return { from, to, value: "0", gas: gas.toString(), deadline, data, signature };
}

// ════════════════════════════════ SETUP ═════════════════════════════════════
async function setup() {
  const prov = provider();
  const b = book();
  const deployer = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), prov);
  const mk = () => { const w = ethers.Wallet.createRandom(); return { address: w.address, privateKey: w.privateKey }; };
  const st = { chainId: Number((await prov.getNetwork()).chainId), wallets: { main: mk(), relay: mk(), driver: mk(), venue: mk() } };
  console.log(`FRESH e2e setup — chainId ${st.chainId}`);
  for (const [role, w] of Object.entries(st.wallets)) console.log(`  ${role.padEnd(7)} ${w.address}`);

  // 1. seed the four fresh wallets from the deployer (sequential nonces)
  console.log(`\n1. seeding from deployer ${deployer.address}`);
  let nonce = await prov.getTransactionCount(deployer.address);
  for (const [role, amt] of Object.entries(SEED)) {
    const tx = await deployer.sendTransaction({ to: st.wallets[role].address, value: ethers.parseEther(amt), nonce: nonce++, gasLimit: 100_000n });
    await rec(prov, "deployer", `seed-${role}`, tx.hash, { pas: ethers.parseEther(amt) });
  }

  // 2. register the fresh driver (stake optional, minStake=0) + fresh venue
  const drivers = new ethers.Contract(b.drivers, ["function register(string) payable"], new ethers.Wallet(st.wallets.driver.privateKey, prov));
  const dtx = await drivers.register("fresh-e2e-driver", { gasLimit: 300_000n });
  await rec(prov, "driver", "FareDrivers.register", dtx.hash);

  const venues = new ethers.Contract(b.venues, ["function registerVenue(int32,int32,address,address,string) returns(uint64)", "event VenueRegistered(uint64 indexed venueId, address indexed operator, int32 lat, int32 lon, string metadataURI)"], new ethers.Wallet(st.wallets.venue.privateKey, prov));
  const vtx = await venues.registerVenue(VENUE.lat, VENUE.lon, st.wallets.venue.address, st.wallets.venue.address, "fresh-e2e-venue", { gasLimit: 400_000n });
  const vrc = await rec(prov, "venue", "FareVenues.registerVenue", vtx.hash);
  let venueId;
  for (const log of vrc.logs) { try { const p = venues.interface.parseLog(log); if (p?.name === "VenueRegistered") venueId = p.args.venueId; } catch {} }
  if (venueId == null) throw new Error("VenueRegistered not found");
  st.venueId = Number(venueId);

  // 3. Fund the Orders contract's account with PAS. Settlement crediting for a
  // real pallet-assets token (USDC 1337) calls IERC20(token).forceApprove(vault)
  // inside FareOrders._credit, and pallet-assets `approve` reserves an
  // ApprovalDeposit (0.01 PAS) from the caller = the Orders contract. Orders has
  // no payable receive (a plain EVM transfer to it reverts), so credit its
  // substrate account directly via a balances.transfer dispatched through the
  // RUNTIME_PALLETS_ADDR sentinel. Without this, confirmPickup/Dropoff revert 0x.
  if ((await prov.getBalance(b.orders)) < ethers.parseEther("0.5")) {
    console.log(`\n3. fund Orders contract 2 PAS (pallet-assets approval deposit) via substrate transfer`);
    const api = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
    try {
      const call = api.tx.balances.transferKeepAlive(fallbackAccountId(b.orders), (2n * 10n ** 10n).toString());
      const ftx = await deployer.sendTransaction({ to: RUNTIME_PALLETS_ADDR, data: call.method.toHex(), value: 0n, gasLimit: 2_000_000n });
      await rec(prov, "deployer", "fund-Orders (USDC approval deposit)", ftx.hash, { pas: ethers.parseEther("2") });
    } finally { await api.disconnect().catch(() => {}); }
  }
  saveState(st);
  console.log(`\n✅ setup done. venueId=${st.venueId}. Now launch the relay:\n`);
  console.log(`   RELAY_PRIVATE_KEY=${st.wallets.relay.privateKey} \\`);
  console.log(`   RELAY_RPC_URL=${RPC} RELAY_PROFIT_GUARD=off RELAY_TOKEN_PRICE=0.2496 \\`);
  console.log(`   SHIELD_POOL=${KS_POOL} SHIELD_FEE_PAS=0 \\`);
  console.log(`   node venue-node/relay.mjs\n   then: node scripts/e2e-fresh-shielded.mjs deliver`);
}

// ═══════════════════════════════ DELIVER ════════════════════════════════════
async function deliver() {
  const prov = provider();
  const b = book();
  const st = loadState();
  if (!st.wallets) throw new Error("no state — run `setup` first");
  const chainId = st.chainId;
  const main = new ethers.Wallet(st.wallets.main.privateKey, prov);
  const D = new ethers.Wallet(st.wallets.driver.privateKey, prov);
  const V = new ethers.Wallet(st.wallets.venue.privateKey, prov);
  const burnerW = ethers.Wallet.createRandom();
  const burner = new ethers.Wallet(burnerW.privateKey, prov);
  st.burner = { address: burner.address, privateKey: burner.privateKey }; saveState(st);
  console.log(`FRESH deliver — burner ${burner.address}  venueId ${st.venueId}`);

  const health = await (await fetch(`${RELAY_URL}/health`)).json();
  console.log(`relay ${health.relay} bal ${health.balance} PAS · forwarder ${health.forwarder} · shield ${health.shieldMode}`);
  if (health.forwarder?.toLowerCase() !== b.forwarder.toLowerCase()) throw new Error("relay forwarder != deployed forwarder");

  const api = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
  const USDC = new ethers.Contract(USDC_1337, ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], prov);
  const orders = new ethers.Contract(b.orders, [
    "function createOrderERC20(address,uint64,bytes32,uint96,uint96,uint96,uint64,uint64) returns(uint256)",
    "function placeBid(uint256,uint96)", "function acceptBidERC20(uint256,address)",
    "function statusOf(uint256) view returns(uint8)", "function treasury() view returns(address)",
    "event OrderCreated(uint256 indexed orderId, address indexed customer, uint64 indexed venueId, uint96 orderValue, uint96 tip, uint96 maxFare, bytes32 dropCommit)",
  ], prov);
  const vault = new ethers.Contract(b.vault, ["function tokenBalanceOf(address,address) view returns(uint256)", "function withdrawToken(address)"], prov);

  try {
    // ── 1. main shields PAS into KS ──────────────────────────────────────────
    console.log(`\n1. KS depositNative ${fmtP(KS_FUND)} PAS (fresh main)`);
    const ks = new ethers.Contract(KS_POOL, ["function depositNative(bytes32) payable", "function currentRoot() view returns(uint256)", "function treeSize() view returns(uint256)", "function sideNodes(uint256) view returns(uint256)"], main);
    const note = { nullifier: rand(), secret: rand(), value: KS_FUND };
    const dtx = await ks.depositNative(b32(noteCommit(note)), { value: KS_FUND, gasLimit: 3_000_000n });
    await rec(prov, "main", "KS.depositNative", dtx.hash, { pas: KS_FUND });

    // ── 2. relay /shield-withdraw funds the fresh burner (sponsor mode) ───────
    console.log(`\n2. build withdrawal proof (last-leaf) → relay /shield-withdraw → burner`);
    const size = Number(await ks.treeSize()), idx = size - 1;
    const siblings = [];
    for (let lv = 0; lv < 128; lv++) siblings.push(bit(idx, lv) ? (await ks.sideNodes(lv)).toString() : "0");
    let node = noteCommit(note);
    for (let lv = 0; lv < 128; lv++) if (bit(idx, lv)) node = poseidon2([BigInt(siblings[lv]), node]);
    const root = await ks.currentRoot();
    if (node !== root) throw new Error("not last leaf (someone deposited after us) — rerun deliver");
    const change = { nullifier: rand(), secret: rand(), value: 0n };
    const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [burner.address]))) % BN254_R;
    const input = { withdrawnValue: KS_FUND.toString(), treeDepth: "128", context: context.toString(), root: root.toString(), asset: "0", existingValue: KS_FUND.toString(), existingNullifier: note.nullifier.toString(), existingSecret: note.secret.toString(), newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(), siblings, leafIndex: idx.toString() };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(ROOT, "web/public/shield/withdraw_v7.wasm"), path.join(ROOT, "web/public/shield/withdraw_v7.zkey"));
    const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];
    const sw = await relayPost("/shield-withdraw", { pA: [proof.pi_a[0], proof.pi_a[1]], pB, pC: [proof.pi_c[0], proof.pi_c[1]], pubSignals: publicSignals, recipient: burner.address });
    await rec(prov, "relay", "KS.proxy_withdraw→burner (gasless)", sw.txHash);
    console.log(`   burner PAS: ${fmtP(await prov.getBalance(burner.address))} (shielded, unlinked to main)`);

    // ── 3. burner coverage-swaps PAS → USDC(1337) via the swap.mjs rail ───────
    console.log(`\n3. coverage swap: burner PAS → ${fmt6(NEED_USDC)} USDC (RUNTIME_PALLETS_ADDR)`);
    const price = await priceNativePerToken(1337, 6, { api });
    const plan = planCoverage({ haveNativeWei: await prov.getBalance(burner.address), needTokenWei: NEED_USDC, gasReserveNativeWei: ethers.parseEther("3"), tokenDecimals: 6, nativeDecimals: 18, price });
    if (!plan?.ok) throw new Error(`coverage plan failed: ${JSON.stringify(plan)}`);
    const swres = await executeSwap(plan, { signer: burner, assetId: 1337, api, gasLimit: 2_000_000n });
    await rec(prov, "burner", "coverageSwap PAS→USDC", swres.txHash, { usdc: NEED_USDC });
    console.log(`   burner USDC: ${fmt6(await USDC.balanceOf(burner.address))}  PAS: ${fmtP(await prov.getBalance(burner.address))}`);

    // ── 4. burner approves Orders for USDC (direct; gas from shielded PAS) ────
    // Approve the exact escrow total: the asset-1337 ERC20 precompile is backed by
    // pallet-assets, whose approval amount is a u128 — MaxUint256 overflows it and
    // reverts. createOrder pulls orderValue+tip, acceptBid pulls fare → NEED_USDC.
    console.log(`\n4. burner approve(Orders) ${fmt6(NEED_USDC)} USDC`);
    const ap = await USDC.connect(burner).approve(b.orders, NEED_USDC, { gasLimit: 500_000n });
    const aprc = await rec(prov, "burner", "USDC.approve(orders)", ap.hash);
    if (aprc.status !== 1) throw new Error("approve reverted");

    // ── 5. gasless createOrderERC20 via relay /forward ───────────────────────
    console.log(`\n5. createOrderERC20 (USDC escrow ${fmt6(ORDER_VALUE + TIP)}) — gasless via /forward`);
    const salt = rand(), dropCommit = positionCommit(DROP.lat, DROP.lon, salt);
    const createData = orders.interface.encodeFunctionData("createOrderERC20", [USDC_1337, st.venueId, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0]);
    const createReq = await buildForward(burner, b.forwarder, b.orders, createData, chainId, prov);
    const cf = await relayPost("/forward", { request: createReq });
    const crc = await rec(prov, "relay(fwd)", "createOrderERC20 (burner)", cf.txHash, { usdc: ORDER_VALUE + TIP });
    let orderId;
    for (const log of crc.logs) { try { const p = orders.interface.parseLog(log); if (p?.name === "OrderCreated") orderId = p.args.orderId; } catch {} }
    if (orderId == null) throw new Error("OrderCreated not found in /forward receipt");
    st.orderId = orderId.toString(); st.salt = salt.toString(); st.dropCommit = dropCommit; saveState(st);
    console.log(`   orderId ${st.orderId}`);

    // ── 6. driver bids (direct) ; burner accepts gasless via /forward ────────
    console.log(`\n6. driver placeBid ${fmt6(FARE)} USDC (direct)`);
    const bidTx = await orders.connect(D).placeBid(orderId, FARE, { gasLimit: 2_000_000n });
    await rec(prov, "driver", "placeBid", bidTx.hash);

    console.log(`\n7. acceptBidERC20 (escrow fare ${fmt6(FARE)}) — gasless via /forward`);
    const acceptData = orders.interface.encodeFunctionData("acceptBidERC20", [orderId, D.address]);
    const acceptReq = await buildForward(burner, b.forwarder, b.orders, acceptData, chainId, prov);
    const af = await relayPost("/forward", { request: acceptReq });
    await rec(prov, "relay(fwd)", "acceptBidERC20 (burner)", af.txHash, { usdc: FARE });
    console.log(`   status ${await orders.statusOf(orderId)} (2=Assigned)`);

    // ── 8. settlement via relay /submit (dual-sig pickup + ZK dropoff) ───────
    const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: b.settlement };
    const LOC = { LocationAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
    const DC = { DriverCommitAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };

    console.log(`\n8. confirmPickup (dual-sig) — gasless via /submit`);
    let now = Number((await prov.getBlock("latest")).timestamp);
    const dC = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
    const dAttP = { orderId: orderId.toString(), phase: 1, actor: D.address, lat: dC.lat, lon: dC.lon, timestamp: now };
    const vAttP = { orderId: orderId.toString(), phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const pk = await relayPost("/submit", { method: "confirmPickup", args: [dAttP, await D.signTypedData(domain, LOC, dAttP), vAttP, await V.signTypedData(domain, LOC, vAttP)] });
    const pkrc = await rec(prov, "relay", "confirmPickup", pk.txHash);
    if (pkrc.status !== 1) throw new Error("confirmPickup reverted (is the Orders contract funded with PAS for the USDC approval deposit?)");

    console.log(`\n9. confirmDropoffZK (Groth16, no coords) — gasless via /submit`);
    const drvSalt = rand();
    const driverCommit = positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt);
    const nul = b32(poseidon2([BigInt(st.salt), orderId]));
    const zkIn = { orderId: orderId.toString(), dropCommit: BigInt(st.dropCommit).toString(), driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100", nullifier: BigInt(nul).toString(), custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: st.salt, drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString() };
    const zk = await snarkjs.groth16.fullProve(zkIn, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
    const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0], zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1]]);
    const pub = [orderId.toString(), BigInt(st.dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nul).toString()];
    now = Number((await prov.getBlock("latest")).timestamp);
    const dAttD = { orderId: orderId.toString(), phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
    const dz = await relayPost("/submit", { method: "confirmDropoffZK", args: [dAttD, await D.signTypedData(domain, DC, dAttD), proofBytes, pub] });
    const dzrc = await rec(prov, "relay", "confirmDropoffZK", dz.txHash);
    if (dzrc.status !== 1) throw new Error("confirmDropoffZK reverted");
    console.log(`   status ${await orders.statusOf(orderId)} (4=Delivered)`);

    // ── 9. USDC splits → all parties, each withdraws ─────────────────────────
    const treasury = await orders.treasury();
    const relayAddr = health.relay;
    const parties = { venue: V.address, driver: D.address, treasury, relay: relayAddr };
    const bals = {};
    for (const [k, a] of Object.entries(parties)) bals[k] = await vault.tokenBalanceOf(USDC_1337, a);
    console.log(`\n10. Vault USDC splits — venue ${fmt6(bals.venue)}  driver ${fmt6(bals.driver)}  treasury ${fmt6(bals.treasury)}  relay ${fmt6(bals.relay)}  (Σ ${fmt6(bals.venue + bals.driver + bals.treasury + bals.relay)})`);
    st.payouts = Object.fromEntries(Object.entries(bals).map(([k, v]) => [k, v.toString()])); saveState(st);
    if (bals.venue > 0n) { const tx = await vault.connect(V).withdrawToken(USDC_1337, { gasLimit: 2_000_000n }); await rec(prov, "venue", "withdrawToken", tx.hash, { usdc: bals.venue }); }
    if (bals.driver > 0n) { const tx = await vault.connect(D).withdrawToken(USDC_1337, { gasLimit: 2_000_000n }); await rec(prov, "driver", "withdrawToken", tx.hash, { usdc: bals.driver }); }

    console.log(`\n✅ FRESH shielded e2e complete — orderId ${st.orderId}. USDC escrow was coverage-swapped from shielded PAS; splits paid to all parties. Ledger: ${path.relative(ROOT, LEDGER)}`);
  } finally { await api.disconnect().catch(() => {}); }
}

const phase = process.argv[2];
(phase === "setup" ? setup() : phase === "deliver" ? deliver() : Promise.reject(new Error("usage: e2e-fresh-shielded.mjs setup|deliver")))
  .then(() => process.exit(0))
  .catch((e) => { console.error("\n❌ FAILED:", e?.shortMessage ?? e?.message ?? e); console.error(e?.stack?.split("\n").slice(1, 4).join("\n")); process.exit(1); });
