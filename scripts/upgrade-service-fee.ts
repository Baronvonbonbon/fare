// upgrade-service-fee.ts — promote FareOrders to the flat-relay-service-fee build
// (F6-flat: relayServiceFee[token], escrowed on top of orderValue+tip and paid in
// full to the settling relay; the guard/economics that a percentage rebate can't
// cover a fixed gas cost — see docs/E2E-FRESH-SHIELDED-ECONOMICS.md).
//
// Narrow freeze-and-drain (ONLY FareOrders changed), mirrors upgrade-gasless-orders.ts:
//   - deploy new FareOrders(pauseRegistry, forwarder)
//   - restore state: configure (PRESERVE treasury), setParams, accept the
//     stablecoin(s), relayRebateBps=0 (the flat fee is the all-in comp),
//     setRelayServiceFee(USDC, 4.25) — the new bit
//   - authorize new orders on vault/drivers/venues; router.upgradeContract(freeze old)
//   - re-point settlement/ratings/disputes; persist both books
//
// Usage: npx hardhat run scripts/upgrade-service-fee.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// Real Asset Hub USDC (asset 1337) precompile + the flat service fee (6-dp).
const USDC_1337 = "0x0000053900000000000000000000000001200000";
const SERVICE_FEE = BigInt(process.env.SERVICE_FEE_UNITS ?? 4_250_000); // 4.25 USDC
// All-in flat fee → the rebate is 0 (the flat fee is the relay's whole comp;
// treasury keeps the full protocol fee). Override via env if you want both.
const RELAY_REBATE_BPS = Number(process.env.RELAY_REBATE_BPS ?? 0);

async function waitForNonce(provider: any, addr: string, target: number, maxWait = 200) {
  for (let i = 0; i < maxWait; i++) {
    if ((await provider.getTransactionCount(addr)) > target) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const book = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  console.log(`Network:  ${network.name}\nDeployer: ${deployer.address}\nOld orders: ${book.orders}\n`);

  const oldOrders = await ethers.getContractAt("FareOrders", book.orders, deployer);
  const treasury = await oldOrders.treasury();
  const feeBps = Number(await oldOrders.feeBps());
  const assignedCancelBps = Number(await oldOrders.assignedCancelBps());
  const pw = await oldOrders.defaultPickupWindow();
  const dw = await oldOrders.defaultDeliveryWindow();
  // Preserve whatever tokens the live contract already accepted (MockUSDC etc.).
  const acceptMock = await oldOrders.acceptedToken(book.stablecoin).catch(() => false);
  console.log(`Preserve: treasury=${treasury} feeBps=${feeBps} cancelBps=${assignedCancelBps} windows=${pw}/${dw} acceptMock=${acceptMock}\n`);

  async function send(label: string, fn: (nonce: number) => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn(nonce);
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }
  async function deployC(cname: string, args: any[]): Promise<string> {
    const factory = await ethers.getContractFactory(cname, deployer);
    const nonce = await provider.getTransactionCount(deployer.address);
    const unsigned = await factory.getDeployTransaction(...args);
    await deployer.sendTransaction({ ...unsigned, nonce, gasLimit: GAS_LIMIT });
    await waitForNonce(provider, deployer.address, nonce);
    const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
    console.log(`  + ${cname} at ${addr}`);
    return addr;
  }

  console.log("1. Deploy new FareOrders (service-fee build)");
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, book.forwarder]);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);

  console.log("\n2. Restore state + set the flat service fee");
  await send("setRouter", (n) => ordersC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("configure (preserve treasury)", (n) =>
    ordersC.configure(book.vault, book.drivers, book.venues, book.settlement, book.disputes, treasury, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("setParams (preserve fee/cancel/windows)", (n) =>
    ordersC.setParams(feeBps, assignedCancelBps, pw, dw, { nonce: n, gasLimit: GAS_LIMIT }));
  if (acceptMock) await send("setAcceptedToken(stablecoin)", (n) => ordersC.setAcceptedToken(book.stablecoin, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("setAcceptedToken(USDC 1337)", (n) => ordersC.setAcceptedToken(USDC_1337, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send(`setRelayRebateBps(${RELAY_REBATE_BPS})`, (n) => ordersC.setRelayRebateBps(RELAY_REBATE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));
  await send(`setRelayServiceFee(USDC 1337, ${SERVICE_FEE})`, (n) => ordersC.setRelayServiceFee(USDC_1337, SERVICE_FEE, { nonce: n, gasLimit: GAS_LIMIT }));
  if (acceptMock) await send(`setRelayServiceFee(stablecoin, ${SERVICE_FEE})`, (n) => ordersC.setRelayServiceFee(book.stablecoin, SERVICE_FEE, { nonce: n, gasLimit: GAS_LIMIT }));

  console.log("\n3. Authorize new orders");
  const vault = await ethers.getContractAt("FareVault", book.vault, deployer);
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  await send("vault.setAuthorized(ordersNew)", (n) => vault.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("drivers.setAuthorized(ordersNew)", (n) => drivers.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(ordersNew)", (n) => venues.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  console.log("\n4. Router upgrade(orders, freeze=true)");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgradeContract(orders)", (n) => router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  console.log("\n5. Re-point settlement / ratings / disputes → new orders");
  const settlement = await ethers.getContractAt("FareSettlement", book.settlement, deployer);
  const ratings = await ethers.getContractAt("FareRatings", book.ratings, deployer);
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("settlement.configure(ordersNew, venues)", (n) => settlement.configure(ordersNew, book.venues, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ratings.configure(ordersNew)", (n) => ratings.configure(ordersNew, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("disputes.configure(ordersNew, vault, drivers, treasury)", (n) => disputes.configure(ordersNew, book.vault, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT }));

  console.log("\n6. Validation");
  const checks: Array<[string, boolean]> = [
    ["router→ordersNew", (await router.currentAddrOf(nameKey("orders"))) === ordersNew],
    ["ordersNew.treasury preserved", (await ordersC.treasury()) === treasury],
    ["ordersNew acceptedToken(USDC 1337)", await ordersC.acceptedToken(USDC_1337)],
    ["ordersNew.relayServiceFee(1337)==4.25", (await ordersC.relayServiceFee(USDC_1337)) === SERVICE_FEE],
    ["ordersNew.relayRebateBps", Number(await ordersC.relayRebateBps()) === RELAY_REBATE_BPS],
    ["settlement.orders==ordersNew", (await settlement.orders()) === ordersNew],
    ["disputes.orders==ordersNew", (await disputes.orders()) === ordersNew],
    ["vault auth ordersNew", await vault.authorized(ordersNew)],
    ["drivers auth ordersNew", await drivers.authorized(ordersNew)],
    ["venues auth ordersNew", await venues.authorized(ordersNew)],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-upgrade validation failed");

  console.log("\n7. Persist address books");
  const oldAddr = book.orders;
  book.orders = ordersNew;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify({ network: network.name, chainId: Number((await provider.getNetwork()).chainId), deployedAt: new Date().toISOString(), addresses: book }, null, 2) + "\n");
  console.log(`  books updated: orders ${oldAddr} → ${ordersNew}`);

  console.log(`\nDone. Service-fee FareOrders live at ${ordersNew}. relayServiceFee(USDC)=${SERVICE_FEE} (4.25). Old orders frozen (drain-only).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
