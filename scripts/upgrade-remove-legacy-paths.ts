// upgrade-remove-legacy-paths.ts — take the two legacy paths off the live
// deployment through the freeze-and-drain router.
//
// What is being removed, and why (docs/PRIVACY-TIERS.md §4 and §6):
//
//   FareOrders — the OPEN-BID path. placeBid / withdrawBid / acceptBid /
//     acceptBidERC20, the public bid mapping and the BidPlaced/BidWithdrawn
//     events published every driver's price and availability forever, losers
//     included. Sealed bids replaced it, but stayed *additive*: the old path was
//     one transaction away, so the guarantee was a default a driver could opt
//     out of. UPGRADED, freeze old.
//
//   FareVault — the KEEPER/ticket shielding path. queueShieldCredit,
//     sealShieldBatch, depositShieldBatch, reclaimShieldTicket, setShieldKeeper
//     and the ticket state. Its anonymity set was only the seal size, and the
//     keeper held the account↔commitment pairing, so it could substitute its own
//     commitments. Dormant only because nobody was authorized — one owner call
//     from live. MIGRATED freeze=false: the vault custodies balances, so v1
//     stays live for existing withdrawals (the drain path).
//
// `acceptSealedBidERC20` now reads `_msgSender()`, so the gasless token accept
// that only `acceptBidERC20` used to offer survives on the sealed path.
//
// Unchanged and RE-POINTED rather than redeployed (they only cache addresses):
// settlement, ratings, disputes. Unchanged and kept: router, pauseRegistry,
// drivers, venues, locationVerifier, forwarder, stablecoin, shieldVerifier.
//
// Every live governance setting is READ FROM CHAIN and re-applied. A migration
// that silently reset the fee schedule would be worse than no migration.
//
// IN-FLIGHT ORDERS: an order that is Open on v1 with only OPEN bids cannot be
// accepted on v2 — that path no longer exists. Such an order is cancellable on
// the frozen v1 (exits stay open on a frozen contract), refunding the customer.
// Assigned/PickedUp orders settle normally on v1. This is checked and reported
// before anything is deployed.
//
// Usage: npx hardhat run scripts/upgrade-remove-legacy-paths.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// Both are external, already-deployed contracts. Read them from the address book
// first: on a local chain they are mocks, and hardcoding Paseo's addresses makes
// the migration revert against an account with no code. Env overrides the book.
const PASEO_SHIELD_POOL = "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const PASEO_POSEIDON = "0x1d165f6fE5A30422E0E2140e91C8A9B800380637";
// Fixed denominations. Without them the amounts re-identify entries and the
// pool's crowd is decorative — this survives the keeper path's removal because
// it was never the keeper's idea (PRIVACY-TIERS §4).
const BUCKETS = (process.env.SHIELD_BUCKETS ?? "1,5,25").split(",").map((b) => ethers.parseEther(b.trim()));

async function waitForNonce(provider: any, addr: string, target: number, maxWait = 180) {
  for (let i = 0; i < maxWait; i++) {
    if ((await provider.getTransactionCount(addr)) > target) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`nonce did not advance past ${target}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;
  const book = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  const SHIELD_POOL = process.env.SHIELD_POOL ?? book.shieldPool ?? PASEO_SHIELD_POOL;
  const POSEIDON = process.env.POSEIDON ?? book.poseidon ?? PASEO_POSEIDON;
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

  // ── 0. Read the LIVE settings, so none of them are silently reset ────────
  console.log("0. Reading live governance settings");
  const ordersOld = await ethers.getContractAt("FareOrders", book.orders, deployer);
  const vaultOld = await ethers.getContractAt("FareVault", book.vault, deployer);
  const live = {
    feeBps: Number(await ordersOld.feeBps()),
    assignedCancelBps: Number(await ordersOld.assignedCancelBps()),
    pickupWindow: await ordersOld.defaultPickupWindow(),
    deliveryWindow: await ordersOld.defaultDeliveryWindow(),
    relayRebateBps: Number(await ordersOld.relayRebateBps()),
    serviceFeeNative: await ordersOld.relayServiceFee(ethers.ZeroAddress),
    serviceFeeToken: book.stablecoin ? await ordersOld.relayServiceFee(book.stablecoin) : 0n,
    tokenAccepted: book.stablecoin ? await ordersOld.acceptedToken(book.stablecoin) : false,
    withdrawFeeBps: Number(await vaultOld.withdrawFeeBps()),
  };
  console.log(`  fee=${live.feeBps}bps cancel=${live.assignedCancelBps}bps rebate=${live.relayRebateBps}bps`);
  console.log(`  serviceFee native=${ethers.formatEther(live.serviceFeeNative)} token=${live.serviceFeeToken}`);
  console.log(`  withdrawFee=${live.withdrawFeeBps}bps stablecoin accepted=${live.tokenAccepted}`);

  // ── 0b. In-flight orders that the removal would strand ───────────────────
  // An Open order carrying only open bids has no accept path on v2. Say so
  // BEFORE deploying anything, so the operator can drain rather than discover.
  console.log("\n0b. In-flight orders on the outgoing FareOrders");
  const nextId = await ordersOld.nextOrderId();
  const stranded: bigint[] = [];
  let openCount = 0, assignedCount = 0;
  for (let id = 1n; id < nextId; id++) {
    const st = Number(await ordersOld.statusOf(id));
    if (st === 1) {
      openCount++;
      stranded.push(id); // Open: bids on v1 (of either kind) do not carry over
    } else if (st === 2 || st === 3) {
      assignedCount++;
    }
  }
  console.log(`  ${openCount} Open, ${assignedCount} Assigned/PickedUp, of ${nextId - 1n} total`);
  if (stranded.length > 0) {
    console.log(`  ! Open orders ${stranded.join(", ")} keep their bids on the OLD contract only.`);
    console.log(`    They stay cancellable there (exits work on a frozen contract) —`);
    console.log(`    the customer is refunded in full. Assigned/PickedUp orders settle`);
    console.log(`    normally on v1 until the operator re-points settlement.`);
  }
  if (assignedCount > 0 && process.env.ALLOW_INFLIGHT !== "1") {
    throw new Error(
      `${assignedCount} order(s) are mid-delivery on the outgoing contract. Settlement is ` +
      `re-pointed to v2 in step 7, which would strand them. Let them finish, or set ` +
      `ALLOW_INFLIGHT=1 to proceed and settle them manually against v1.`
    );
  }

  // ── 1. Deploy ────────────────────────────────────────────────────────────
  console.log("\n1. Deploy new instances (legacy paths absent)");
  const vaultNew = await deployC("FareVault", []);
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, book.forwarder]);

  const vaultC = await ethers.getContractAt("FareVault", vaultNew, deployer);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);

  console.log("\n2. setRouter on new instances");
  await send("vaultNew.setRouter", (n) => vaultC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ordersNew.setRouter", (n) => ordersC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 3. Configure ─────────────────────────────────────────────────────────
  console.log("\n3. Configure new instances");
  await send("ordersNew.configure", (n) =>
    ordersC.configure(vaultNew, book.drivers, book.venues, book.settlement, book.disputes, treasury, {
      nonce: n, gasLimit: GAS_LIMIT,
    })
  );
  await send("vaultNew.setAuthorized(ordersNew)", (n) => vaultC.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setAuthorized(disputes)", (n) => vaultC.setAuthorized(book.disputes, true, { nonce: n, gasLimit: GAS_LIMIT }));

  const drivers = await ethers.getContractAt("FareDrivers", book.drivers, deployer);
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  await send("drivers.setAuthorized(ordersNew)", (n) => drivers.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("venues.setAuthorized(ordersNew)", (n) => venues.setAuthorized(ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 4. Re-apply the live settings ────────────────────────────────────────
  console.log("\n4. Re-apply live governance settings");
  await send("ordersNew.setParams", (n) =>
    ordersC.setParams(live.feeBps, live.assignedCancelBps, live.pickupWindow, live.deliveryWindow, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("ordersNew.setRelayRebateBps", (n) => ordersC.setRelayRebateBps(live.relayRebateBps, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("ordersNew.setRelayServiceFee(native)", (n) =>
    ordersC.setRelayServiceFee(ethers.ZeroAddress, live.serviceFeeNative, { nonce: n, gasLimit: GAS_LIMIT })
  );
  if (book.stablecoin) {
    await send("ordersNew.setAcceptedToken(stablecoin)", (n) =>
      ordersC.setAcceptedToken(book.stablecoin, live.tokenAccepted, { nonce: n, gasLimit: GAS_LIMIT })
    );
    await send("ordersNew.setRelayServiceFee(stablecoin)", (n) =>
      ordersC.setRelayServiceFee(book.stablecoin, live.serviceFeeToken, { nonce: n, gasLimit: GAS_LIMIT })
    );
  }
  await send("vaultNew.setWithdrawFeeBps", (n) => vaultC.setWithdrawFeeBps(live.withdrawFeeBps, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 5. Privacy wiring (ZK note path only — there is no keeper to set up) ─
  console.log("\n5. Wire the shielded-payout stack");
  await send("vaultNew.setShieldPool", (n) => vaultC.setShieldPool(SHIELD_POOL, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setShieldBuckets", (n) => vaultC.setShieldBuckets(BUCKETS, { nonce: n, gasLimit: GAS_LIMIT }));
  // 16 Poseidon precompile calls; one-shot, and it initializes the note tree.
  await send("vaultNew.setShieldPoseidon", (n) => vaultC.setShieldPoseidon(POSEIDON, { nonce: n, gasLimit: GAS_LIMIT }));
  // The shield verifier is UNCHANGED, so the existing one is reused — its
  // verifying key is lock-once and re-deploying would need another ceremony.
  await send("vaultNew.setShieldVerifier", (n) => vaultC.setShieldVerifier(book.shieldVerifier, { nonce: n, gasLimit: GAS_LIMIT }));

  // ── 6. Router: promote ───────────────────────────────────────────────────
  console.log("\n6. Router upgrades");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgrade(orders, freeze=true)", (n) =>
    router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("router.upgrade(vault, freeze=FALSE)", (n) =>
    router.upgradeContract(nameKey("vault"), vaultNew, false, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 7. Re-point the contracts that only cache addresses ──────────────────
  console.log("\n7. Re-point settlement / ratings / disputes");
  const settlement = await ethers.getContractAt("FareSettlement", book.settlement, deployer);
  const ratings = await ethers.getContractAt("FareRatings", book.ratings, deployer);
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("settlement.configure(ordersNew, venues)", (n) =>
    settlement.configure(ordersNew, book.venues, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("ratings.configure(ordersNew)", (n) => ratings.configure(ordersNew, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("disputes.configure(ordersNew, vaultNew, drivers, treasury)", (n) =>
    disputes.configure(ordersNew, vaultNew, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 8. Validate ──────────────────────────────────────────────────────────
  console.log("\n8. Validation");
  // The removals, asserted by ABSENCE on the deployed bytecode. A migration
  // whose whole purpose is deletion should prove the deletion, not assume it.
  const ordersGone = ["placeBid", "withdrawBid", "acceptBid", "acceptBidERC20", "bidOf", "biddersOf"];
  const vaultGone = ["queueShieldCredit", "queueShieldCreditFor", "sealShieldBatch",
                     "depositShieldBatch", "reclaimShieldTicket", "setShieldKeeper",
                     "setShieldParams", "shieldKeeper", "shieldPending", "shieldOwed"];
  const checks: Array<[string, boolean]> = [
    ["router→ordersNew", (await router.currentAddrOf(nameKey("orders"))) === ordersNew],
    ["router→vaultNew", (await router.currentAddrOf(nameKey("vault"))) === vaultNew],
    ["ordersNew.vault==vaultNew", (await ordersC.vault()) === vaultNew],
    ["settlement.orders==ordersNew", (await settlement.orders()) === ordersNew],
    ["ratings.orders==ordersNew", (await ratings.orders()) === ordersNew],
    ["disputes.orders==ordersNew", (await disputes.orders()) === ordersNew],
    ["disputes.vault==vaultNew", (await disputes.vault()) === vaultNew],
    ["vaultNew auth ordersNew", await vaultC.authorized(ordersNew)],
    ["drivers auth ordersNew", await drivers.authorized(ordersNew)],
    ["venues auth ordersNew", await venues.authorized(ordersNew)],
    // settings carried over, not reset
    ["feeBps preserved", Number(await ordersC.feeBps()) === live.feeBps],
    ["relayRebateBps preserved", Number(await ordersC.relayRebateBps()) === live.relayRebateBps],
    ["serviceFee(native) preserved", (await ordersC.relayServiceFee(ethers.ZeroAddress)) === live.serviceFeeNative],
    ["withdrawFeeBps preserved", Number(await vaultC.withdrawFeeBps()) === live.withdrawFeeBps],
    // shielded payouts still wired
    ["vault.shieldPool", (await vaultC.shieldPool()) === SHIELD_POOL],
    ["vault.shieldVerifier", (await vaultC.shieldVerifier()) === book.shieldVerifier],
    ["vault.shieldPoseidon", (await vaultC.shieldPoseidon()) === POSEIDON],
    ["vault.buckets", Number(await vaultC.shieldBucketCount()) === BUCKETS.length],
    ["note tree initialized", (await vaultC.noteRoot()) !== 0n],
    // the replacements are reachable
    ["sealed bids available", Number(await ordersC.MAX_SEALED_BIDS()) === 256],
    ["acceptSealedBidERC20 present", ordersC.interface.hasFunction("acceptSealedBidERC20")],
    ["insertShieldNote present", vaultC.interface.hasFunction("insertShieldNote")],
    ["depositShieldNoteZK present", vaultC.interface.hasFunction("depositShieldNoteZK")],
    // the removals
    ...ordersGone.map((f) => [`orders.${f} GONE`, !ordersC.interface.hasFunction(f)] as [string, boolean]),
    ...vaultGone.map((f) => [`vault.${f} GONE`, !vaultC.interface.hasFunction(f)] as [string, boolean]),
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-migration validation failed");

  // ── 9. Persist address books ─────────────────────────────────────────────
  console.log("\n9. Persist address books");
  const oldVault = book.vault, oldOrders = book.orders;
  book.vault = vaultNew;
  book.orders = ordersNew;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`  books updated (${ADDR_FILE})`);

  // ── 10. Re-seed a demo order ─────────────────────────────────────────────
  console.log("\n10. Re-seed a demo order (venue #1)");
  if (await venues.isActive(1n)) {
    const DROP_LAT = 37_784_900, DROP_LON = -122_419_400, SALT = 12345678901234567890n;
    const commit = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT])
    );
    await send("ordersNew.createOrder(venue 1, maxFare 0.5)", (n) =>
      ordersC.createOrder(1n, commit, 0, 0, ethers.parseEther("0.5"), 0, 0, {
        value: live.serviceFeeNative, nonce: n, gasLimit: GAS_LIMIT,
      })
    );
    console.log(`  seeded order #${(await ordersC.nextOrderId()) - 1n}`);
  } else {
    console.log("  (venue #1 inactive — skipping reseed)");
  }

  console.log(`\nDone. The legacy paths are off the live deployment.`);
  console.log(`  orders=${ordersNew}  (old ${oldOrders} FROZEN — exits only)`);
  console.log(`  vault=${vaultNew}    (old ${oldVault} kept live for drain)`);
  console.log(`\nBidding is sealed-only: there is no longer a call that publishes a`);
  console.log(`driver's price. Shielding is ZK-note-only: there is no keeper to`);
  console.log(`authorize, so no setShieldKeeper call can re-arm a divertible buffer.`);
  if (stranded.length > 0) {
    console.log(`\nOpen orders left on the old contract: ${stranded.join(", ")} — cancel there to refund.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
