// upgrade-privacy.ts — promote the live deployment to the privacy stack
// (docs/PRIVACY-TIERS.md phases 1–4) through the freeze-and-drain router.
//
// Contracts that changed and are redeployed here:
//   FareVault           — shielded payouts (ticket/batch + ZK note pool);
//                         MIGRATED freeze=false (it custodies balances, so v1
//                         stays live for existing withdrawals — the drain path)
//   FareOrders          — sealed bids; UPGRADED (freeze old)
//   FareShieldVerifier  — NEW (Groth16 over circuits/shieldnote.circom)
//
// Unchanged and RE-POINTED rather than redeployed (their logic did not change,
// they only cache addresses): settlement, ratings, disputes.
//
// Unchanged and kept as-is: router, pauseRegistry, drivers, venues,
// locationVerifier, forwarder, stablecoin.
//
// Every live governance setting is READ FROM CHAIN and re-applied to the new
// instances. A migration that silently reset the fee schedule would be worse
// than no migration, and the defaults in the source are not what is deployed.
//
// Idempotency: one-shot, like the other upgrade scripts. Each run deploys fresh.
//
// Usage: npx hardhat run scripts/upgrade-privacy.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const VK_FILE = path.join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);

// Kusama Shield pool + Paseo's PVM-native Poseidon. Both are external, live
// deployments — see docs/SHIELDED-POOL-INTEGRATION.md and E2E-PRIVACY-ZK.md.
const SHIELD_POOL = process.env.SHIELD_POOL ?? "0x3068490C79708D0725E3D4Aa9C35Da708f09071e";
const POSEIDON = process.env.POSEIDON ?? "0x1d165f6fE5A30422E0E2140e91C8A9B800380637";
// Fixed denominations: without them the amounts re-identify entries and the
// batching is decorative (PRIVACY-TIERS §4).
const BUCKETS = (process.env.SHIELD_BUCKETS ?? "1,5,25").split(",").map((b) => ethers.parseEther(b.trim()));
const MIN_BATCH = Number(process.env.SHIELD_MIN_BATCH ?? 8);
const MIN_DWELL = Number(process.env.SHIELD_MIN_DWELL ?? 300);
const RECLAIM_AFTER = Number(process.env.SHIELD_RECLAIM_AFTER ?? 86_400);

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

  // ── 1. Deploy ────────────────────────────────────────────────────────────
  console.log("\n1. Deploy new instances");
  const vaultNew = await deployC("FareVault", []);
  const ordersNew = await deployC("FareOrders", [book.pauseRegistry, book.forwarder]);
  const verifier = await deployC("FareShieldVerifier", []);

  const vaultC = await ethers.getContractAt("FareVault", vaultNew, deployer);
  const ordersC = await ethers.getContractAt("FareOrders", ordersNew, deployer);
  const verifierC = await ethers.getContractAt("FareShieldVerifier", verifier, deployer);

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
  console.log("\n4. Re-apply live governance settings to the new instances");
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

  // ── 5. Privacy wiring ────────────────────────────────────────────────────
  console.log("\n5. Wire the privacy stack");
  const vk = JSON.parse(fs.readFileSync(VK_FILE, "utf-8"));
  await send("verifier.setVerifyingKey (lock-once)", (n) =>
    verifierC.setVerifyingKey(vk.alpha1, vk.beta2, vk.gamma2, vk.delta2, vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, {
      nonce: n, gasLimit: GAS_LIMIT,
    })
  );
  await send("vaultNew.setShieldPool", (n) => vaultC.setShieldPool(SHIELD_POOL, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setShieldBuckets", (n) => vaultC.setShieldBuckets(BUCKETS, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setShieldParams", (n) =>
    vaultC.setShieldParams(MIN_BATCH, MIN_DWELL, RECLAIM_AFTER, { nonce: n, gasLimit: GAS_LIMIT })
  );
  // 16 Poseidon precompile calls; one-shot, and it initializes the note tree.
  await send("vaultNew.setShieldPoseidon", (n) => vaultC.setShieldPoseidon(POSEIDON, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setShieldVerifier", (n) => vaultC.setShieldVerifier(verifier, { nonce: n, gasLimit: GAS_LIMIT }));
  // NOTE: no shield KEEPER is authorized here. The ZK path needs none, and a
  // keeper can divert the ticket-path buffer (PRIVACY-TIERS §4) — so enabling
  // one is a deliberate operator decision, not part of a migration.

  // ── 6. Router: promote ───────────────────────────────────────────────────
  console.log("\n6. Router upgrades");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgrade(orders, freeze=true)", (n) =>
    router.upgradeContract(nameKey("orders"), ordersNew, true, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("router.upgrade(vault, freeze=FALSE)", (n) =>
    router.upgradeContract(nameKey("vault"), vaultNew, false, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("router.register(shieldVerifier)", (n) =>
    router.register(nameKey("shieldVerifier"), verifier, { nonce: n, gasLimit: GAS_LIMIT })
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
    // privacy stack
    ["vault.shieldPool", (await vaultC.shieldPool()) === SHIELD_POOL],
    ["vault.shieldVerifier", (await vaultC.shieldVerifier()) === verifier],
    ["vault.shieldPoseidon", (await vaultC.shieldPoseidon()) === POSEIDON],
    ["vault.buckets", Number(await vaultC.shieldBucketCount()) === BUCKETS.length],
    ["vault.minBatch", Number(await vaultC.shieldMinBatch()) === MIN_BATCH],
    ["note tree initialized", (await vaultC.noteRoot()) !== 0n],
    ["sealed bids available", Number(await ordersC.MAX_SEALED_BIDS()) === 256],
    ["no keeper authorized", !(await vaultC.shieldKeeper(deployer.address))],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-migration validation failed");

  // ── 9. Persist address books ─────────────────────────────────────────────
  console.log("\n9. Persist address books");
  const oldVault = book.vault;
  book.vault = vaultNew;
  book.orders = ordersNew;
  book.shieldVerifier = verifier;
  book.shieldPool = SHIELD_POOL;
  book.poseidon = POSEIDON;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`  books updated (${ADDR_FILE})`);

  // ── 10. Re-seed a demo order on the new orders ───────────────────────────
  console.log("\n10. Re-seed a demo order (venue #1)");
  if (await venues.isActive(1n)) {
    const DROP_LAT = 37_784_900, DROP_LON = -122_419_400, SALT = 12345678901234567890n;
    const commit = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT])
    );
    const svc = live.serviceFeeNative;
    await send("ordersNew.createOrder(venue 1, maxFare 0.5)", (n) =>
      ordersC.createOrder(1n, commit, 0, 0, ethers.parseEther("0.5"), 0, 0, {
        value: svc, nonce: n, gasLimit: GAS_LIMIT,
      })
    );
    console.log(`  seeded order #${(await ordersC.nextOrderId()) - 1n}`);
  } else {
    console.log("  (venue #1 inactive — skipping reseed)");
  }

  console.log(`\nDone. Privacy stack live.`);
  console.log(`  vault=${vaultNew}   (old ${oldVault} kept live for drain)`);
  console.log(`  orders=${ordersNew}  shieldVerifier=${verifier}`);
  console.log(`  shieldPool=${SHIELD_POOL}  poseidon=${POSEIDON}`);
  console.log(`  buckets=${BUCKETS.map((b) => ethers.formatEther(b)).join("/")} PAS  minBatch=${MIN_BATCH}  dwell=${MIN_DWELL}s`);
  console.log(`\nOld-vault balances remain withdrawable on the old vault.`);
  console.log(`No shield keeper is authorized: the ZK path needs none, and a keeper`);
  console.log(`can divert the ticket-path buffer. Authorize one only deliberately.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
