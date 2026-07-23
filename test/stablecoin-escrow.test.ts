import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// C3 — stablecoin (ERC-20) escrow rail. Mirrors the native happy path from
// fare.test.ts, but the order is escrowed and settled entirely in MockUSDC:
// createOrderERC20 → placeBid → acceptBidERC20 → pickup → dropoff, with every
// release (venue / driver / treasury) landing as a token balance in the vault.

// San Francisco coordinate fixtures (shared with fare.test.ts).
const VENUE_LAT = 37_774_900;
const VENUE_LON = -122_419_400;
const NEAR_VENUE = { lat: VENUE_LAT + 400, lon: VENUE_LON };
const DROP_LAT = 37_784_900;
const DROP_LON = -122_419_400;
const DROP_SALT = 12345678901234567890n;

// USDC has 6 decimals. Amounts chosen so payout math is exact.
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const ORDER_VALUE = USDC(10); // goods owed to venue
const TIP = USDC(1);
const MAX_FARE = USDC(5);
const FARE = USDC(4);
const MINT = USDC(1000);

const abi = ethers.AbiCoder.defaultAbiCoder();
const dropCommit = (lat: number, lon: number, salt: bigint) =>
  ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [lat, lon, salt]));
const driverCommit = (orderId: bigint) =>
  ethers.keccak256(abi.encode(["string", "uint256"], ["driver-pos", orderId]));
const nullifierOf = (orderId: bigint, salt: bigint) =>
  ethers.keccak256(abi.encode(["uint256", "uint256"], [salt, orderId]));

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "lat", type: "int32" },
    { name: "lon", type: "int32" },
    { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};
const DUMMY_PROOF = "0x" + "00".repeat(256); // MockLocationVerifier ignores proof bytes

describe("FARE — stablecoin escrow (C3)", () => {
  async function deployAll() {
    const [deployer, treasury, customer, driver1, driver2, venueOp, venueSigner, stranger] =
      await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await drivers.setAuthorized(orders.target, true);
    await drivers.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);

    // Accept the stablecoin + fund/approve the customer.
    await orders.setAcceptedToken(usdc.target, true);
    await usdc.mint(customer.address, MINT);
    await usdc.connect(customer).approve(orders.target, ethers.MaxUint256);

    await drivers.connect(driver1).register("ipfs://driver1", { value: ethers.parseEther("1") });
    await drivers.connect(driver2).register("ipfs://driver2", { value: ethers.parseEther("1") });
    await venues.connect(venueOp).registerVenue(VENUE_LAT, VENUE_LON, venueSigner.address, venueOp.address, "ipfs://venue1");
    const venueId = 1n;

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: settlement.target as string };

    return { deployer, treasury, customer, driver1, driver2, venueOp, venueSigner, stranger,
      pause, vault, drivers, venues, orders, settlement, disputes, verifier, usdc, forwarder, venueId, domain };
  }

  const signLoc = (signer: HardhatEthersSigner, domain: any, att: any) =>
    signer.signTypedData(domain, LOCATION_TYPES, att);
  const signCommit = (signer: HardhatEthersSigner, domain: any, att: any) =>
    signer.signTypedData(domain, DRIVER_COMMIT_TYPES, att);

  async function createTokenOrderAndAssign(f: Awaited<ReturnType<typeof deployAll>>) {
    const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
    await f.orders.connect(f.customer).createOrderERC20(f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0);
    const orderId = 1n;
    await f.orders.connect(f.driver2).placeBid(orderId, FARE);
    await f.orders.connect(f.customer).acceptBidERC20(orderId, f.driver2.address);
    return { orderId };
  }

  async function confirmPickup(f: Awaited<ReturnType<typeof deployAll>>, orderId: bigint, driver: HardhatEthersSigner) {
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: driver.address, lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: f.venueSigner.address, lat: VENUE_LAT, lon: VENUE_LON, timestamp: now };
    return f.settlement.confirmPickup(dAtt, await signLoc(driver, f.domain, dAtt), vAtt, await signLoc(f.venueSigner, f.domain, vAtt));
  }

  async function confirmDropoff(f: Awaited<ReturnType<typeof deployAll>>, orderId: bigint, driver: HardhatEthersSigner) {
    const now = await time.latest();
    const posCommit = driverCommit(orderId);
    const dAtt = { orderId, phase: 2, actor: driver.address, posCommit, timestamp: now };
    const radius = await f.settlement.dropoffRadiusMeters();
    const pubSignals = [orderId, BigInt(dropCommit(DROP_LAT, DROP_LON, DROP_SALT)), BigInt(posCommit), radius, BigInt(nullifierOf(orderId, DROP_SALT))];
    return f.settlement.confirmDropoffZK(dAtt, await signCommit(driver, f.domain, dAtt), DUMMY_PROOF, pubSignals);
  }

  it("full happy path: create → bid → accept → pickup → dropoff, all in USDC", async () => {
    const f = await loadFixture(deployAll);
    const { orderId } = await createTokenOrderAndAssign(f);

    // Escrow (orderValue + tip + fare) is held by the orders contract in USDC.
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(ORDER_VALUE + TIP + FARE);

    await confirmPickup(f, orderId, f.driver2);
    // Pickup releases the order value to the venue's payout (as a vault balance).
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.venueOp.address)).to.equal(ORDER_VALUE);

    await confirmDropoff(f, orderId, f.driver2);

    const fee = (FARE * 250n) / 10_000n;
    const toDriver = FARE - fee + TIP;
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.driver2.address)).to.equal(toDriver);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.treasury.address)).to.equal(fee);

    // Conservation: the orders contract holds nothing; the vault holds it all.
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(0n);
    expect(await f.usdc.balanceOf(f.vault.target)).to.equal(ORDER_VALUE + TIP + FARE);

    // Withdraw moves real tokens out of the vault to the recipient.
    const before = await f.usdc.balanceOf(f.driver2.address);
    await f.vault.connect(f.driver2).withdrawToken(f.usdc.target);
    expect(await f.usdc.balanceOf(f.driver2.address)).to.equal(before + toDriver);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.driver2.address)).to.equal(0n);
  });

  it("withdrawTokenTo sends to a cold wallet", async () => {
    const f = await loadFixture(deployAll);
    const { orderId } = await createTokenOrderAndAssign(f);
    await confirmPickup(f, orderId, f.driver2);
    const before = await f.usdc.balanceOf(f.stranger.address);
    await f.vault.connect(f.venueOp).withdrawTokenTo(f.usdc.target, f.stranger.address);
    expect(await f.usdc.balanceOf(f.stranger.address)).to.equal(before + ORDER_VALUE);
  });

  it("cancelOpen refunds the full token escrow to the customer", async () => {
    const f = await loadFixture(deployAll);
    const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
    await f.orders.connect(f.customer).createOrderERC20(f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0);
    await f.orders.connect(f.customer).cancelOpen(1n);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.customer.address)).to.equal(ORDER_VALUE + TIP);
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(0n);
  });

  it("cancelAssigned (pre-deadline) splits comp to driver, refund to customer — in token", async () => {
    const f = await loadFixture(deployAll);
    const { orderId } = await createTokenOrderAndAssign(f);
    await f.orders.connect(f.customer).cancelAssigned(orderId);
    const comp = (FARE * 2000n) / 10_000n; // assignedCancelBps default 20%
    const refund = ORDER_VALUE + TIP + FARE - comp;
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.driver2.address)).to.equal(comp);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.customer.address)).to.equal(refund);
  });

  it("increaseTipERC20 grows the escrow in the order's token", async () => {
    const f = await loadFixture(deployAll);
    const { orderId } = await createTokenOrderAndAssign(f);
    await f.orders.connect(f.customer).increaseTipERC20(orderId, TIP);
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(ORDER_VALUE + TIP + FARE + TIP);
  });

  it("rejects a non-accepted token", async () => {
    const f = await loadFixture(deployAll);
    const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await other.mint(f.customer.address, MINT);
    await other.connect(f.customer).approve(f.orders.target, ethers.MaxUint256);
    const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
    await expect(
      f.orders.connect(f.customer).createOrderERC20(other.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0)
    ).to.be.revertedWith("token-not-accepted");
  });

  it("enforces the native/token mode split on accept and tip", async () => {
    const f = await loadFixture(deployAll);
    const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
    await f.orders.connect(f.customer).createOrderERC20(f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0);
    await f.orders.connect(f.driver2).placeBid(1n, FARE);
    // Native accept on a token order is rejected.
    await expect(f.orders.connect(f.customer).acceptBid(1n, f.driver2.address, { value: FARE }))
      .to.be.revertedWith("use-erc20-accept");
    // Native tip on a token order is rejected.
    await expect(f.orders.connect(f.customer).increaseTip(1n, { value: 1n }))
      .to.be.revertedWith("use-erc20-tip");
    // Token accept on a NATIVE order is rejected.
    await f.orders.connect(f.customer).createOrder(f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, { value: ORDER_VALUE + TIP });
    await f.orders.connect(f.driver1).placeBid(2n, FARE);
    await expect(f.orders.connect(f.customer).acceptBidERC20(2n, f.driver1.address))
      .to.be.revertedWith("use-native-accept");
  });

  it("creditToken is authorized-only", async () => {
    const f = await loadFixture(deployAll);
    await expect(f.vault.connect(f.stranger).creditToken(f.usdc.target, f.stranger.address, 1n))
      .to.be.revertedWith("not-authorized");
  });
});
