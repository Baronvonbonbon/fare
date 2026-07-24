// Live GASLESS stablecoin order e2e on Paseo (Option C, against the upgraded
// FareOrders). A customer wallet with ZERO native PAS places and funds a USDC
// order entirely by SIGNATURES:
//   permit (EIP-2612) + ForwardRequest(createOrderERC20WithPermit) → relay executes
//   → driver bids → ForwardRequest(acceptBidERC20) → relay executes
//   → confirmPickup → confirmDropoffZK → withdrawToken payouts.
// The relay (venue-node wallet) pays ALL gas; the customer's PAS balance stays 0.
import { ethers } from "ethers";
import { poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { ROOT, provider, book, env, loadState, waitTx, leanGas, GAS_PRICE_WEI, fmt } from "./shield/e2e-lib.mjs";

const OFF_LAT = 90_000_000n, OFF_LON = 180_000_000n;
const encLat = (m) => BigInt(m) + OFF_LAT, encLon = (m) => BigInt(m) + OFF_LON;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const usdc = (n) => BigInt(Math.round(n * 1e6));
const fmt6 = (x) => (Number(x) / 1e6).toString();
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ORDER_VALUE = usdc(3), TIP = usdc(0.5), MAX_FARE = usdc(2), FARE = usdc(1.5);
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_051, lon: -122_419_377 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 };
const snap = (v) => Math.round(v / 300) * 300;
const positionCommit = (lat, lon, salt) => b32(poseidon3([encLat(lat), encLon(lon), BigInt(salt)]));

const OUT = path.join(ROOT, "e2e-runs", "e2e-gasless");
const LEDGER = path.join(OUT, "ledger.json");
function append(e) { fs.mkdirSync(OUT, { recursive: true }); const l = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : []; l.push(e); fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2)); }
async function rec(prov, { step, party, action, hash, tokenValue }) {
  const rc = await waitTx(prov, hash, action);
  const fee = (rc.gasUsed ?? 0n) * GAS_PRICE_WEI;
  append({ step, party, action, from: rc.from, to: rc.to, usdc: tokenValue != null ? fmt6(tokenValue) : "", hash, block: rc.blockNumber, status: rc.status, gasUsed: (rc.gasUsed ?? 0n).toString(), feePAS: ethers.formatEther(fee) });
  console.log(`   ✓ ${action} [${party}] status ${rc.status} gas ${rc.gasUsed} fee ${ethers.formatEther(fee)} PAS${tokenValue != null ? ` value ${fmt6(tokenValue)} USDC` : ""}`);
  return rc;
}

async function main() {
  const prov = provider();
  const b = book();
  const e2e = loadState();
  const chainId = e2e.chainId;
  const deployer = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), prov); // USDC faucet
  const R = new ethers.Wallet(e2e.wallets.relay.privateKey, prov);       // relay: executes forwards + settlement
  const V = new ethers.Wallet(e2e.wallets.venue.privateKey, prov);
  const D = new ethers.Wallet(e2e.wallets.driver.privateKey, prov);
  const customer = ethers.Wallet.createRandom().connect(prov);           // ZERO native PAS, ever
  console.log(`gasless e2e — orders ${b.orders}\ncustomer ${customer.address} (0 PAS)  relay ${R.address}  venueId ${e2e.venueId}`);

  // The live stablecoin (book.stablecoin) predates ERC20Permit, so gasless orders
  // need a permit-capable token. Deploy a fresh permit MockUSDC (persist across
  // runs) + accept it on the upgraded orders. (Real Asset Hub USDC supports EIP-2612.)
  const SC = process.env.E2E_SCRATCH || "/tmp/claude-1000/-home-k-Documents-fare/b72267a7-e6ed-4ea1-a42c-ce13603eacaa/scratchpad";
  const tf = path.join(SC, "gasless-token.json");
  const deployerOrders = new ethers.Contract(b.orders, ["function setAcceptedToken(address,bool)", "function acceptedToken(address) view returns(bool)"], deployer);
  let TOKEN;
  if (fs.existsSync(tf)) { TOKEN = JSON.parse(fs.readFileSync(tf, "utf8")).token; console.log(`permit token (reused): ${TOKEN}`); }
  else {
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/mocks/MockUSDC.sol/MockUSDC.json"), "utf8"));
    const f = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
    const dep = await f.deploy({ gasLimit: 500_000_000n, nonce: await prov.getTransactionCount(deployer.address) });
    await dep.waitForDeployment();
    TOKEN = await dep.getAddress();
    fs.writeFileSync(tf, JSON.stringify({ token: TOKEN }));
    console.log(`permit token (deployed): ${TOKEN}`);
  }
  if (!(await deployerOrders.acceptedToken(TOKEN))) {
    const at = await deployerOrders.setAcceptedToken(TOKEN, true, { gasLimit: 500_000_000n, nonce: await prov.getTransactionCount(deployer.address) });
    await at.wait();
    console.log(`   accepted permit token on orders`);
  }

  const USDC = new ethers.Contract(TOKEN, [
    "function mint(address,uint256)", "function balanceOf(address) view returns(uint256)",
    "function name() view returns(string)", "function nonces(address) view returns(uint256)",
  ], deployer);
  const ordersIface = new ethers.Interface([
    "function createOrderERC20WithPermit(address token, uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pw, uint64 dw, uint256 permitValue, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)",
    "function acceptBidERC20(uint256 orderId, address driver)",
  ]);
  const ordersRead = new ethers.Contract(b.orders, ["function nextOrderId() view returns(uint256)", "function statusOf(uint256) view returns(uint8)", "function treasury() view returns(address)", "function orders(uint256) view returns (address customer, uint64 venueId, uint8 status, address driver, uint96 orderValue, uint96 tip, uint96 fare, uint96 maxFare, uint96 escrow, bytes32 dropCommit, uint64 createdAt, uint64 pickupWindowSecs, uint64 deliveryWindowSecs, uint64 pickupDeadline, uint64 deliveryDeadline)"], prov);
  const orders = new ethers.Contract(b.orders, ["function placeBid(uint256,uint96)"], D);
  const vault = new ethers.Contract(b.vault, ["function tokenBalanceOf(address,address) view returns(uint256)", "function withdrawToken(address)"], prov);
  const FWD = new ethers.Contract(b.forwarder, [
    "function nonces(address) view returns(uint256)",
    "function execute((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) payable",
  ], R);

  const assertZeroGas = async (where) => {
    const bal = await prov.getBalance(customer.address);
    if (bal !== 0n) throw new Error(`customer holds ${fmt(bal)} PAS at ${where} — not gasless!`);
    console.log(`   · customer native balance: 0 PAS (${where}) ✓`);
  };

  // EIP-2612 permit signature (customer → orders, MaxUint256).
  async function signPermit() {
    const [name, nonce] = await Promise.all([USDC.name(), USDC.nonces(customer.address)]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await customer.signTypedData(
      { name, version: "1", chainId, verifyingContract: TOKEN },
      { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { owner: customer.address, spender: b.orders, value: ethers.MaxUint256, nonce, deadline });
    const { v, r, s } = ethers.Signature.from(sig);
    return { v, r, s, deadline };
  }
  // Sign a FareForwarder ForwardRequest wrapping `data` → orders.
  async function signForward(data) {
    const nonce = await FWD.nonces(customer.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const gas = 2_000_000n;
    const msg = { from: customer.address, to: b.orders, value: 0n, gas, nonce, deadline, data };
    const signature = await customer.signTypedData(
      { name: "FareForwarder", version: "1", chainId, verifyingContract: b.forwarder },
      { ForwardRequest: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "gas", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "data", type: "bytes" }] }, msg);
    return { from: customer.address, to: b.orders, value: 0n, gas, deadline, data, signature };
  }

  // ── 1. Mint USDC to the customer (escrow value; customer stays 0 PAS) ───────
  console.log(`\n1. mint 100 USDC → customer (deployer pays gas; customer stays 0 PAS)`);
  const mt = await USDC.mint(customer.address, usdc(100), { gasLimit: 5_000_000n, nonce: await prov.getTransactionCount(deployer.address) });
  await rec(prov, { step: "G.mint", party: "faucet", action: "mint-USDC→customer", hash: mt.hash, tokenValue: usdc(100) });
  await assertZeroGas("after mint");

  // ── 2. GASLESS createOrderERC20WithPermit (permit + forward, relay executes) ─
  console.log(`\n2. GASLESS createOrderERC20WithPermit — customer signs, relay executes`);
  const salt = rand();
  const dropCommit = positionCommit(DROP.lat, DROP.lon, salt);
  const p = await signPermit();
  const createData = ordersIface.encodeFunctionData("createOrderERC20WithPermit", [TOKEN, e2e.venueId, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, ethers.MaxUint256, p.deadline, p.v, p.r, p.s]);
  const nextId = await ordersRead.nextOrderId();
  const req1 = await signForward(createData);
  const tx1 = await FWD.execute(req1, { gasLimit: 500_000_000n, nonce: await prov.getTransactionCount(R.address) });
  await rec(prov, { step: "G.create", party: "relay(venue-node)", action: "forward:createOrderERC20WithPermit", hash: tx1.hash, tokenValue: ORDER_VALUE + TIP });
  const orderId = nextId;
  const o = await ordersRead.orders(orderId);
  console.log(`   orderId ${orderId}  o.customer=${o.customer} (== customer: ${o.customer.toLowerCase() === customer.address.toLowerCase()})  escrow ${fmt6(o.escrow)} USDC`);
  await assertZeroGas("after gasless create");

  // ── 3. driver placeBid ──────────────────────────────────────────────────────
  console.log(`\n3. driver placeBid ${fmt6(FARE)} USDC`);
  const bt = await orders.placeBid(orderId, FARE, { gasLimit: await leanGas(orders.placeBid, [orderId, FARE]) });
  await rec(prov, { step: "G.bid", party: "driver", action: "placeBid", hash: bt.hash });

  // ── 4. GASLESS acceptBidERC20 (forward, relay executes) ─────────────────────
  console.log(`\n4. GASLESS acceptBidERC20 — customer signs, relay executes`);
  const acceptData = ordersIface.encodeFunctionData("acceptBidERC20", [orderId, D.address]);
  const req2 = await signForward(acceptData);
  const tx2 = await FWD.execute(req2, { gasLimit: 500_000_000n, nonce: await prov.getTransactionCount(R.address) });
  await rec(prov, { step: "G.accept", party: "relay(venue-node)", action: "forward:acceptBidERC20", hash: tx2.hash, tokenValue: FARE });
  console.log(`   status ${await ordersRead.statusOf(orderId)} (2=Assigned)`);
  await assertZeroGas("after gasless accept");

  // ── 5. Settlement (relay submits) ───────────────────────────────────────────
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: b.settlement };
  const settle = new ethers.Contract(b.settlement, [
    "function confirmPickup((uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes,(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes)",
    "function confirmDropoffZK((uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp),bytes,bytes,uint256[5])",
  ], R);
  console.log(`\n5. confirmPickup (relay)`);
  let now = Number((await prov.getBlock("latest")).timestamp);
  const dC = { lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon) };
  const LOC = { LocationAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
  const dAtt1 = { orderId, phase: 1, actor: D.address, lat: dC.lat, lon: dC.lon, timestamp: now };
  const vAtt = { orderId, phase: 1, actor: V.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
  const pk = await settle.confirmPickup(dAtt1, await D.signTypedData(domain, LOC, dAtt1), vAtt, await V.signTypedData(domain, LOC, vAtt), { gasLimit: 500_000_000n });
  await rec(prov, { step: "G.pickup", party: "relay(venue-node)", action: "confirmPickup", hash: pk.hash });

  console.log(`\n6. confirmDropoffZK (Groth16, relay)`);
  const drvSalt = rand();
  const driverCommit = positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt);
  const nul = b32(poseidon2([salt, orderId]));
  const input = { orderId: orderId.toString(), dropCommit: BigInt(dropCommit).toString(), driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100", nullifier: BigInt(nul).toString(), custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: salt.toString(), drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString() };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
  const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]]);
  const pub = [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nul).toString()];
  now = Number((await prov.getBlock("latest")).timestamp);
  const DC = { DriverCommitAttestation: [{ name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };
  const dAtt2 = { orderId, phase: 2, actor: D.address, posCommit: driverCommit, timestamp: now };
  const dr = await settle.confirmDropoffZK(dAtt2, await D.signTypedData(domain, DC, dAtt2), proofBytes, pub, { gasLimit: 500_000_000n });
  await rec(prov, { step: "G.dropoff", party: "relay(venue-node)", action: "confirmDropoffZK", hash: dr.hash });
  console.log(`   status ${await ordersRead.statusOf(orderId)} (4=Delivered)`);
  await assertZeroGas("after delivery");

  // ── 7. Payouts ──────────────────────────────────────────────────────────────
  const treasury = await ordersRead.treasury();
  const [bV, bD, bT, bR] = await Promise.all([vault.tokenBalanceOf(TOKEN, V.address), vault.tokenBalanceOf(TOKEN, D.address), vault.tokenBalanceOf(TOKEN, treasury), vault.tokenBalanceOf(TOKEN, R.address)]);
  console.log(`\n7. Vault USDC (this order) — venue ${fmt6(bV)}  driver ${fmt6(bD)}  treasury(cum) ${fmt6(bT)}  relay(cum) ${fmt6(bR)}`);
  if (bV > 0n) { const tx = await vault.connect(V).withdrawToken(TOKEN, { gasLimit: await leanGas(vault.connect(V).withdrawToken, [TOKEN]) }); await rec(prov, { step: "G.pay-venue", party: "venue", action: "withdrawToken", hash: tx.hash, tokenValue: bV }); }
  if (bD > 0n) { const tx = await vault.connect(D).withdrawToken(TOKEN, { gasLimit: await leanGas(vault.connect(D).withdrawToken, [TOKEN]) }); await rec(prov, { step: "G.pay-driver", party: "driver", action: "withdrawToken", hash: tx.hash, tokenValue: bD }); }

  await assertZeroGas("end");
  console.log(`\n✅ GASLESS ORDER e2e complete on the upgraded FareOrders. customer paid 0 PAS gas end-to-end; relay executed the forwarded permit-order. orderId=${orderId}. Ledger: e2e-runs/e2e-gasless/ledger.json`);
}
main().catch((e) => { console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e); console.error(e?.stack?.split("\n").slice(0, 3).join("\n")); process.exit(1); });
