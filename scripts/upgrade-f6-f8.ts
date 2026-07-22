// upgrade-f6-f8.ts — promote the live deployment to F6 (relay gas-rebate) + F8
// (EIP-2771 forwarder, gasless withdraw) through the freeze-and-drain router.
//
// Contracts that changed and are redeployed here:
//   FareForwarder  — NEW (EIP-2771 trusted forwarder)
//   FareVault      — gained withdrawFor; MIGRATED freeze=false (drain path — it
//                    custodies balances, so v1 stays live for existing withdrawals)
//   FareOrders     — relayRebateBps (F6) + ERC2771 (F8); UPGRADED (freeze old)
//   FareSettlement — threads the relayer into onDropoffConfirmed (F6); UPGRADED
//                    in lockstep with orders (their interface changed together)
//   FareRatings    — ERC2771 (F8); redeployed + re-registered
//
// Unchanged (kept): router, pauseRegistry, drivers, venues, locationVerifier,
// disputes. `disputes` caches orders+vault, so it is re-pointed at the end.
//
// Idempotency: this is a one-shot migration (like upgrade-orders.ts) — each run
// deploys fresh instances. Run once against a given deployment.
//
// Usage: npx hardhat run scripts/upgrade-f6-f8.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// Governance params turned on by this migration (bps). The relay rebate is a
// share of the existing protocol fee (no new customer cost); the withdraw fee is
// a share of a gasless withdrawal, reimbursing the relay. Both governance-tunable.
const RELAY_REBATE_BPS = Number(process.env.RELAY_REBATE_BPS ?? 2000); // 20% of the fee
const WITHDRAW_FEE_BPS = Number(process.env.WITHDRAW_FEE_BPS ?? 100); // 1% of a withdrawal

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
  console.log(`Old: orders=${book.orders} settlement=${book.settlement} vault=${book.vault} ratings=${book.ratings}\n`);

  // One nonce-managed state-changing tx (Paseo needs explicit nonce + gas).
  async function send(label: string, fn: (nonce: number) => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn(nonce);
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  // Nonce-managed deploy → returns the created address.
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

  // ── 1. Deploy new instances (+ setRouter where applicable) ─────────────
  console.log("1. Deploy new instances");
  const forwarder = await deployC("FareForwarder", []);
  const vaultNew = await deployC("FareVault", []);
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, forwarder]);
  const settlementNew = await deployC("FareSettlement", [book.pauseRegistry]);
  const ratingsNew = await deployC("FareRatings", [forwarder]);

  const vaultC = await ethers.getContractAt("FareVault", vaultNew, deployer);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);
  const settlementC = await ethers.getContractAt("FareSettlement", settlementNew, deployer);
  const ratingsC = await ethers.getContractAt("FareRatings", ratingsNew, deployer);

  console.log("\n2. setRouter on new instances");
  await send("vaultNew.setRouter", (n) => vaultC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ordersNew.setRouter", (n) => ordersC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("settlementNew.setRouter", (n) => settlementC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ratingsNew.setRouter", (n) => ratingsC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 3. Configure new instances (cross-refs point at NEW addresses) ──────
  console.log("\n3. Configure new instances");
  await send("ordersNew.configure", (n) =>
    ordersC.configure(vaultNew, book.drivers, book.venues, settlementNew, book.disputes, treasury, {
      nonce: n, gasLimit: GAS_LIMIT,
    })
  );
  await send("settlementNew.setLocationVerifier", (n) =>
    settlementC.setLocationVerifier(book.locationVerifier, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("settlementNew.configure(ordersNew, venues)", (n) =>
    settlementC.configure(ordersNew, book.venues, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("ratingsNew.configure(ordersNew)", (n) =>
    ratingsC.configure(ordersNew, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 4. Authorize crediters/callers on the NEW vault + existing registries ─
  console.log("\n4. Authorize new orders + disputes on new vault; new orders on drivers/venues");
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  await send("vaultNew.setAuthorized(ordersNew)", (n) => vaultC.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setAuthorized(disputes)", (n) => vaultC.setAuthorized(book.disputes, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("drivers.setAuthorized(ordersNew)", (n) => drivers.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(ordersNew)", (n) => venues.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 5. Router: promote new instances ────────────────────────────────────
  //   orders/settlement/ratings frozen (logic contracts — stop the old ones);
  //   vault NOT frozen (it custodies balances → drain path, v1 stays live).
  console.log("\n5. Router upgrades");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgrade(orders, freeze=true)", (n) => router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("router.upgrade(settlement, freeze=true)", (n) => router.upgradeContract(nameKey("settlement"), settlementNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("router.upgrade(ratings, freeze=true)", (n) => router.upgradeContract(nameKey("ratings"), ratingsNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("router.upgrade(vault, freeze=FALSE)", (n) => router.upgradeContract(nameKey("vault"), vaultNew, false, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("router.register(forwarder)", (n) => router.register(nameKey("forwarder"), forwarder, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 6. Re-point the unchanged `disputes` (caches orders + vault) ─────────
  console.log("\n6. Re-point disputes → new orders + new vault");
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("disputes.configure(ordersNew, vaultNew, drivers, treasury)", (n) =>
    disputes.configure(ordersNew, vaultNew, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 7. Governance: turn on the F6/F8 fees ───────────────────────────────
  console.log("\n7. Enable fees");
  await send(`ordersNew.setRelayRebateBps(${RELAY_REBATE_BPS})`, (n) => ordersC.setRelayRebateBps(RELAY_REBATE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));
  await send(`vaultNew.setWithdrawFeeBps(${WITHDRAW_FEE_BPS})`, (n) => vaultC.setWithdrawFeeBps(WITHDRAW_FEE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 8. Validate ─────────────────────────────────────────────────────────
  console.log("\n8. Validation");
  const checks: Array<[string, boolean]> = [
    ["router→ordersNew", (await router.currentAddrOf(nameKey("orders"))) === ordersNew],
    ["router→settlementNew", (await router.currentAddrOf(nameKey("settlement"))) === settlementNew],
    ["router→vaultNew", (await router.currentAddrOf(nameKey("vault"))) === vaultNew],
    ["router→ratingsNew", (await router.currentAddrOf(nameKey("ratings"))) === ratingsNew],
    ["router→forwarder", (await router.currentAddrOf(nameKey("forwarder"))) === forwarder],
    ["ordersNew.vault==vaultNew", (await ordersC.vault()) === vaultNew],
    ["ordersNew.settlement==settlementNew", (await ordersC.settlement()) === settlementNew],
    ["settlementNew.orders==ordersNew", (await settlementC.orders()) === ordersNew],
    ["ratingsNew.orders==ordersNew", (await ratingsC.orders()) === ordersNew],
    ["disputes.orders==ordersNew", (await disputes.orders()) === ordersNew],
    ["disputes.vault==vaultNew", (await disputes.vault()) === vaultNew],
    ["vaultNew auth ordersNew", await vaultC.authorized(ordersNew)],
    ["vaultNew auth disputes", await vaultC.authorized(book.disputes)],
    ["drivers auth ordersNew", await drivers.authorized(ordersNew)],
    ["venues auth ordersNew", await venues.authorized(ordersNew)],
    ["relayRebateBps set", Number(await ordersC.relayRebateBps()) === RELAY_REBATE_BPS],
    ["withdrawFeeBps set", Number(await vaultC.withdrawFeeBps()) === WITHDRAW_FEE_BPS],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-migration validation failed");

  // ── 9. Persist address books ────────────────────────────────────────────
  console.log("\n9. Persist address books");
  book.forwarder = forwarder;
  book.vault = vaultNew;
  book.orders = ordersNew;
  book.settlement = settlementNew;
  book.ratings = ratingsNew;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`  books updated (${ADDR_FILE})`);

  // ── 10. Re-seed one demo order on the new orders (emits OrderRegion) ─────
  console.log("\n10. Re-seed a demo order on new orders (venue #1)");
  if (await venues.isActive(1n)) {
    const DROP_LAT = 37_784_900, DROP_LON = -122_419_400, SALT = 12345678901234567890n;
    const commit = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT])
    );
    await send("ordersNew.createOrder(venue 1, maxFare 0.5)", (n) =>
      ordersC.createOrder(1n, commit, 0, 0, ethers.parseEther("0.5"), 0, 0, { value: 0, nonce: n, gasLimit: GAS_LIMIT })
    );
    console.log(`  seeded order #${(await ordersC.nextOrderId()) - 1n}`);
  } else {
    console.log("  (venue #1 inactive — skipping reseed)");
  }

  console.log(`\nDone. F6+F8 live.`);
  console.log(`  forwarder=${forwarder}`);
  console.log(`  vault=${vaultNew} (old ${book.vault === vaultNew ? "" : "kept for drain"})`);
  console.log(`  orders=${ordersNew}  settlement=${settlementNew}  ratings=${ratingsNew}`);
  console.log(`  relayRebateBps=${RELAY_REBATE_BPS}  withdrawFeeBps=${WITHDRAW_FEE_BPS}`);
  console.log(`\nNote: old-vault balances (if any) remain withdrawable on the old vault.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
