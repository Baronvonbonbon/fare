import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — no types
import * as snarkjs from "snarkjs";
import { poseidon2, poseidon3 } from "poseidon-lite";

// A delivery that settles with no GPS fix anywhere (docs/POLKADOT-PLATFORM-PLAN.md
// §4.10; web/src/handoff.ts).
//
// The claim under test is that FareSettlement and proximity.circom need no change
// for a runtime that gives no location — the Polkadot app's Android WebView,
// products-devnet-issues#7:
//
//   pickup   driver and venue both sign the venue's REGISTERED pin
//   dropoff  the customer commits to its own drop under a fresh salt; the driver
//            signs that commitment blind; the customer proves with driver
//            position = drop, against the real verifier
//
// And that the guarantees which were never GPS still hold: the venue's signature
// is still required at pickup, and a driver signature over some other commitment
// still cannot release the fare.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const rand = () => ethers.toBigInt(ethers.randomBytes(31));
const encLat = (l: number) => BigInt(l) + 90_000_000n;
const encLon = (l: number) => BigInt(l) + 180_000_000n;
const positionCommit = (lat: number, lon: number, salt: bigint) => poseidon3([encLat(lat), encLon(lon), salt]);

const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const ORDER_VALUE = PAS(1);
const FARE = PAS(2);
const RADIUS = 100;
const Status = { Assigned: 2, PickedUp: 3, Delivered: 4 } as const;

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

async function prove(orderId: bigint, dropCommit: string, dropSalt: bigint, driverPos: { lat: number; lon: number }, drvSalt: bigint) {
  const driverCommit = b32(positionCommit(driverPos.lat, driverPos.lon, drvSalt));
  const nullifier = b32(poseidon2([dropSalt, orderId]));
  const zk = await snarkjs.groth16.fullProve(
    {
      orderId: orderId.toString(),
      dropCommit: BigInt(dropCommit).toString(),
      driverCommit: BigInt(driverCommit).toString(),
      radiusMeters: String(RADIUS),
      nullifier: BigInt(nullifier).toString(),
      custLatEnc: encLat(DROP.lat).toString(),
      custLonEnc: encLon(DROP.lon).toString(),
      salt: dropSalt.toString(),
      drvLatEnc: encLat(driverPos.lat).toString(),
      drvLonEnc: encLon(driverPos.lon).toString(),
      drvSalt: drvSalt.toString(),
    },
    join(__dirname, "..", "web", "public", "zk", "proximity.wasm"),
    join(__dirname, "..", "web", "public", "zk", "proximity.zkey")
  );
  const proof = ethers.solidityPacked(Array(8).fill("uint256"), [
    zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
    zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1],
  ]);
  const pub = [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), String(RADIUS), BigInt(nullifier).toString()];
  return { proof, pub, driverCommit };
}

describe("settlement with no GPS fix (handoff.ts)", function () {
  this.timeout(240_000);

  let orders: any, settlement: any, venues: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, driver: HardhatEthersSigner,
      venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner, stranger: HardhatEthersSigner;
  let customer: ethers.Wallet;
  let domain: any;
  let dropSalt: bigint, dropCommit: string;
  const orderId = 1n;

  before(async () => {
    [deployer, treasury, driver, venueOp, venueSigner, stranger] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const verifier = await (await ethers.getContractFactory("FareLocationVerifier")).deploy();
    const vk = JSON.parse(readFileSync(join(__dirname, "fixtures", "zk-proximity.json"), "utf8")).vkCalldata;
    await verifier.setVerifyingKey(vk.alpha1, vk.beta2, vk.gamma2, vk.delta2, vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5);

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    await drivers.connect(driver).register("ipfs://driver", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://venue");
    domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: settlement.target as string };

    customer = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
    await deployer.sendTransaction({ to: customer.address, value: PAS(10) });
    dropSalt = rand();
    dropCommit = b32(positionCommit(DROP.lat, DROP.lon, dropSalt));
    await orders.connect(customer).createOrder(1n, dropCommit, ORDER_VALUE, 0, FARE, 0, 0, { value: ORDER_VALUE });

    const salt = ethers.keccak256(ethers.toUtf8Bytes("gps-free-bid"));
    const bidHash = await orders.bidHashOf(orderId, driver.address, FARE, salt);
    await orders.connect(deployer).commitBid(orderId, bidHash, ethers.keccak256(ethers.toUtf8Bytes("revoke")));
    await orders.connect(customer).acceptSealedBid(orderId, driver.address, FARE, salt, { value: FARE });
    expect(await orders.statusOf(orderId)).to.equal(Status.Assigned);
  });

  it("pickup: a driver attestation on the venue pin still needs the venue's signature", async () => {
    // The pin comes off the chain, as the app reads it (FareVenues.locationOf).
    const [pinLat, pinLon] = await venues.locationOf(1n);
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: driver.address, lat: pinLat, lon: pinLon, timestamp: now };
    const dSig = await driver.signTypedData(domain, LOCATION_TYPES, dAtt);

    // Without the venue, a pin attestation is worth nothing: a stranger's
    // signature over the same pin is refused.
    const fake = { ...dAtt, actor: stranger.address };
    await expect(
      settlement.confirmPickup(dAtt, dSig, fake, await stranger.signTypedData(domain, LOCATION_TYPES, fake))
    ).to.be.revertedWith("bad-venue-att");
  });

  it("pickup: driver and venue both on the pin settles", async () => {
    const [pinLat, pinLon] = await venues.locationOf(1n);
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: driver.address, lat: pinLat, lon: pinLon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat: pinLat, lon: pinLon, timestamp: now };
    await settlement.confirmPickup(
      dAtt, await driver.signTypedData(domain, LOCATION_TYPES, dAtt),
      vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt)
    );
    expect(await orders.statusOf(orderId)).to.equal(Status.PickedUp);
  });

  it("dropoff: a driver signature over some other commitment cannot release the fare", async () => {
    // The customer's request commits to the drop under salt A; the driver signed
    // a commitment under salt B (a stale code, say). The proof opens A.
    const { proof, pub } = await prove(orderId, dropCommit, dropSalt, DROP, rand());
    const otherCommit = b32(positionCommit(DROP.lat, DROP.lon, rand()));
    const now = await time.latest();
    const att = { orderId, phase: 2, actor: driver.address, posCommit: otherCommit, timestamp: now };
    await expect(
      settlement.confirmDropoffZK(att, await driver.signTypedData(domain, DRIVER_COMMIT_TYPES, att), proof, pub)
    ).to.be.revertedWith("driver-commit-mismatch");
  });

  it("dropoff: the customer-built commitment, signed blind by the driver, proves and settles", async () => {
    // Customer: commitment to its own drop under a fresh salt — the only thing
    // the request QR carries (makeDropoffRequest).
    const reqSalt = rand();
    const { proof, pub, driverCommit } = await prove(orderId, dropCommit, dropSalt, DROP, reqSalt);

    // Driver: signs the commitment it was shown (signDropoffRequest). It never
    // held a coordinate.
    const now = await time.latest();
    const att = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: now };
    const sig = await driver.signTypedData(domain, DRIVER_COMMIT_TYPES, att);

    const tx = await settlement.confirmDropoffZK(att, sig, proof, pub);
    const rc = await tx.wait();
    expect(await orders.statusOf(orderId)).to.equal(Status.Delivered);

    // Same privacy as the GPS path: no drop coordinate or salt on chain.
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    expect(blob).to.not.include(encLat(DROP.lat).toString(16));
    expect(blob).to.not.include(encLon(DROP.lon).toString(16));
    expect(blob).to.not.include(dropSalt.toString(16));
  });
});
