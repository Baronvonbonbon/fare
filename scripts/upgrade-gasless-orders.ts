// upgrade-gasless-orders.ts — promote FareOrders to the gasless-ERC20 build
// (Option C: createOrderERC20[WithPermit]/acceptBidERC20/increaseTipERC20 read
// _msgSender() so they're meta-forwardable; permit removes the approve tx).
//
// ONLY FareOrders changed, so this is a narrow freeze-and-drain:
//   - deploy new FareOrders(pauseRegistry, forwarder)  [reuses the live forwarder]
//   - restore its state a fresh contract loses: configure (PRESERVE treasury),
//     setParams, setAcceptedToken(stablecoin), setRelayRebateBps (RAISE for the
//     gasless-order gas — reuse+raise F6)
//   - authorize new orders on vault/drivers/venues
//   - router.upgrade(orders, freeze=true)  [freeze old orders; in-flight drain]
//   - re-point the cachers of `orders`: settlement, ratings, disputes
//   - persist both address books
//
// Usage: npx hardhat run scripts/upgrade-gasless-orders.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// F6 rebate — RAISED so the dropoff rebate can cover the gasless-order gas the
// relay now fronts (reuse + raise). Still a share of the existing protocol fee
// (no new customer cost). Governance-tunable.
const RELAY_REBATE_BPS = Number(process.env.RELAY_REBATE_BPS ?? 5000); // 50% of the fee

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

  // Preserve the live orders params a fresh contract would otherwise reset.
  const oldOrders = await ethers.getContractAt("FareOrders", book.orders, deployer);
  const treasury = await oldOrders.treasury();
  const feeBps = Number(await oldOrders.feeBps());
  const assignedCancelBps = Number(await oldOrders.assignedCancelBps());
  const pw = await oldOrders.defaultPickupWindow();
  const dw = await oldOrders.defaultDeliveryWindow();
  console.log(`Preserve: treasury=${treasury} feeBps=${feeBps} cancelBps=${assignedCancelBps} windows=${pw}/${dw}\n`);

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

  // ── 1. Deploy new FareOrders (reuse live forwarder) ─────────────────────
  console.log("1. Deploy new FareOrders");
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, book.forwarder]);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);

  // ── 2. Restore state (fresh contract loses these) ───────────────────────
  console.log("\n2. Restore state on new orders");
  await send("setRouter", (n) => ordersC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("configure (preserve treasury)", (n) =>
    ordersC.configure(book.vault, book.drivers, book.venues, book.settlement, book.disputes, treasury, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("setParams (preserve fee/cancel/windows)", (n) =>
    ordersC.setParams(feeBps, assignedCancelBps, pw, dw, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("setAcceptedToken(stablecoin)", (n) => ordersC.setAcceptedToken(book.stablecoin, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send(`setRelayRebateBps(${RELAY_REBATE_BPS})`, (n) => ordersC.setRelayRebateBps(RELAY_REBATE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 3. Authorize new orders on vault + registries ───────────────────────
  console.log("\n3. Authorize new orders");
  const vault = await ethers.getContractAt("FareVault", book.vault, deployer);
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  await send("vault.setAuthorized(ordersNew)", (n) => vault.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("drivers.setAuthorized(ordersNew)", (n) => drivers.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(ordersNew)", (n) => venues.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 4. Router: promote (freeze old orders → in-flight drains, new entries stop)
  console.log("\n4. Router upgrade(orders, freeze=true)");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgradeContract(orders)", (n) => router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 5. Re-point everything that caches `orders` ─────────────────────────
  console.log("\n5. Re-point settlement / ratings / disputes → new orders");
  const settlement = await ethers.getContractAt("FareSettlement", book.settlement, deployer);
  const ratings = await ethers.getContractAt("FareRatings", book.ratings, deployer);
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("settlement.configure(ordersNew, venues)", (n) => settlement.configure(ordersNew, book.venues, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ratings.configure(ordersNew)", (n) => ratings.configure(ordersNew, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("disputes.configure(ordersNew, vault, drivers, treasury)", (n) => disputes.configure(ordersNew, book.vault, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 6. Validate ─────────────────────────────────────────────────────────
  console.log("\n6. Validation");
  const checks: Array<[string, boolean]> = [
    ["router→ordersNew", (await router.currentAddrOf(nameKey("orders"))) === ordersNew],
    ["ordersNew.vault", (await ordersC.vault()) === book.vault],
    ["ordersNew.settlement", (await ordersC.settlement()) === book.settlement],
    ["ordersNew.treasury preserved", (await ordersC.treasury()) === treasury],
    ["ordersNew acceptedToken(stablecoin)", await ordersC.acceptedToken(book.stablecoin)],
    ["ordersNew.relayRebateBps", Number(await ordersC.relayRebateBps()) === RELAY_REBATE_BPS],
    ["ordersNew.defaultPickupWindow", (await ordersC.defaultPickupWindow()) === pw],
    ["ordersNew has createOrderERC20WithPermit", typeof ordersC.createOrderERC20WithPermit === "function"],
    ["settlement.orders==ordersNew", (await settlement.orders()) === ordersNew],
    ["ratings.orders==ordersNew", (await ratings.orders()) === ordersNew],
    ["disputes.orders==ordersNew", (await disputes.orders()) === ordersNew],
    ["vault auth ordersNew", await vault.authorized(ordersNew)],
    ["drivers auth ordersNew", await drivers.authorized(ordersNew)],
    ["venues auth ordersNew", await venues.authorized(ordersNew)],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-upgrade validation failed");

  // ── 7. Persist address books ────────────────────────────────────────────
  console.log("\n7. Persist address books");
  const oldAddr = book.orders;
  book.orders = ordersNew;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify({ network: network.name, chainId: Number((await provider.getNetwork()).chainId), deployedAt: new Date().toISOString(), addresses: book }, null, 2) + "\n");
  console.log(`  books updated: orders ${oldAddr} → ${ordersNew}`);

  console.log(`\nDone. Gasless-ERC20 FareOrders live at ${ordersNew}. relayRebateBps=${RELAY_REBATE_BPS}. Old orders frozen (drain-only).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
