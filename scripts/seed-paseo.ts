// seed-paseo.ts — minimal live-demo seed for the Paseo deployment.
//
// Unlike seed.ts (localhost, 20 funded signers), Paseo only has the deployer
// account, and funding fresh role accounts is impractical (a 500M-gas tx
// reserves ~1000 PAS at submission, so a lightly-funded account is rejected).
// So we seed everything the demo needs FROM THE DEPLOYER:
//   - a couple of registered venues  → customers have somewhere to order from
//   - one open order                 → drivers have a job to see + bid on
// Real test users then act through the app's auto-funded burner wallets.
//
// Usage: npx hardhat run scripts/seed-paseo.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import { poseidon3 } from "poseidon-lite";
import * as fs from "fs";
import * as path from "path";

const GAS = 500_000_000n; // Paseo weight-scale gas limit (as in deploy.ts)
const VENUE_LAT = 37_774_900; // SF
const VENUE_LON = -122_419_400;
const DROP_LAT = 37_784_900;
const DROP_LON = -122_419_400;

// Poseidon(latEnc, lonEnc, salt) — must match circuits/proximity.circom + web/src/zk.ts.
function poseidonDropCommit(latMicro: number, lonMicro: number, salt: bigint): string {
  const latEnc = BigInt(latMicro) + 90_000_000n;
  const lonEnc = BigInt(lonMicro) + 180_000_000n;
  return "0x" + poseidon3([latEnc, lonEnc, salt]).toString(16).padStart(64, "0");
}

async function waitForNonce(provider: any, address: string, target: number, maxWait = 180) {
  for (let i = 0; i < maxWait; i++) {
    if ((await provider.getTransactionCount(address)) > target) return;
    if (i % 10 === 0 && i > 0) console.log(`    …waiting for confirmation (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce > ${target}`);
}

async function main() {
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Seeder:   ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(deployer.address))} PAS\n`);

  const book = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployed-addresses.json"), "utf-8"));
  const venues = await ethers.getContractAt("FareVenues", book.venues, deployer);
  const orders = await ethers.getContractAt("FareOrders", book.orders, deployer);

  async function send(label: string, fn: () => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn();
    await waitForNonce(provider, deployer.address, nonce);
    console.log(`  ~ ${label}`);
  }

  console.log("1. Venues");
  const seededVenues = [
    { pin: [VENUE_LAT, VENUE_LON], name: "golden-gate-grill" },
    { pin: [37_795_300, -122_403_700], name: "embarcadero-eats" },
  ];
  const before = Number(await venues.nextVenueId());
  for (const v of seededVenues) {
    await send(`registerVenue(${v.name})`, () =>
      venues.registerVenue(v.pin[0], v.pin[1], deployer.address, deployer.address, `demo://${v.name}`, { gasLimit: GAS })
    );
  }
  const firstVenueId = BigInt(before);

  console.log("\n2. One open order (for drivers to see + bid)");
  const salt = BigInt(ethers.hexlify(ethers.randomBytes(16)));
  const commit = poseidonDropCommit(DROP_LAT, DROP_LON, salt);
  const orderValue = ethers.parseEther("1");
  const tip = ethers.parseEther("0.1");
  const maxFare = ethers.parseEther("0.5");
  await send("createOrder", () =>
    orders.createOrder(firstVenueId, commit, orderValue, tip, maxFare, 0, 0, {
      value: orderValue + tip,
      gasLimit: GAS,
    })
  );
  const orderId = (await orders.nextOrderId()) - 1n;

  console.log(`\nSeeded ${seededVenues.length} venues (ids ${firstVenueId}…${Number(await venues.nextVenueId()) - 1}) and open order #${orderId}.`);
  console.log("Customers can now order from a venue; drivers can register (in-app) and bid on the open order.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
