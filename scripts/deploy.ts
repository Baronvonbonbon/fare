// deploy.ts — FARE 7-contract deployment + wiring.
//
// Paseo eth-rpc workaround (inherited from the DATUM alpha-core deploy
// experience): getTransactionReceipt can return null for confirmed txs, so
// we confirm by nonce polling and derive deploy addresses with
// getCreateAddress(sender, nonce), then verify with getCode().
//
// Re-run safe: reads deployed-addresses.<network>.json and skips contracts
// that already have code; wiring calls are idempotent.
//
// Usage:
//   npx hardhat run scripts/deploy.ts --network localhost
//   npx hardhat run scripts/deploy.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Paseo gas is in weight units (~1.5e15 scale); explicit 500M limit needed
// there, while local nodes cap per-tx gas far lower — so only set on Paseo
// (hosted gateway or the local pine light-client daemon, same chain).
const PASEO_NETWORKS = ["polkadotTestnet", "pine"];
const GAS_LIMIT = PASEO_NETWORKS.includes(network.name) ? 500_000_000n : undefined;

// pine-rpc quirk: eth_getCode hangs on Asset Hub today (CAPABILITIES.md), so
// on the pine network we skip code-based verification and rely on nonce
// confirmation + the wiring validation reads (eth_call works fine).
const CAN_GET_CODE = network.name !== "pine";

// `pine` is Paseo reached through a local light client — same chain, same
// canonical address book as polkadotTestnet.
const suffix = ["polkadotTestnet", "pine"].includes(network.name) ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");

type AddressBook = Record<string, string>;

function loadAddresses(): AddressBook {
  if (fs.existsSync(ADDR_FILE)) return JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  return {};
}

function saveAddresses(book: AddressBook) {
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
}

async function waitForNonce(provider: any, address: string, targetNonce: number, maxWait = 180) {
  for (let i = 0; i < maxWait; i++) {
    const current = await provider.getTransactionCount(address);
    if (current > targetNonce) return;
    if (i % 10 === 0 && i > 0) console.log(`    ...waiting for confirmation (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${targetNonce}`);
}

async function verifyCode(provider: any, addr: string, maxWait = 60): Promise<boolean> {
  for (let i = 0; i < maxWait; i++) {
    const code = await provider.getCode(addr);
    if (code && code !== "0x") return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account — set DEPLOYER_PRIVATE_KEY in .env");
  const provider = ethers.provider;
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(deployer.address))}\n`);

  const book = loadAddresses();

  async function deployOrReuse(key: string, contractName: string, args: any[] = []): Promise<string> {
    if (book[key]) {
      if (!CAN_GET_CODE) {
        console.log(`  = ${contractName} reused at ${book[key]} (pine: getCode unavailable, trusting address book)`);
        return book[key];
      }
      const code = await provider.getCode(book[key]);
      if (code && code !== "0x") {
        console.log(`  = ${contractName} reused at ${book[key]}`);
        return book[key];
      }
    }
    const factory = await ethers.getContractFactory(contractName, deployer);
    const nonce = await provider.getTransactionCount(deployer.address);
    const unsigned = await factory.getDeployTransaction(...args);
    await deployer.sendTransaction({ ...unsigned, nonce, gasLimit: GAS_LIMIT });
    await waitForNonce(provider, deployer.address, nonce);
    const addr = ethers.getCreateAddress({ from: deployer.address, nonce });
    if (CAN_GET_CODE) {
      if (!(await verifyCode(provider, addr))) {
        throw new Error(`${contractName}: no code at derived address ${addr}`);
      }
    } else {
      console.log(`    (pine: skipping getCode verification — nonce confirmed)`);
    }
    console.log(`  + ${contractName} deployed at ${addr}`);
    book[key] = addr;
    saveAddresses(book);
    return addr;
  }

  async function send(label: string, txFactory: () => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await txFactory();
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  // ── 1. Deploy ──────────────────────────────────────────────────────────
  console.log("1. Deploying contracts");
  const router = await deployOrReuse("router", "FareGovernanceRouter");
  const pause = await deployOrReuse("pauseRegistry", "FarePauseRegistry");
  const vault = await deployOrReuse("vault", "FareVault");
  const drivers = await deployOrReuse("drivers", "FareDrivers", [pause]);
  const venues = await deployOrReuse("venues", "FareVenues", [pause]);
  // EIP-2771 trusted forwarder for gasless meta-txs (F8) — must exist before
  // FareOrders / FareRatings so it can be baked into their (immutable) context.
  const forwarder = await deployOrReuse("forwarder", "FareForwarder");
  const orders = await deployOrReuse("orders", "FareOrders", [pause, forwarder]);
  const settlement = await deployOrReuse("settlement", "FareSettlement", [pause]);
  const disputes = await deployOrReuse("disputes", "FareDisputes", [pause]);
  const locationVerifier = await deployOrReuse("locationVerifier", "FareLocationVerifier");
  const ratings = await deployOrReuse("ratings", "FareRatings", [forwarder]);

  // Stablecoin escrow (C3): use a configured real stablecoin (mainnet: the
  // bridged USDC/USDT precompile) if given, else deploy a MockUSDC so the
  // testnet demo has an accepted escrow token out of the box.
  const stablecoin = process.env.STABLECOIN_ADDRESS
    ?? (await deployOrReuse("stablecoin", "MockUSDC"));

  // ── 2. Wiring ──────────────────────────────────────────────────────────
  console.log("\n2. Wiring");
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;
  const ordersC = await ethers.getContractAt("FareOrders", orders, deployer);
  const settlementC = await ethers.getContractAt("FareSettlement", settlement, deployer);
  const disputesC = await ethers.getContractAt("FareDisputes", disputes, deployer);
  const vaultC = await ethers.getContractAt("FareVault", vault, deployer);
  const driversC = await ethers.getContractAt("FareDrivers", drivers, deployer);
  const venuesC = await ethers.getContractAt("FareVenues", venues, deployer);

  if ((await ordersC.settlement()) !== settlement) {
    await send("orders.configure", () =>
      ordersC.configure(vault, drivers, venues, settlement, disputes, treasury, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = orders already configured");

  // Register the stablecoin as an accepted escrow token (C3).
  if (!(await ordersC.acceptedToken(stablecoin))) {
    await send("orders.setAcceptedToken(stablecoin)", () =>
      ordersC.setAcceptedToken(stablecoin, true, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = stablecoin already accepted");

  if ((await settlementC.orders()) !== orders) {
    await send("settlement.configure", () =>
      settlementC.configure(orders, venues, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = settlement already configured");

  // ── ZK proximity verifier: set the VK, then wire it into settlement ─────
  const verifierC = await ethers.getContractAt("FareLocationVerifier", locationVerifier, deployer);
  const VK_CALLDATA = path.join(__dirname, "..", "circuits", "build", "setVK-calldata.json");
  if (!(await verifierC.vkSet())) {
    if (fs.existsSync(VK_CALLDATA)) {
      const vk = JSON.parse(fs.readFileSync(VK_CALLDATA, "utf-8"));
      await send("locationVerifier.setVerifyingKey", () =>
        verifierC.setVerifyingKey(
          vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
          vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5,
          { gasLimit: GAS_LIMIT }
        )
      );
    } else {
      console.log("  ! setVK-calldata.json missing — run `node scripts/setup-zk.mjs` then re-run deploy");
    }
  } else console.log("  = locationVerifier VK already set");

  if ((await settlementC.locationVerifier()) !== locationVerifier) {
    await send("settlement.setLocationVerifier", () =>
      settlementC.setLocationVerifier(locationVerifier, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = settlement verifier already wired");

  if ((await disputesC.orders()) !== orders) {
    await send("disputes.configure", () =>
      disputesC.configure(orders, vault, drivers, treasury, { gasLimit: GAS_LIMIT })
    );
  } else console.log("  = disputes already configured");

  const ratingsC = await ethers.getContractAt("FareRatings", ratings, deployer);
  if ((await ratingsC.orders()) !== orders) {
    await send("ratings.configure", () => ratingsC.configure(orders, { gasLimit: GAS_LIMIT }));
  } else console.log("  = ratings already configured");

  for (const [who, addr] of [
    ["orders", orders],
    ["disputes", disputes],
  ] as const) {
    if (!(await vaultC.authorized(addr))) {
      await send(`vault.setAuthorized(${who})`, () =>
        vaultC.setAuthorized(addr, true, { gasLimit: GAS_LIMIT })
      );
    }
    if (!(await driversC.authorized(addr))) {
      await send(`drivers.setAuthorized(${who})`, () =>
        driversC.setAuthorized(addr, true, { gasLimit: GAS_LIMIT })
      );
    }
  }
  if (!(await venuesC.authorized(orders))) {
    await send("venues.setAuthorized(orders)", () =>
      venuesC.setAuthorized(orders, true, { gasLimit: GAS_LIMIT })
    );
  }

  // ── 2b. Upgradability: registry + router binding ───────────────────────
  console.log("\n2b. Governance router registry");
  const routerC = await ethers.getContractAt("FareGovernanceRouter", router, deployer);
  const registryEntries: Array<[string, string]> = [
    ["pauseRegistry", pause],
    ["vault", vault],
    ["drivers", drivers],
    ["venues", venues],
    ["orders", orders],
    ["settlement", settlement],
    ["disputes", disputes],
    ["ratings", ratings],
  ];
  for (const [name, addr] of registryEntries) {
    const key = ethers.encodeBytes32String(name);
    if ((await routerC.currentAddrOf(key)) !== addr) {
      await send(`router.register(${name})`, () =>
        routerC.register(key, addr, { gasLimit: GAS_LIMIT })
      );
    } else console.log(`  = router already has ${name}`);
  }
  // Bind the router as upgrade authority on the six FareUpgradable contracts
  // (pauseRegistry is registered for discovery only — not upgradable).
  for (const [name, addr] of registryEntries.slice(1)) {
    const c = await ethers.getContractAt("FareVault", addr, deployer); // any FareUpgradable ABI works for router()
    if ((await c.router()) === ethers.ZeroAddress) {
      await send(`${name}.setRouter`, () => c.setRouter(router, { gasLimit: GAS_LIMIT }));
    } else console.log(`  = ${name} router already bound`);
  }

  // ── 3. Validate ────────────────────────────────────────────────────────
  console.log("\n3. Validation");
  const checks: Array<[string, boolean]> = [
    ["orders.vault", (await ordersC.vault()) === vault],
    ["orders.settlement", (await ordersC.settlement()) === settlement],
    ["orders.disputes", (await ordersC.disputes()) === disputes],
    ["settlement.orders", (await settlementC.orders()) === orders],
    ["settlement.venues", (await settlementC.venues()) === venues],
    ["settlement.verifier", (await settlementC.locationVerifier()) === locationVerifier],
    ["verifier VK set", await verifierC.vkSet()],
    ["disputes.orders", (await disputesC.orders()) === orders],
    ["ratings.orders", (await ratingsC.orders()) === orders],
    ["vault auth orders", await vaultC.authorized(orders)],
    ["vault auth disputes", await vaultC.authorized(disputes)],
    ["drivers auth orders", await driversC.authorized(orders)],
    ["drivers auth disputes", await driversC.authorized(disputes)],
    ["venues auth orders", await venuesC.authorized(orders)],
    [
      "router registry complete",
      (
        await Promise.all(
          registryEntries.map(
            async ([n, a]) => (await routerC.currentAddrOf(ethers.encodeBytes32String(n))) === a
          )
        )
      ).every(Boolean),
    ],
    ["orders router bound", (await ordersC.router()) === router],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "OK " : "FAIL"} ${label}`);
    if (!pass) ok = false;
  }
  if (!ok) throw new Error("Wiring validation failed");

  // ── 4. Export for the web app ──────────────────────────────────────────
  const exportBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.mkdirSync(path.dirname(WEB_ADDR_FILE), { recursive: true });
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(exportBook, null, 2) + "\n");
  console.log(`\nAddresses written to ${ADDR_FILE} and ${WEB_ADDR_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
