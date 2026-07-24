// Combined privacy + stablecoin e2e on Paseo:
//   1. KS shields the burner's GAS  — main deposits PAS → relay proxy_withdraws
//      to a fresh burner (unlinked to main).
//   2. USDC to the burner           — open MockUSDC mint (the testnet "shared
//      faucet" analog for the escrow value; mainnet would need a USDC-shielding
//      path — the honest gap).
//   3. Burner runs a USDC-escrowed order (createOrderERC20 → acceptBidERC20),
//      relay settles gaslessly (dual-sig pickup + ZK dropoff — no coords on-chain),
//      payouts in USDC, then the burner shielded-returns its leftover PAS gas.
//
// So: gas shielded, order identity unlinked, location private, value in USDC.
import { ethers } from "ethers";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { ROOT, provider, book, env, loadState, waitTx, leanGas, GAS_PRICE_WEI, KS_POOL, fmt, eth } from "./shield/e2e-lib.mjs";

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
const usdc = (n) => BigInt(Math.round(n * 1e6));
const fmt6 = (x) => (Number(x) / 1e6).toString();
const bit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;

const KS_FUND = eth("10");              // PAS to shield for the burner's gas
const ORDER_VALUE = usdc(3), TIP = usdc(0.5), MAX_FARE = usdc(2), FARE = usdc(1.5);
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 };
const snap = (v) => Math.round(v / 300) * 300;
const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));
const commitmentOf = (n) => poseidon2([poseidon2([n.value, 0n]), poseidon2([n.nullifier, n.secret])]);

const OUT = path.join(ROOT, "e2e-runs", "e2e-combined");
const LEDGER = path.join(OUT, "ledger.json");
const SCRATCH = process.env.E2E_SCRATCH || "/tmp/claude-1000/-home-k-Documents-fare/b72267a7-e6ed-4ea1-a42c-ce13603eacaa/scratchpad";
const STATE = path.join(SCRATCH, "e2e-combined-state.json");
const loadC = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const saveC = (s) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };
function append(e) { fs.mkdirSync(OUT, { recursive: true }); const l = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : []; l.push(e); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }
async function rec(prov, { step, party, action, hash, pas, tokenValue }) {
  const rc = await waitTx(prov, hash, action);
  const fee = (rc.gasUsed ?? 0n) * GAS_PRICE_WEI;
  append({ step, party, action, from: rc.from, to: rc.to, pas: pas != null ? ethers.formatEther(pas) : "", usdc: tokenValue != null ? fmt6(tokenValue) : "", hash, block: rc.blockNumber, status: rc.status, gasUsed: (rc.gasUsed ?? 0n).toString(), feePAS: ethers.formatEther(fee) });
  console.log(`   ✓ ${action} [${party}] status ${rc.status} gas ${rc.gasUsed} fee ${ethers.formatEther(fee)} PAS${pas != null ? ` value ${ethers.formatEther(pas)} PAS` : ""}${tokenValue != null ? ` value ${fmt6(tokenValue)} USDC` : ""}`);
  return rc;
}

const KS_ABI = ["function depositNative(bytes32) payable", "function proxy_withdraw(uint[2],uint[2][2],uint[2],uint[8],address)", "function currentRoot() view returns(uint256)", "function treeSize() view returns(uint256)", "function sideNodes(uint256) view returns(uint256)"];

async function main() {
  const prov = provider();
  const b = book();
  const e2e = loadState();
  const st = loadC();
  const chainId = e2e.chainId;
  const main = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), prov); // customer-main + USDC faucet
  const R = new ethers.Wallet(e2e.wallets.relay.privateKey, prov);   // relay: submits withdrawal + settlement
  const V = new ethers.Wallet(e2e.wallets.venue.privateKey, prov);
  const D = new ethers.Wallet(e2e.wallets.driver.privateKey, prov);
  st.burner = st.burner || (() => { const w = ethers.Wallet.createRandom(); return { address: w.address, privateKey: w.privateKey }; })();
  saveC(st);
  const burner = new ethers.Wallet(st.burner.privateKey, prov);
  console.log(`combined run — burner ${burner.address}  venueId ${e2e.venueId}`);

  const USDC = new ethers.Contract(b.stablecoin, ["function mint(address,uint256)", "function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], main);
  const orders = new ethers.Contract(b.orders, [
    "function createOrderERC20(address,uint64,bytes32,uint96,uint96,uint96,uint64,uint64) returns(uint256)",
    "function placeBid(uint256,uint96)", "function acceptBidERC20(uint256,address)",
    "function nextOrderId() view returns(uint256)", "function statusOf(uint256) view returns(uint8)",
    "function dropCommitOf(uint256) view returns(bytes32)", "function treasury() view returns(address)",
  ], prov);
  const vault = new ethers.Contract(b.vault, ["function tokenBalanceOf(address,address) view returns(uint256)", "function withdrawToken(address)"], prov);

  // ── 1. KS shielded GAS funding: deposit (main) → proxy_withdraw (relay) → burner
  const ks = new ethers.Contract(KS_POOL, KS_ABI, main);
  if (!st.ksNote) {
    console.log(`\n1a. KS depositNative ${fmt(KS_FUND)} PAS (customer-main)`);
    const note = { nullifier: rand(), secret: rand(), value: KS_FUND };
    const tx = await ks.depositNative(b32(commitmentOf(note)), { value: KS_FUND, gasLimit: 3_000_000n, nonce: await prov.getTransactionCount(main.address) });
    await rec(prov, { step: "K.deposit", party: "customer-main", action: "KS.depositNative", hash: tx.hash, pas: KS_FUND });
    st.ksNote = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), value: note.value.toString() };
    saveC(st);
  }
  if (!st.ksWithdraw) {
    console.log(`\n1b. proxy_withdraw → burner (relay submits; last-leaf reconstruction)`);
    const note = { nullifier: BigInt(st.ksNote.nullifier), secret: BigInt(st.ksNote.secret), value: BigInt(st.ksNote.value) };
    const commitment = commitmentOf(note);
    const size = Number(await ks.treeSize()); const idx = size - 1;
    const siblings = [];
    for (let lv = 0; lv < 128; lv++) siblings.push(bit(idx, lv) ? (await ks.sideNodes(lv)).toString() : "0");
    let node = commitment;
    for (let lv = 0; lv < 128; lv++) if (bit(idx, lv)) node = poseidon2([BigInt(siblings[lv]), node]);
    const root = await ks.currentRoot();
    if (node !== root) throw new Error("not last leaf (insert race) — retry");
    const change = { nullifier: rand(), secret: rand(), value: 0n };
    const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [burner.address]))) % BN254_R;
    const input = { withdrawnValue: note.value.toString(), treeDepth: "128", context: context.toString(), root: root.toString(), asset: "0", existingValue: note.value.toString(), existingNullifier: note.nullifier.toString(), existingSecret: note.secret.toString(), newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(), siblings, leafIndex: idx.toString() };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(ROOT, "web/public/shield/withdraw_v7.wasm"), path.join(ROOT, "web/public/shield/withdraw_v7.zkey"));
    const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];
    const tx = await ks.connect(R).proxy_withdraw([proof.pi_a[0], proof.pi_a[1]], pB, [proof.pi_c[0], proof.pi_c[1]], publicSignals, burner.address, { gasLimit: 8_000_000n, nonce: await prov.getTransactionCount(R.address) });
    await rec(prov, { step: "K.withdraw", party: "relay(venue-node)", action: "KS.proxy_withdraw→burner", hash: tx.hash });
    console.log(`   burner PAS: ${fmt(await prov.getBalance(burner.address))} (shielded gas, unlinked to main)`);
    st.ksWithdraw = tx.hash; saveC(st);
  }

  // ── 2. USDC to the burner (open mint — testnet faucet analog for escrow value)
  if (!st.minted) {
    console.log(`\n2. mint 100 USDC → burner (testnet faucet analog) + approve orders`);
    const mt = await USDC.mint(burner.address, usdc(100), { gasLimit: 5_000_000n, nonce: await prov.getTransactionCount(main.address) });
    await rec(prov, { step: "C.mint", party: "faucet(mint)", action: "mint-USDC→burner", hash: mt.hash, tokenValue: usdc(100) });
    const ap = await USDC.connect(burner).approve(b.orders, ethers.MaxUint256, { gasLimit: await leanGas(USDC.connect(burner).approve, [b.orders, ethers.MaxUint256]) });
    await rec(prov, { step: "C.approve", party: "customer-burner", action: "USDC.approve(orders)", hash: ap.hash });
    st.minted = true; saveC(st);
  }

  // ── 3. Burner runs the USDC order ───────────────────────────────────────────
  if (!st.orderId) {
    const salt = rand();
    const dropCommit = positionCommit(DROP.lat, DROP.lon, salt);
    console.log(`\n3. createOrderERC20 from burner (USDC escrow ${fmt6(ORDER_VALUE + TIP)})`);
    const oc = orders.connect(burner);
    const nextId = await orders.nextOrderId();
    const args = [b.stablecoin, e2e.venueId, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0];
    const tx = await oc.createOrderERC20(...args, { gasLimit: await leanGas(oc.createOrderERC20, args) });
    await rec(prov, { step: "C.create", party: "customer-burner", action: "createOrderERC20", hash: tx.hash, tokenValue: ORDER_VALUE + TIP });
    st.orderId = nextId.toString(); st.salt = salt.toString(); st.dropCommit = dropCommit; saveC(st);
    console.log(`   orderId ${st.orderId}`);
  }
  const orderId = BigInt(st.orderId);
  if (!st.bid) { console.log(`\n4. driver placeBid ${fmt6(FARE)} USDC`); const od = orders.connect(D); const tx = await od.placeBid(orderId, FARE, { gasLimit: await leanGas(od.placeBid, [orderId, FARE]) }); await rec(prov, { step: "C.bid", party: "driver", action: "placeBid", hash: tx.hash }); st.bid = true; saveC(st); }
  if (!st.accepted) { console.log(`\n5. burner acceptBidERC20 (escrow fare ${fmt6(FARE)} USDC)`); const oc = orders.connect(burner); const tx = await oc.acceptBidERC20(orderId, D.address, { gasLimit: await leanGas(oc.acceptBidERC20, [orderId, D.address]) }); await rec(prov, { step: "C.accept", party: "customer-burner", action: "acceptBidERC20", hash: tx.hash, tokenValue: FARE }); st.accepted = true; saveC(st); }
  console.log(`   status ${await orders.statusOf(orderId)} (2=Assigned)`);

  // ── 4. Settlement (relay submits, gasless for burner) ───────────────────────
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: b.settlement };
  const settle = new ethers.Contract(b.settlement, [
    "function confirmPickup((uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes,(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes)",
    "function confirmDropoffZK((uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp),bytes,bytes,uint256[5])",
  ], R);
  if (!st.pickup) {
    console.log(`\n6. confirmPickup (relay submits)`);
    const now = Number((await prov.getBlock("latest")).timestamp);
    const dC = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
    const LOC = { LocationAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
    const dAtt = { orderId, phase: 1, actor: D.address, lat: dC.lat, lon: dC.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const tx = await settle.confirmPickup(dAtt, await D.signTypedData(domain, LOC, dAtt), vAtt, await V.signTypedData(domain, LOC, vAtt), { gasLimit: 500_000_000n });
    await rec(prov, { step: "C.pickup", party: "relay(venue-node)", action: "confirmPickup", hash: tx.hash });
    st.pickup = true; st.pickupCoarse = dC; saveC(st);
  }
  if (!st.dropoff) {
    console.log(`\n7. confirmDropoffZK (Groth16, relay submits)`);
    const salt = BigInt(st.salt), drvSalt = rand();
    const driverCommit = positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt);
    const nul = b32(poseidon2([salt, orderId]));
    const input = { orderId: orderId.toString(), dropCommit: BigInt(st.dropCommit).toString(), driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100", nullifier: BigInt(nul).toString(), custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: salt.toString(), drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString() };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
    const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]);
    const pub = [orderId.toString(), BigInt(st.dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nul).toString()];
    const now = Number((await prov.getBlock("latest")).timestamp);
    const DC = { DriverCommitAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };
    const dAtt = { orderId, phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
    const tx = await settle.confirmDropoffZK(dAtt, await D.signTypedData(domain, DC, dAtt), proofBytes, pub, { gasLimit: 500_000_000n });
    await rec(prov, { step: "C.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", hash: tx.hash });
    st.dropoff = true; saveC(st);
  }
  console.log(`   status ${await orders.statusOf(orderId)} (4=Delivered)`);

  // ── 5. USDC payouts ─────────────────────────────────────────────────────────
  const treasury = await orders.treasury();
  const [bV, bD, bT, bR] = await Promise.all([vault.tokenBalanceOf(b.stablecoin, V.address), vault.tokenBalanceOf(b.stablecoin, D.address), vault.tokenBalanceOf(b.stablecoin, treasury), vault.tokenBalanceOf(b.stablecoin, R.address)]);
  console.log(`\n8. Vault USDC — venue ${fmt6(bV)}  driver ${fmt6(bD)}  treasury ${fmt6(bT)}  relay ${fmt6(bR)}`);
  st.payouts = { venue: bV.toString(), driver: bD.toString(), treasury: bT.toString(), relay: bR.toString() }; saveC(st);
  if (!st.venuePaid && bV > 0n) { const tx = await vault.connect(V).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(V).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "C.pay-venue", party: "venue", action: "withdrawToken", hash: tx.hash, tokenValue: bV }); st.venuePaid = true; saveC(st); }
  if (!st.driverPaid && bD > 0n) { const tx = await vault.connect(D).withdrawToken(b.stablecoin, { gasLimit: await leanGas(vault.connect(D).withdrawToken, [b.stablecoin]) }); await rec(prov, { step: "C.pay-driver", party: "driver", action: "withdrawToken", hash: tx.hash, tokenValue: bD }); st.driverPaid = true; saveC(st); }

  // ── 6. Shielded return of leftover PAS gas ──────────────────────────────────
  if (!st.returned) {
    const bal = await prov.getBalance(burner.address);
    const dep = ((bal - eth("1.0")) / eth("0.001")) * eth("0.001");
    if (dep > 0n) {
      console.log(`\n9. shielded return: burner deposits ${fmt(dep)} PAS gas back into KS`);
      const note = { nullifier: rand(), secret: rand(), value: dep };
      const tx = await ks.connect(burner).depositNative(b32(commitmentOf(note)), { value: dep, gasLimit: 800_000n, nonce: await prov.getTransactionCount(burner.address) });
      await rec(prov, { step: "K.return", party: "customer-burner", action: "KS.depositNative(return)", hash: tx.hash, pas: dep });
    }
    st.returned = true; saveC(st);
  }
  console.log(`\n✅ COMBINED privacy+stablecoin e2e complete. orderId=${st.orderId}. Ledger: artifacts/e2e-combined/ledger.json`);
}
main().catch((e) => { console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e); console.error(e?.stack?.split("\n").slice(0, 3).join("\n")); process.exit(1); });
