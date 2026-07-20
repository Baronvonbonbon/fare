// upgrade-orders.ts — promote FareOrders to the OrderRegion build through the
// freeze-and-drain router, re-wire dependents, and re-seed one demo order.
//
// Canonical orders-upgrade sequence (see test/upgradability.test.ts):
//   1. deploy v2, setRouter
//   2. router.upgradeContract("orders", v2, freezeOld=true)  (freezes v1, re-points)
//   3. v2.configure(...) + authorize v2 on vault/drivers/venues
//   4. re-point settlement.configure / disputes.configure (they cache orders)
//   5. update address books, re-seed an order (emits OrderRegion)
//
// migrate() is a no-op for orders — v2 starts fresh; the old open order drains
// on the frozen v1. Venues/drivers/vault/etc. are untouched.
//
// Usage: npx hardhat run scripts/upgrade-orders.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

async function waitForNonce(provider: any, addr: string, target: number, maxWait = 180) {
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
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;
  const book = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Old orders: ${book.orders}\n`);

  async function send(label: string, fn: (nonce: number) => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn(nonce);
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  // ── 1. deploy v2 + setRouter ──────────────────────────────────────────
  console.log("1. Deploy FareOrders v2");
  const factory = await ethers.getContractFactory("FareOrders", deployer);
  const nonce = await provider.getTransactionCount(deployer.address);
  const unsigned = await factory.getDeployTransaction(book.pauseRegistry);
  await deployer.sendTransaction({ ...unsigned, nonce, gasLimit: GAS_LIMIT });
  await waitForNonce(provider, deployer.address, nonce);
  const ordersV2Addr = ethers.getCreateAddress({ from: deployer.address, nonce });
  console.log(`  + FareOrders v2 at ${ordersV2Addr}`);
  const ordersV2 = await ethers.getContractAt("FareOrders", ordersV2Addr, deployer);
  await send("v2.setRouter", (n) => ordersV2.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 2. router promotes v2 (freezes v1) ────────────────────────────────
  console.log("\n2. Router upgrade (freeze v1)");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgradeContract(orders, v2, freeze=true)", (n) =>
    router.upgradeContract(nameKey("orders"), ordersV2Addr, true, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 3. configure v2 + authorize ───────────────────────────────────────
  console.log("\n3. Configure + authorize v2");
  await send("v2.configure", (n) =>
    ordersV2.configure(book.vault, book.drivers, book.venues, book.settlement, book.disputes, treasury, {
      nonce: n,
      gasLimit: GAS_LIMIT,
    })
  );
  const vault = await ethers.getContractAt("FareVault", book.vault, deployer);
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  await send("vault.setAuthorized(v2)", (n) => vault.setAuthorized(ordersV2Addr, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("drivers.setAuthorized(v2)", (n) => drivers.setAuthorized(ordersV2Addr, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(v2)", (n) => venues.setAuthorized(ordersV2Addr, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 4. re-point dependents that cache the orders address ──────────────
  console.log("\n4. Re-point settlement + disputes to v2");
  const settlement = await ethers.getContractAt("FareSettlement", book.settlement, deployer);
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("settlement.configure(v2, venues)", (n) =>
    settlement.configure(ordersV2Addr, book.venues, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("disputes.configure(v2, vault, drivers, treasury)", (n) =>
    disputes.configure(ordersV2Addr, book.vault, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 5. validate + persist address books ───────────────────────────────
  console.log("\n5. Validation");
  const live = await router.currentAddrOf(nameKey("orders"));
  const ok =
    live === ordersV2Addr &&
    (await ordersV2.settlement()) === book.settlement &&
    (await settlement.orders()) === ordersV2Addr &&
    (await disputes.orders()) === ordersV2Addr &&
    (await vault.authorized(ordersV2Addr)) &&
    (await venues.authorized(ordersV2Addr));
  console.log(`  router→v2: ${live === ordersV2Addr}`);
  console.log(`  settlement/disputes re-pointed + auths: ${ok}`);
  if (!ok) throw new Error("post-upgrade validation failed");

  book.orders = ordersV2Addr;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`  address books updated → orders = ${ordersV2Addr}`);

  // ── 6. re-seed one demo order on v2 (emits OrderRegion) ────────────────
  console.log("\n6. Re-seed demo order on v2 (venue #1)");
  if (!(await venues.isActive(1n))) throw new Error("venue #1 not active on the venues contract");
  const DROP_LAT = 37_784_900, DROP_LON = -122_419_400, SALT = 12345678901234567890n;
  const commit = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT])
  );
  await send("v2.createOrder(venue 1, maxFare 0.5)", (n) =>
    ordersV2.createOrder(1n, commit, 0, 0, ethers.parseEther("0.5"), 0, 0, { value: 0, nonce: n, gasLimit: GAS_LIMIT })
  );
  const nextId = await ordersV2.nextOrderId();
  const [vlat, vlon] = await venues.locationOf(1n);
  const region = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["int256", "int256"],
      [Math.trunc(Number(vlat) / 500_000), Math.trunc(Number(vlon) / 500_000)]
    )
  );
  console.log(`  seeded order #${nextId - 1n} on v2 · expected region ${region}`);
  console.log(`\nDone. FareOrders v2 live at ${ordersV2Addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
