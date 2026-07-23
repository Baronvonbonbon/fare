// upgrade-c3.ts — promote the live deployment to C3 (stablecoin ERC-20 escrow)
// through the freeze-and-drain router.
//
// Contracts that changed and are redeployed here:
//   FareVault  — gained the per-token pull-payment ledger (creditToken /
//                withdrawToken / withdrawTokenTo / tokenBalanceOf); MIGRATED
//                freeze=false (it custodies balances → drain path, v1 stays live)
//   FareOrders — order `token` field + createOrderERC20 / acceptBidERC20 /
//                increaseTipERC20 + accepted-token allowlist + asset-agnostic
//                payout; UPGRADED (freeze old)
//   MockUSDC   — NEW testnet stablecoin (skip if STABLECOIN_ADDRESS is set to a
//                real bridged USDC/USDT); registered as an accepted escrow token
//
// Unchanged (kept, re-pointed at the new orders/vault): router, pauseRegistry,
// drivers, venues, locationVerifier, forwarder, settlement, ratings, disputes.
// Settlement/ratings/disputes only CACHE orders/vault, so their owner re-points
// them — no redeploy. (F6/F8 redeployed settlement because ITS interface changed;
// C3 leaves the settlement callback surface untouched.)
//
// New instances start at default params, so this re-applies the live F6/F8
// governance (relayRebateBps / withdrawFeeBps) that lives on orders/vault.
//
// Idempotency: one-shot migration — each run deploys fresh instances. Run once.
//
// Usage: npx hardhat run scripts/upgrade-c3.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// Preserve the live F6/F8 governance (new instances reset to defaults).
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
  console.log(`Old: orders=${book.orders} vault=${book.vault}\n`);

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

  // ── 1. Deploy new instances (+ the stablecoin) ──────────────────────────
  console.log("1. Deploy new instances");
  const vaultNew = await deployC("FareVault", []);
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, book.forwarder]);
  const stablecoin = process.env.STABLECOIN_ADDRESS ?? (await deployC("MockUSDC", []));
  if (process.env.STABLECOIN_ADDRESS) console.log(`  = using configured stablecoin ${stablecoin}`);

  const vaultC = await ethers.getContractAt("FareVault", vaultNew, deployer);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);

  // ── 2. setRouter on new instances ───────────────────────────────────────
  console.log("\n2. setRouter on new instances");
  await send("vaultNew.setRouter", (n) => vaultC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ordersNew.setRouter", (n) => ordersC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 3. Configure ordersNew (settlement/disputes are the EXISTING ones) ──
  console.log("\n3. Configure ordersNew");
  await send("ordersNew.configure", (n) =>
    ordersC.configure(vaultNew, book.drivers, book.venues, book.settlement, book.disputes, treasury, {
      nonce: n, gasLimit: GAS_LIMIT,
    })
  );

  // ── 4. Authorize + re-point the unchanged consumers at the new addresses ─
  console.log("\n4. Authorize + re-point unchanged consumers");
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  const settlement = await ethers.getContractAt("FareSettlement", book.settlement, deployer);
  const ratings = await ethers.getContractAt("FareRatings", book.ratings, deployer);
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);

  await send("vaultNew.setAuthorized(ordersNew)", (n) => vaultC.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setAuthorized(disputes)", (n) => vaultC.setAuthorized(book.disputes, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("drivers.setAuthorized(ordersNew)", (n) => drivers.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(ordersNew)", (n) => venues.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  // settlement/ratings only cache orders; disputes caches orders+vault.
  await send("settlement.configure(ordersNew, venues)", (n) => settlement.configure(ordersNew, book.venues, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ratings.configure(ordersNew)", (n) => ratings.configure(ordersNew, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("disputes.configure(ordersNew, vaultNew, drivers, treasury)", (n) =>
    disputes.configure(ordersNew, vaultNew, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 5. Router: promote (orders frozen; vault NOT — it's the drain path) ──
  console.log("\n5. Router upgrades");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgrade(orders, freeze=true)", (n) => router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("router.upgrade(vault, freeze=FALSE)", (n) => router.upgradeContract(nameKey("vault"), vaultNew, false, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 6. Re-apply governance + register the accepted stablecoin ────────────
  console.log("\n6. Governance: fees + accepted token");
  await send(`ordersNew.setRelayRebateBps(${RELAY_REBATE_BPS})`, (n) => ordersC.setRelayRebateBps(RELAY_REBATE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));
  await send(`vaultNew.setWithdrawFeeBps(${WITHDRAW_FEE_BPS})`, (n) => vaultC.setWithdrawFeeBps(WITHDRAW_FEE_BPS, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ordersNew.setAcceptedToken(stablecoin)", (n) => ordersC.setAcceptedToken(stablecoin, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 7. Validate ──────────────────────────────────────────────────────────
  console.log("\n7. Validation");
  const checks: Array<[string, boolean]> = [
    ["router→ordersNew", (await router.currentAddrOf(nameKey("orders"))) === ordersNew],
    ["router→vaultNew", (await router.currentAddrOf(nameKey("vault"))) === vaultNew],
    ["ordersNew.vault==vaultNew", (await ordersC.vault()) === vaultNew],
    ["ordersNew.settlement==settlement", (await ordersC.settlement()) === book.settlement],
    ["settlement.orders==ordersNew", (await settlement.orders()) === ordersNew],
    ["ratings.orders==ordersNew", (await ratings.orders()) === ordersNew],
    ["disputes.orders==ordersNew", (await disputes.orders()) === ordersNew],
    ["disputes.vault==vaultNew", (await disputes.vault()) === vaultNew],
    ["vaultNew auth ordersNew", await vaultC.authorized(ordersNew)],
    ["vaultNew auth disputes", await vaultC.authorized(book.disputes)],
    ["drivers auth ordersNew", await drivers.authorized(ordersNew)],
    ["venues auth ordersNew", await venues.authorized(ordersNew)],
    ["relayRebateBps set", Number(await ordersC.relayRebateBps()) === RELAY_REBATE_BPS],
    ["withdrawFeeBps set", Number(await vaultC.withdrawFeeBps()) === WITHDRAW_FEE_BPS],
    ["stablecoin accepted", await ordersC.acceptedToken(stablecoin)],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-migration validation failed");

  // ── 8. Persist address books (orders, vault, stablecoin) ─────────────────
  console.log("\n8. Persist address books");
  book.vault = vaultNew;
  book.orders = ordersNew;
  book.stablecoin = stablecoin;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`  books updated (${ADDR_FILE})`);

  // ── 9. Re-seed one demo order on the new orders (native, emits OrderRegion) ─
  console.log("\n9. Re-seed a demo order on new orders (venue #1)");
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

  console.log(`\nDone. C3 live.`);
  console.log(`  vault=${vaultNew} (old kept for drain)`);
  console.log(`  orders=${ordersNew}`);
  console.log(`  stablecoin=${stablecoin} (accepted escrow token)`);
  console.log(`\nNote: old-vault balances (if any) remain withdrawable on the old vault.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
