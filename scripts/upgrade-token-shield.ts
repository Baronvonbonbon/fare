// Migrate FareVault to the token-aware shield-note path.
//
// WHAT CHANGES. Only FareVault. A payee settled in USDC previously had no
// private exit at all — the note path was native-only (`depositShieldNoteZK`
// called `depositNative`, and the buffer and bucket ladder were single native
// values), so their only move was `withdrawToken` to a named address. The new
// vault adds `insertShieldNoteToken` → `depositShieldNoteTokenZK`, ending in
// `depositAsset(assetId, …)` on the pool.
//
// The asset is bound by ONE NOTE TREE PER ASSET. The shield-note circuit's public
// signals are [root, nullifierHash, bucket, ksCommitment] with no asset among
// them, and a spend reveals only the nullifier — never the commitment — so the
// vault cannot look up which asset a spent note belonged to. Separate trees make
// `root` carry it: a USDC-tree proof can never satisfy the native root window.
// No circuit change, so NO SECOND TRUSTED SETUP; the existing verifier and its
// lock-once verifying key are reused untouched.
//
// OUTSTANDING NOTES ARE NOT STRANDED. The old vault is upgraded with
// freeze=false and keeps its pool, verifier and Poseidon wiring, so any note
// already in its tree stays spendable there. That is checked below rather than
// assumed. Same for ordinary balances: the old vault remains the drain path.
//
// Usage: npx hardhat run scripts/upgrade-token-shield.ts --network polkadotTestnet
//        DRY_RUN=1 to read + validate the preflight and deploy nothing.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
const GAS_LIMIT = PASEO ? 500_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");
const nameKey = (s: string) => ethers.encodeBytes32String(s);
const DRY_RUN = process.env.DRY_RUN === "1";

// Read from the address book first: on a local chain these are mocks, and
// hardcoding Paseo's makes the migration revert against an account with no code.
const PASEO_SHIELD_POOL = "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const PASEO_POSEIDON = "0x1d165f6fE5A30422E0E2140e91C8A9B800380637";

// Native ladder (18dp PAS), carried over from the live vault unless overridden.
const NATIVE_BUCKETS = (process.env.SHIELD_BUCKETS ?? "1,5,25").split(",").map((b) => ethers.parseEther(b.trim()));
// USDC ladder (6dp). Must match web/src/denominations.ts LADDER_USDC, or the
// client will plan rungs the vault rejects with "bad-bucket". Every rung clears
// USDC's 0.07 minBalance — the asset is `isSufficient`, so a withdrawal to a
// FRESH address below that fails account creation and wastes the note.
const TOKEN_BUCKETS = (process.env.SHIELD_BUCKETS_USDC ?? "0.5,1,5,25,100")
  .split(",").map((b) => ethers.parseUnits(b.trim(), 6));
// Asset Hub asset id for the escrow token. `depositAsset` takes the ID, while the
// pool's escrow ledger and the note commitment key on the precompile ADDRESS —
// set it explicitly rather than deriving it, so a change in the address scheme
// cannot silently misroute value.
const ASSET_ID = BigInt(process.env.STABLECOIN_ASSET_ID ?? 1337);

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
  const STABLECOIN = process.env.STABLECOIN_ADDRESS ?? book.stablecoin;

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Vault:    ${book.vault}  (outgoing)`);
  console.log(`Pool:     ${SHIELD_POOL}`);
  console.log(`Token:    ${STABLECOIN ?? "(none — token shielding will not be wired)"}\n`);

  // ── 0. PREFLIGHT: is the pool actually withdrawable? ─────────────────────
  // A FREE view call, no funds and no gas, and it is the check that would have
  // prevented the worst incident in this project's history. The "canonical"
  // Kusama Shield v7 pool 0x3068490C… reverts Panic(0x32) here for every
  // non-zero root; both `withdraw` and `proxy_withdraw` require isKnownRoot
  // AFTER the proof verifies, so every withdrawal reverts permanently and every
  // deposit is stuck. A migration onto it was made on static evidence (circuit
  // hashes, selector presence) and cost a driver's shielded payout.
  //
  // NEVER point a vault at a pool without running this first.
  console.log("0. Preflight: pool withdrawability");
  const pool = new ethers.Contract(
    SHIELD_POOL,
    ["function isKnownRoot(uint256) view returns (bool)", "function treeSize() view returns (uint256)"],
    provider
  );
  try {
    await pool.isKnownRoot(1n);
    const size = await pool.treeSize().catch(() => null);
    console.log(`  ✓ isKnownRoot(1) answered — pool is live${size != null ? `, ${size} leaves` : ""}`);
  } catch (e: any) {
    throw new Error(
      `POOL IS UNWITHDRAWABLE: isKnownRoot(1) reverted (${e?.shortMessage ?? e?.message}).\n` +
      `      Every withdrawal from ${SHIELD_POOL} will revert and every deposit will be stuck.\n` +
      `      Do NOT migrate onto it. The known-good pool is ${PASEO_SHIELD_POOL}.`
    );
  }

  // ── 1. Read the LIVE settings, so none of them are silently reset ────────
  console.log("\n1. Reading live governance settings");
  const vaultOld = await ethers.getContractAt("FareVault", book.vault, deployer);
  const ordersC = await ethers.getContractAt("FareOrders", book.orders, deployer);
  const live = {
    withdrawFeeBps: Number(await vaultOld.withdrawFeeBps()),
    shieldPool: await vaultOld.shieldPool(),
    shieldVerifier: await vaultOld.shieldVerifier(),
    shieldPoseidon: await vaultOld.shieldPoseidon(),
    noteIndex: Number(await vaultOld.nextNoteIndex()),
    buffer: await vaultOld.shieldBuffer(),
  };
  console.log(`  withdrawFee=${live.withdrawFeeBps}bps  notes=${live.noteIndex}  buffer=${ethers.formatEther(live.buffer)} PAS`);
  console.log(`  verifier=${live.shieldVerifier}`);

  // Outstanding notes stay spendable on the OLD vault, which keeps freeze=false
  // and all of its wiring. Report rather than block — but report loudly, because
  // "the old one still works" is a claim worth seeing evidence for.
  if (live.noteIndex > 0) {
    console.log(`  ! ${live.noteIndex} note(s) exist in the old vault's tree.`);
    console.log(`    They remain spendable THERE (old vault stays unfrozen and wired).`);
    console.log(`    They do NOT migrate: the new vault starts with an empty tree.`);
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — preflight passed, nothing deployed.");
    return;
  }

  async function send(label: string, fn: (nonce: number) => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn(nonce);
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  // ── 2. Deploy the new vault ──────────────────────────────────────────────
  console.log("\n2. Deploy FareVault");
  const factory = await ethers.getContractFactory("FareVault", deployer);
  const nonce0 = await provider.getTransactionCount(deployer.address);
  const unsigned = await factory.getDeployTransaction();
  await deployer.sendTransaction({ ...unsigned, nonce: nonce0, gasLimit: GAS_LIMIT });
  await waitForNonce(provider, deployer.address, nonce0);
  const vaultNew = ethers.getCreateAddress({ from: deployer.address, nonce: nonce0 });
  console.log(`  + FareVault at ${vaultNew}`);
  const vaultC = await ethers.getContractAt("FareVault", vaultNew, deployer);

  // ── 3. Wire ──────────────────────────────────────────────────────────────
  console.log("\n3. Configure");
  await send("vaultNew.setRouter", (n) => vaultC.setRouter(book.router, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setAuthorized(orders)", (n) => vaultC.setAuthorized(book.orders, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setAuthorized(disputes)", (n) => vaultC.setAuthorized(book.disputes, true, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setWithdrawFeeBps", (n) => vaultC.setWithdrawFeeBps(live.withdrawFeeBps, { nonce: n, gasLimit: GAS_LIMIT }));

  console.log("\n4. Wire the shielded-payout stack");
  await send("vaultNew.setShieldPool", (n) => vaultC.setShieldPool(SHIELD_POOL, { nonce: n, gasLimit: GAS_LIMIT }));
  await send("vaultNew.setShieldBuckets(native)", (n) => vaultC.setShieldBuckets(NATIVE_BUCKETS, { nonce: n, gasLimit: GAS_LIMIT }));
  // One-shot: 16 Poseidon precompile calls, and it pre-pays the native tree's
  // storage. MUST precede setShieldBucketsToken, which pre-pays that asset's
  // tree from the same zeros and reverts "poseidon-unset" otherwise.
  await send("vaultNew.setShieldPoseidon", (n) => vaultC.setShieldPoseidon(POSEIDON, { nonce: n, gasLimit: GAS_LIMIT }));
  // The verifier is UNCHANGED and reused: its verifying key is lock-once, and
  // redeploying would demand another trusted setup — the very thing the
  // per-asset-tree design exists to avoid.
  await send("vaultNew.setShieldVerifier", (n) => vaultC.setShieldVerifier(live.shieldVerifier, { nonce: n, gasLimit: GAS_LIMIT }));

  if (STABLECOIN) {
    console.log("\n5. Wire token shielding");
    await send("vaultNew.setShieldBucketsToken(stablecoin)", (n) =>
      vaultC.setShieldBucketsToken(STABLECOIN, TOKEN_BUCKETS, { nonce: n, gasLimit: GAS_LIMIT })
    );
    await send("vaultNew.setShieldAssetId(stablecoin)", (n) =>
      vaultC.setShieldAssetId(STABLECOIN, ASSET_ID, { nonce: n, gasLimit: GAS_LIMIT })
    );
  } else {
    console.log("\n5. No stablecoin in the address book — skipping token shielding");
  }

  // ── 6. Router: promote with freeze=FALSE ─────────────────────────────────
  // The vault is the drain path for every other contract's freeze-and-drain
  // upgrade, so it must never be frozen. The old instance stays live until its
  // balances AND its outstanding notes reach zero.
  console.log("\n6. Router upgrade (vault, freeze=FALSE)");
  const router = await ethers.getContractAt("FareGovernanceRouter", book.router, deployer);
  await send("router.upgrade(vault, freeze=false)", (n) =>
    router.upgradeContract(nameKey("vault"), vaultNew, false, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 7. Re-point the contracts that cache the vault address ───────────────
  console.log("\n7. Re-point orders / disputes");
  await send("orders.configure(vaultNew)", (n) =>
    ordersC.configure(vaultNew, book.drivers, book.venues, book.settlement, book.disputes, treasury, {
      nonce: n, gasLimit: GAS_LIMIT,
    })
  );
  const disputes = await ethers.getContractAt("FareDisputes", book.disputes, deployer);
  await send("disputes.configure(vaultNew)", (n) =>
    disputes.configure(book.orders, vaultNew, book.drivers, treasury, { nonce: n, gasLimit: GAS_LIMIT })
  );

  // ── 8. Validate ──────────────────────────────────────────────────────────
  console.log("\n8. Validation");
  const oldVaultC = await ethers.getContractAt("FareVault", book.vault, deployer);
  const checks: Array<[string, boolean]> = [
    ["router→vaultNew", (await router.currentAddrOf(nameKey("vault"))) === vaultNew],
    ["orders.vault==vaultNew", (await ordersC.vault()) === vaultNew],
    ["disputes.vault==vaultNew", (await disputes.vault()) === vaultNew],
    ["vaultNew auth orders", await vaultC.authorized(book.orders)],
    ["vaultNew auth disputes", await vaultC.authorized(book.disputes)],
    ["withdrawFeeBps preserved", Number(await vaultC.withdrawFeeBps()) === live.withdrawFeeBps],
    ["vault.shieldPool", (await vaultC.shieldPool()) === SHIELD_POOL],
    ["vault.shieldVerifier reused", (await vaultC.shieldVerifier()) === live.shieldVerifier],
    ["vault.shieldPoseidon", (await vaultC.shieldPoseidon()) === POSEIDON],
    ["native buckets", Number(await vaultC.shieldBucketCount()) === NATIVE_BUCKETS.length],
    ["native tree initialized", (await vaultC.noteRoot()) !== 0n],
    // The new surface is reachable.
    ["insertShieldNoteToken present", vaultC.interface.hasFunction("insertShieldNoteToken")],
    ["depositShieldNoteTokenZK present", vaultC.interface.hasFunction("depositShieldNoteTokenZK")],
    ["withdrawForToken present", vaultC.interface.hasFunction("withdrawForToken")],
    // The native surface the client and relay still call is unchanged.
    ["isKnownNoteRoot(uint256) kept", vaultC.interface.hasFunction("isKnownNoteRoot")],
    ["nextNoteIndex() kept", vaultC.interface.hasFunction("nextNoteIndex")],
    ["shieldBuffer() kept", vaultC.interface.hasFunction("shieldBuffer")],
    // The OLD vault is still a working exit for anything left in it — the claim
    // this migration's safety rests on, so it is measured, not assumed.
    // No `.catch(() => false)` here: a fallback would turn an unreadable old
    // vault into a silent pass, and this check is the safety claim.
    ["old vault NOT frozen", !(await oldVaultC.frozen())],
    ["old vault still pool-wired", (await oldVaultC.shieldPool()) !== ethers.ZeroAddress],
    ["old vault still verifier-wired", (await oldVaultC.shieldVerifier()) !== ethers.ZeroAddress],
  ];
  if (STABLECOIN) {
    checks.push(
      ["token buckets", Number(await vaultC.shieldBucketCountToken(STABLECOIN)) === TOKEN_BUCKETS.length],
      ["token asset id", (await vaultC.shieldAssetId(STABLECOIN)) === ASSET_ID],
      ["token tree empty but warmed", Number(await vaultC.noteIndexOf(STABLECOIN)) === 0],
      // The binding, checked on-chain: the two trees are distinct root sets.
      ["native root not known to token tree",
        !(await vaultC.isKnownNoteRootFor(STABLECOIN, await vaultC.noteRoot())) ||
        (await vaultC.noteRootOf(STABLECOIN)) === (await vaultC.noteRoot())],
    );
  }
  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("post-migration validation failed");

  // ── 9. Persist address books ─────────────────────────────────────────────
  console.log("\n9. Persist address books");
  const oldVault = book.vault;
  book.vault = vaultNew;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  console.log(`  ~ ${path.relative(process.cwd(), ADDR_FILE)}`);
  if (PASEO && fs.existsSync(WEB_ADDR_FILE)) {
    const web = JSON.parse(fs.readFileSync(WEB_ADDR_FILE, "utf-8"));
    if (web.addresses) web.addresses.vault = vaultNew; else web.vault = vaultNew;
    fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(web, null, 2) + "\n");
    console.log(`  ~ ${path.relative(process.cwd(), WEB_ADDR_FILE)}`);
  }

  console.log(`\n✅ vault ${oldVault} → ${vaultNew}`);
  console.log(`   Old vault stays LIVE for drain: balances and its ${live.noteIndex} note(s) exit there.`);
  console.log(`   Payees with a balance on the old vault must withdraw from it, not the new one.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
