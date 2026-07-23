// Phase B — the live delivery, funded through Kusama Shield.
//
//   1. customer-main deposits 5 PAS into the KS pool (the only linkable step)
//   2. relay submits proxy_withdraw → the fresh burner receives 5 PAS, UNLINKED
//   3. burner: createOrder → driver bids → burner acceptBid
//   4. relay (gasless): confirmPickup (dual-sig GPS) → confirmDropoffZK (Groth16)
//   5. venue & driver pull their payouts from the vault
//   6. shielded return: burner re-deposits its residual into the KS pool
//
// Every transaction is appended to artifacts/e2e-live/ledger.json via record().
import { ethers } from "ethers";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import {
  ROOT, provider, book, env, loadState, saveState, record, waitTx, leanGas, sleep,
  KS_POOL, fmt, eth,
} from "./e2e-lib.mjs";

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const RELAY_URL = process.env.RELAY_URL || "http://localhost:8788";

// ── amounts & geometry ───────────────────────────────────────────────────────
const KS_FUND = eth("5");          // deposit → withdraw to fund the burner
const ORDER_VALUE = eth("0.3");    // goods (→ venue)
const TIP = eth("0.05");           // (→ driver)
const MAX_FARE = eth("0.2");
const FARE = eth("0.15");          // winning bid (→ driver, minus 2.5% fee)

const VENUE = { lat: 37_774_900, lon: -122_419_400 };      // public pin (SF)
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 }; // ~24 m from venue (coarsened before signing)
const DROP = { lat: 37_784_900, lon: -122_419_400 };       // customer home — PRIVATE (commit only)
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 }; // ~33 m from drop — PRIVATE (ZK witness)
const PICKUP_GRID = 300; // µdeg (~33 m) — geo.snapToGrid
const snap = (v) => Math.round(v / PICKUP_GRID) * PICKUP_GRID;

const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;

const KS_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
];
const toSol = (p) => ({
  pA: [p.pi_a[0], p.pi_a[1]],
  pB: [[p.pi_b[0][1], p.pi_b[0][0]], [p.pi_b[1][1], p.pi_b[1][0]]],
  pC: [p.pi_c[0], p.pi_c[1]],
});

async function relaySubmit(method, args) {
  const res = await fetch(`${RELAY_URL}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const j = await res.json();
  if (!res.ok || !j.txHash) throw new Error(`relay ${method} failed: ${JSON.stringify(j)}`);
  return j.txHash;
}

async function main() {
  const prov = provider();
  const bk = book();
  const st = loadState();
  const main = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), prov); // customer-main
  const relay = new ethers.Wallet(st.wallets.relay.privateKey, prov);
  const burner = new ethers.Wallet(st.wallets.burner.privateKey, prov);
  const V = new ethers.Wallet(st.wallets.venue.privateKey, prov);
  const D = new ethers.Wallet(st.wallets.driver.privateKey, prov);
  st.run = st.run || {};
  const chainId = st.chainId;
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: bk.settlement };

  const WWASM = path.join(ROOT, "web/public/shield/withdraw_v7.wasm");
  const WZKEY = path.join(ROOT, "web/public/shield/withdraw_v7.zkey");
  const PWASM = path.join(ROOT, "web/public/zk/proximity.wasm");
  const PZKEY = path.join(ROOT, "web/public/zk/proximity.zkey");

  // ─── 1. KS deposit (customer-main → pool) ──────────────────────────────────
  const ks = new ethers.Contract(KS_POOL, KS_ABI, main);
  if (!st.run.ksFundNote) {
    console.log(`\n1. KS depositNative(${fmt(KS_FUND)} PAS) from customer-main`);
    const note = { nullifier: rand(), secret: rand(), value: KS_FUND };
    const commitment = poseidon2([poseidon2([note.value, 0n]), poseidon2([note.nullifier, note.secret])]);
    const nonce = await prov.getTransactionCount(main.address);
    const tx = await ks.depositNative(b32(commitment), { value: KS_FUND, gasLimit: 3_000_000n, nonce });
    await record(prov, { step: "B.ks-deposit", party: "customer-main", action: "KS.depositNative", value: KS_FUND, hash: tx.hash });
    st.run.ksFundNote = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), value: note.value.toString() };
    saveState(st);
  } else console.log("\n1. = KS deposit already done");

  // ─── 2. Withdraw the note to the fresh burner (relay pays gas) ──────────────
  if (!st.run.ksWithdrawHash) {
    console.log(`\n2. Build withdrawal proof (last-leaf) → proxy_withdraw to burner ${burner.address}`);
    const note = {
      nullifier: BigInt(st.run.ksFundNote.nullifier),
      secret: BigInt(st.run.ksFundNote.secret),
      value: BigInt(st.run.ksFundNote.value),
    };
    const commitment = poseidon2([poseidon2([note.value, 0n]), poseidon2([note.nullifier, note.secret])]);
    // Our note is the rightmost leaf: its path siblings are the persistent
    // on-chain sideNodes at the set bits of its index (probe's shortcut).
    let mp, idx;
    for (let attempt = 0; attempt < 6; attempt++) {
      const size = Number(await ks.treeSize());
      idx = size - 1;
      const bit = (lv) => ((BigInt(idx) >> BigInt(lv)) & 1n) === 1n;
      const siblings = [];
      for (let lv = 0; lv < 128; lv++) siblings.push(bit(lv) ? (await ks.sideNodes(lv)).toString() : "0");
      let node = commitment;
      for (let lv = 0; lv < 128; lv++) if (bit(lv)) node = poseidon2([BigInt(siblings[lv]), node]);
      const onchainRoot = await ks.currentRoot();
      if (node === onchainRoot) { mp = { siblings, root: onchainRoot.toString() }; break; }
      console.log(`   root mismatch (attempt ${attempt}); someone inserted after us — retrying in 5s`);
      await sleep(5000);
    }
    if (!mp) throw new Error("could not confirm our note is the rightmost leaf (KS insert race)");

    const change = { nullifier: rand(), secret: rand(), value: 0n };
    const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [burner.address]))) % BN254_R;
    const input = {
      withdrawnValue: note.value.toString(), treeDepth: "128", context: context.toString(),
      root: mp.root, asset: "0", existingValue: note.value.toString(),
      existingNullifier: note.nullifier.toString(), existingSecret: note.secret.toString(),
      newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(),
      siblings: mp.siblings, leafIndex: idx.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WWASM, WZKEY);
    const nh = poseidon1([note.nullifier]);
    console.log(`   proof ok; nullifierHash ${publicSignals[1].slice(0, 14)}… (expect ${nh.toString().slice(0, 14)}…)`);
    const { pA, pB, pC } = toSol(proof);
    const ksRelay = ks.connect(relay);
    const before = await prov.getBalance(burner.address);
    const nonce = await prov.getTransactionCount(relay.address);
    const wtx = await ksRelay.proxy_withdraw(pA, pB, pC, publicSignals, burner.address, { gasLimit: 8_000_000n, nonce });
    await record(prov, { step: "B.ks-withdraw", party: "relay(venue-node)", action: "KS.proxy_withdraw→burner", via: "relay", hash: wtx.hash });
    const after = await prov.getBalance(burner.address);
    console.log(`   burner balance ${fmt(before)} → ${fmt(after)} PAS (unlinked to customer-main)`);
    st.run.ksWithdrawHash = wtx.hash;
    st.run.burnerFunded = after.toString();
    saveState(st);
  } else console.log("\n2. = KS withdraw already done");

  // ─── 3. Order lifecycle from the burner ────────────────────────────────────
  const orders = new ethers.Contract(bk.orders, [
    "function createOrder(uint64,bytes32,uint96,uint96,uint96,uint64,uint64) payable returns (uint256)",
    "function placeBid(uint256,uint96)",
    "function acceptBid(uint256,address) payable",
    "function nextOrderId() view returns (uint256)",
    "function statusOf(uint256) view returns (uint8)",
    "function dropCommitOf(uint256) view returns (bytes32)",
    "function treasury() view returns (address)",
    "function feeBps() view returns (uint16)",
  ], burner);

  if (!st.run.orderId) {
    const salt = rand();
    const dropCommit = positionCommit(DROP.lat, DROP.lon, salt);
    console.log(`\n3. createOrder from burner (dropCommit ${dropCommit.slice(0, 14)}…)`);
    const nextId = await orders.nextOrderId();
    const args = [st.venueId, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0];
    const gl = await leanGas(orders.createOrder, args, { value: ORDER_VALUE + TIP });
    const nonce = await prov.getTransactionCount(burner.address);
    const tx = await orders.createOrder(...args, { value: ORDER_VALUE + TIP, gasLimit: gl, nonce });
    await record(prov, { step: "B.create", party: "customer-burner", action: "createOrder", value: ORDER_VALUE + TIP, hash: tx.hash });
    st.run.orderId = nextId.toString();
    st.run.salt = salt.toString();
    st.run.dropCommit = dropCommit;
    saveState(st);
    console.log(`   orderId = ${st.run.orderId}`);
  } else console.log(`\n3. = order already created (#${st.run.orderId})`);
  const orderId = BigInt(st.run.orderId);

  // driver bids
  if (!st.run.bidHash) {
    console.log(`\n4. driver placeBid(${fmt(FARE)} PAS)`);
    const od = orders.connect(D);
    const gl = await leanGas(od.placeBid, [orderId, FARE]);
    const nonce = await prov.getTransactionCount(D.address);
    const tx = await od.placeBid(orderId, FARE, { gasLimit: gl, nonce });
    await record(prov, { step: "B.bid", party: "driver", action: "placeBid", hash: tx.hash });
    st.run.bidHash = tx.hash; saveState(st);
  } else console.log("\n4. = bid already placed");

  // burner accepts
  if (!st.run.acceptHash) {
    console.log(`\n5. burner acceptBid(driver, ${fmt(FARE)} PAS)`);
    const gl = await leanGas(orders.acceptBid, [orderId, D.address], { value: FARE });
    const nonce = await prov.getTransactionCount(burner.address);
    const tx = await orders.acceptBid(orderId, D.address, { value: FARE, gasLimit: gl, nonce });
    await record(prov, { step: "B.accept", party: "customer-burner", action: "acceptBid", value: FARE, hash: tx.hash });
    st.run.acceptHash = tx.hash; saveState(st);
  } else console.log("\n5. = bid already accepted");
  console.log(`   status after accept: ${await orders.statusOf(orderId)} (2 = Assigned)`);

  // ─── 6. confirmPickup (dual-sig GPS) via the relay (gasless) ────────────────
  if (!st.run.pickupHash) {
    console.log(`\n6. confirmPickup — driver + venue dual-sign, relay submits (gasless)`);
    const now = Number((await prov.getBlock("latest")).timestamp);
    const dCoarse = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
    console.log(`   driver actual (${DRIVER_PICKUP.lat},${DRIVER_PICKUP.lon}) → coarsened (${dCoarse.lat},${dCoarse.lon})`);
    const LOC = { LocationAttestation: [
      { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
      { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
    ]};
    const dAtt = { orderId, phase: 1, actor: D.address, lat: dCoarse.lat, lon: dCoarse.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const dSig = await D.signTypedData(domain, LOC, dAtt);
    const vSig = await V.signTypedData(domain, LOC, vAtt);
    const asArgs = (a) => ({ orderId: a.orderId.toString(), phase: a.phase, actor: a.actor, lat: a.lat, lon: a.lon, timestamp: a.timestamp });
    const hash = await relaySubmit("confirmPickup", [asArgs(dAtt), dSig, asArgs(vAtt), vSig]);
    await record(prov, { step: "B.pickup", party: "relay(venue-node)", action: "confirmPickup", via: "relay", hash });
    st.run.pickupHash = hash;
    st.run.driverPickupCoarse = dCoarse;
    saveState(st);
  } else console.log("\n6. = pickup already confirmed");
  console.log(`   status after pickup: ${await orders.statusOf(orderId)} (3 = PickedUp)`);

  // ─── 7. confirmDropoffZK (Groth16 proximity) via the relay (gasless) ────────
  if (!st.run.dropoffHash) {
    console.log(`\n7. confirmDropoffZK — Groth16 proximity proof, relay submits (gasless)`);
    const salt = BigInt(st.run.salt);
    const drvSalt = rand();
    const dropCommit = st.run.dropCommit;
    const driverCommit = positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt);
    const nul = b32(poseidon2([salt, orderId]));
    const radius = 100n;
    const input = {
      orderId: orderId.toString(), dropCommit: BigInt(dropCommit).toString(),
      driverCommit: BigInt(driverCommit).toString(), radiusMeters: radius.toString(),
      nullifier: BigInt(nul).toString(),
      custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: salt.toString(),
      drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, PWASM, PZKEY);
    const proofBytes = ethers.solidityPacked(
      ["uint256","uint256","uint256","uint256","uint256","uint256","uint256","uint256"],
      [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]
    );
    const pub = [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), radius.toString(), BigInt(nul).toString()];
    console.log(`   proof ok; publicSignals bound to order (dropCommit matches on-chain: ${(await orders.dropCommitOf(orderId)).toLowerCase() === dropCommit.toLowerCase()})`);

    const now = Number((await prov.getBlock("latest")).timestamp);
    const DC = { DriverCommitAttestation: [
      { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
      { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" },
    ]};
    const dAtt = { orderId, phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
    const dSig = await D.signTypedData(domain, DC, dAtt);
    const attArg = { orderId: orderId.toString(), phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
    const hash = await relaySubmit("confirmDropoffZK", [attArg, dSig, proofBytes, pub]);
    await record(prov, { step: "B.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", via: "relay", hash });
    st.run.dropoffHash = hash;
    st.run.driverDropoffCommit = driverCommit;
    st.run.nullifier = nul;
    saveState(st);
  } else console.log("\n7. = dropoff already confirmed");
  console.log(`   status after dropoff: ${await orders.statusOf(orderId)} (4 = Delivered)`);

  // ─── 8. Pull payouts from the vault ────────────────────────────────────────
  const vault = new ethers.Contract(bk.vault, [
    "function balanceOf(address) view returns (uint256)",
    "function withdraw()",
  ], prov);
  const treasury = await orders.treasury();
  const feeBps = await orders.feeBps();
  const bV = await vault.balanceOf(V.address), bD = await vault.balanceOf(D.address), bT = await vault.balanceOf(treasury);
  console.log(`\n8. Vault balances — venue ${fmt(bV)}  driver ${fmt(bD)}  treasury ${fmt(bT)} PAS (feeBps ${feeBps})`);
  st.run.payouts = { venue: bV.toString(), driver: bD.toString(), treasury: bT.toString(), treasuryAddr: treasury, feeBps: Number(feeBps) };

  if (!st.run.venueWithdrawHash && bV > 0n) {
    const vw = vault.connect(V);
    const gl = await leanGas(vw.withdraw, []);
    const nonce = await prov.getTransactionCount(V.address);
    const tx = await vw.withdraw({ gasLimit: gl, nonce });
    await record(prov, { step: "B.payout-venue", party: "venue", action: "vault.withdraw", hash: tx.hash });
    st.run.venueWithdrawHash = tx.hash; saveState(st);
  }
  if (!st.run.driverWithdrawHash && bD > 0n) {
    const dw = vault.connect(D);
    const gl = await leanGas(dw.withdraw, []);
    const nonce = await prov.getTransactionCount(D.address);
    const tx = await dw.withdraw({ gasLimit: gl, nonce });
    await record(prov, { step: "B.payout-driver", party: "driver", action: "vault.withdraw", hash: tx.hash });
    st.run.driverWithdrawHash = tx.hash; saveState(st);
  }

  // ─── 9. Shielded return: burner re-deposits residual into KS ────────────────
  if (!st.run.shieldReturnHash) {
    const bal = await prov.getBalance(burner.address);
    // round DOWN to 0.001 PAS so (value % 1e6 == 0) satisfies the Paseo eth-rpc
    // payable-value quirk. The upfront debit is value + gasLimit×gasPrice, so
    // reserve for the 0.8M-gas deposit (~0.8 PAS at 1000 gwei) + headroom.
    const DEP_GAS = 800_000n;
    const GAS_RESERVE = eth("1.0");
    const usable = bal - GAS_RESERVE;
    const dep = (usable / eth("0.001")) * eth("0.001");
    if (dep <= 0n) { console.log(`\n9. residual too small to return (${fmt(bal)} PAS)`); }
    else {
      console.log(`\n9. Shielded return: burner deposits residual ${fmt(dep)} PAS back into KS (of ${fmt(bal)})`);
      const ksB = new ethers.Contract(KS_POOL, KS_ABI, burner);
      const note = { nullifier: rand(), secret: rand(), value: dep };
      const commitment = poseidon2([poseidon2([note.value, 0n]), poseidon2([note.nullifier, note.secret])]);
      const nonce = await prov.getTransactionCount(burner.address);
      const tx = await ksB.depositNative(b32(commitment), { value: dep, gasLimit: DEP_GAS, nonce });
      await record(prov, { step: "B.ks-return", party: "customer-burner", action: "KS.depositNative(return)", value: dep, hash: tx.hash });
      st.run.shieldReturnNote = { nullifier: note.nullifier.toString(), secret: note.secret.toString(), value: note.value.toString() };
      st.run.shieldReturnHash = tx.hash; saveState(st);
    }
  } else console.log("\n9. = shielded return already done");

  saveState(st);
  console.log(`\n✅ run complete. orderId=${st.run.orderId}. Ledger: artifacts/e2e-live/ledger.json`);
}

main().catch((e) => {
  console.error("\nRUN FAILED:", e?.shortMessage ?? e?.message ?? e);
  console.error(e?.stack?.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
});
