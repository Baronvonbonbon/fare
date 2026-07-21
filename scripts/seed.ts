// seed.ts — demo data for a local node: one venue, two staked drivers,
// and one open order with bids, ready for the web demo to pick up.
//
// Usage: npx hardhat run scripts/seed.ts --network localhost
import { ethers, network } from "hardhat";
import { poseidon3 } from "poseidon-lite";
import * as fs from "fs";
import * as path from "path";

// Poseidon drop commitment — MUST match circuits/proximity.circom and
// web/src/zk.ts: offset-encode coordinates to stay non-negative in the field,
// then Poseidon(latEnc, lonEnc, salt). A keccak commit here would create an
// order that confirmDropoffZK can never settle.
function poseidonDropCommit(latMicro: number, lonMicro: number, salt: bigint): string {
  const latEnc = BigInt(latMicro) + 90_000_000n;
  const lonEnc = BigInt(lonMicro) + 180_000_000n;
  return "0x" + poseidon3([latEnc, lonEnc, salt]).toString(16).padStart(64, "0");
}

const VENUE_LAT = 37_774_900; // SF: 37.7749 N
const VENUE_LON = -122_419_400; // 122.4194 W
const DROP_LAT = 37_784_900;
const DROP_LON = -122_419_400;

async function main() {
  // pine = Paseo via local light client; shares the canonical address book.
  const suffix = ["polkadotTestnet", "pine"].includes(network.name) ? "" : `.${network.name}`;
  const file = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf-8"));

  const [deployer, customer, driver1, driver2, venueOp] = await ethers.getSigners();
  const drivers = await ethers.getContractAt("FareDrivers", book.drivers);
  const venues = await ethers.getContractAt("FareVenues", book.venues);
  const orders = await ethers.getContractAt("FareOrders", book.orders);

  console.log("Registering venue (Golden Gate Grill)...");
  await (
    await venues
      .connect(venueOp)
      .registerVenue(VENUE_LAT, VENUE_LON, venueOp.address, venueOp.address, "demo://golden-gate-grill")
  ).wait();
  const venueId = (await venues.nextVenueId()) - 1n;

  console.log("Registering drivers...");
  await (await drivers.connect(driver1).register("demo://driver-dana", { value: ethers.parseEther("1") })).wait();
  await (await drivers.connect(driver2).register("demo://driver-devon", { value: ethers.parseEther("1") })).wait();

  console.log("Creating demo order...");
  const salt = BigInt(ethers.hexlify(ethers.randomBytes(16)));
  const commit = poseidonDropCommit(DROP_LAT, DROP_LON, salt);
  await (
    await orders.connect(customer).createOrder(
      venueId,
      commit,
      ethers.parseEther("1"), // orderValue
      ethers.parseEther("0.1"), // tip
      ethers.parseEther("0.5"), // maxFare
      0,
      0,
      { value: ethers.parseEther("1.1") }
    )
  ).wait();
  const orderId = (await orders.nextOrderId()) - 1n;

  console.log("Placing bids...");
  await (await orders.connect(driver1).placeBid(orderId, ethers.parseEther("0.45"))).wait();
  await (await orders.connect(driver2).placeBid(orderId, ethers.parseEther("0.4"))).wait();

  console.log(`\nSeeded: venue #${venueId}, order #${orderId} with 2 bids.`);
  console.log(`Drop location salt (customer keeps this secret until dropoff): ${salt}`);
  console.log(`Accounts: customer=${customer.address} driver1=${driver1.address} driver2=${driver2.address} venue=${venueOp.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
