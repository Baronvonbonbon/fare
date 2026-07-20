import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ---- coordinate fixtures (San Francisco) ----
const VENUE_LAT = 37_774_900; // 37.7749° N in microdegrees
const VENUE_LON = -122_419_400; // 122.4194° W
const NEAR_VENUE = { lat: VENUE_LAT + 400, lon: VENUE_LON }; // ~44 m north
const FAR_FROM_VENUE = { lat: VENUE_LAT + 3_000, lon: VENUE_LON }; // ~334 m north
const DROP_LAT = 37_784_900; // ~1.1 km north of venue
const DROP_LON = -122_419_400;
const NEAR_DROP = { lat: DROP_LAT + 300, lon: DROP_LON }; // ~33 m
const DROP_SALT = 12345678901234567890n;

const ONE = ethers.parseEther("1");
const ORDER_VALUE = ethers.parseEther("1");
const TIP = ethers.parseEther("0.1");
const MAX_FARE = ethers.parseEther("0.5");

const abi = ethers.AbiCoder.defaultAbiCoder();

function dropCommit(lat: number, lon: number, salt: bigint): string {
  return ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [lat, lon, salt]));
}

describe("FARE protocol", () => {
  async function deployAll() {
    const [deployer, treasury, customer, driver1, driver2, venueOp, venueSigner, stranger] =
      await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);

    // wiring
    await orders.configure(
      vault.target,
      drivers.target,
      venues.target,
      settlement.target,
      disputes.target,
      treasury.address
    );
    await settlement.configure(orders.target, venues.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await drivers.setAuthorized(orders.target, true);
    await drivers.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);

    // participants
    await drivers.connect(driver1).register("ipfs://driver1", { value: ONE });
    await drivers.connect(driver2).register("ipfs://driver2", { value: ONE });
    await venues
      .connect(venueOp)
      .registerVenue(VENUE_LAT, VENUE_LON, venueSigner.address, venueOp.address, "ipfs://venue1");
    const venueId = 1n;

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "FareSettlement",
      version: "1",
      chainId,
      verifyingContract: settlement.target as string,
    };

    return {
      deployer, treasury, customer, driver1, driver2, venueOp, venueSigner, stranger,
      pause, vault, drivers, venues, orders, settlement, disputes,
      venueId, domain,
    };
  }

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
  const REVEAL_TYPES = {
    DropoffReveal: [
      { name: "orderId", type: "uint256" },
      { name: "lat", type: "int32" },
      { name: "lon", type: "int32" },
      { name: "salt", type: "uint256" },
      { name: "timestamp", type: "uint64" },
    ],
  };

  async function signLocation(
    signer: HardhatEthersSigner,
    domain: any,
    att: { orderId: bigint; phase: number; actor: string; lat: number; lon: number; timestamp: number }
  ) {
    return signer.signTypedData(domain, LOCATION_TYPES, att);
  }

  async function signReveal(
    signer: HardhatEthersSigner,
    domain: any,
    reveal: { orderId: bigint; lat: number; lon: number; salt: bigint; timestamp: number }
  ) {
    return signer.signTypedData(domain, REVEAL_TYPES, reveal);
  }

  /// Create a standard order, run the auction, return assigned orderId.
  async function createAndAssign(f: Awaited<ReturnType<typeof deployAll>>) {
    const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
    await f.orders
      .connect(f.customer)
      .createOrder(f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, {
        value: ORDER_VALUE + TIP,
      });
    const orderId = 1n;
    await f.orders.connect(f.driver1).placeBid(orderId, ethers.parseEther("0.45"));
    await f.orders.connect(f.driver2).placeBid(orderId, ethers.parseEther("0.4"));
    const fare = ethers.parseEther("0.4");
    await f.orders.connect(f.customer).acceptBid(orderId, f.driver2.address, { value: fare });
    return { orderId, fare };
  }

  async function confirmPickupOk(
    f: Awaited<ReturnType<typeof deployAll>>,
    orderId: bigint,
    driver: HardhatEthersSigner
  ) {
    const now = await time.latest();
    const dAtt = {
      orderId, phase: 1, actor: driver.address,
      lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: now,
    };
    const vAtt = {
      orderId, phase: 1, actor: f.venueSigner.address,
      lat: VENUE_LAT, lon: VENUE_LON, timestamp: now,
    };
    const dSig = await signLocation(driver, f.domain, dAtt);
    const vSig = await signLocation(f.venueSigner, f.domain, vAtt);
    return f.settlement.confirmPickup(dAtt, dSig, vAtt, vSig);
  }

  async function confirmDropoffOk(
    f: Awaited<ReturnType<typeof deployAll>>,
    orderId: bigint,
    driver: HardhatEthersSigner
  ) {
    const now = await time.latest();
    const dAtt = {
      orderId, phase: 2, actor: driver.address,
      lat: NEAR_DROP.lat, lon: NEAR_DROP.lon, timestamp: now,
    };
    const reveal = { orderId, lat: DROP_LAT, lon: DROP_LON, salt: DROP_SALT, timestamp: now };
    const dSig = await signLocation(driver, f.domain, dAtt);
    const cSig = await signReveal(f.customer, f.domain, reveal);
    return f.settlement.confirmDropoff(dAtt, dSig, reveal, cSig);
  }

  // ---------------------------------------------------------------

  describe("registries", () => {
    it("registers drivers with optional stake and tracks eligibility", async () => {
      const f = await loadFixture(deployAll);
      // zero-stake registration is allowed while minStake = 0
      await f.drivers.connect(f.stranger).register("ipfs://s");
      expect(await f.drivers.isEligible(f.stranger.address)).to.equal(true);

      // raising the floor de-qualifies zero-stake drivers, not staked ones
      await f.drivers.setMinStake(ethers.parseEther("0.5"));
      expect(await f.drivers.isEligible(f.stranger.address)).to.equal(false);
      expect(await f.drivers.isEligible(f.driver1.address)).to.equal(true);
    });

    it("unstake flow: request → ineligible → withdraw after delay", async () => {
      const f = await loadFixture(deployAll);
      await f.drivers.connect(f.driver1).requestUnstake();
      expect(await f.drivers.isEligible(f.driver1.address)).to.equal(false);
      await expect(f.drivers.connect(f.driver1).withdrawStake()).to.be.revertedWith("unbonding");
      await time.increase(3 * 24 * 3600 + 1);
      await expect(f.drivers.connect(f.driver1).withdrawStake()).to.changeEtherBalance(
        f.driver1,
        ONE
      );
    });

    it("registers venues with signer/payout defaults and operator controls", async () => {
      const f = await loadFixture(deployAll);
      expect(await f.venues.signerOf(f.venueId)).to.equal(f.venueSigner.address);
      expect(await f.venues.payoutOf(f.venueId)).to.equal(f.venueOp.address);
      await expect(
        f.venues.connect(f.stranger).setActive(f.venueId, false)
      ).to.be.revertedWith("not-operator");
      await f.venues.connect(f.venueOp).setActive(f.venueId, false);
      expect(await f.venues.isActive(f.venueId)).to.equal(false);
    });
  });

  describe("orders & auction", () => {
    it("full happy path: create → bid → accept → pickup → dropoff → withdraw", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);

      expect(await f.orders.statusOf(orderId)).to.equal(2n); // Assigned

      await expect(confirmPickupOk(f, orderId, f.driver2)).to.emit(f.settlement, "PickupConfirmed");
      expect(await f.orders.statusOf(orderId)).to.equal(3n); // PickedUp
      // venue got its order value in the vault
      expect(await f.vault.balanceOf(f.venueOp.address)).to.equal(ORDER_VALUE);

      await expect(confirmDropoffOk(f, orderId, f.driver2)).to.emit(
        f.settlement,
        "DropoffConfirmed"
      );
      expect(await f.orders.statusOf(orderId)).to.equal(4n); // Delivered

      const fee = (fare * 250n) / 10_000n;
      expect(await f.vault.balanceOf(f.driver2.address)).to.equal(fare - fee + TIP);
      expect(await f.vault.balanceOf(f.treasury.address)).to.equal(fee);

      // pull payments
      await expect(f.vault.connect(f.driver2).withdraw()).to.changeEtherBalance(
        f.driver2,
        fare - fee + TIP
      );
      await expect(f.vault.connect(f.venueOp).withdraw()).to.changeEtherBalance(
        f.venueOp,
        ORDER_VALUE
      );

      // reputation
      const [delivered] = await f.drivers.reputationOf(f.driver2.address);
      expect(delivered).to.equal(1);
      const venue = await f.venues.venues(f.venueId);
      expect(venue.pickups).to.equal(1);
    });

    it("fare-only order (orderValue = 0, tip = 0) settles cleanly", async () => {
      const f = await loadFixture(deployAll);
      const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
      await f.orders
        .connect(f.customer)
        .createOrder(f.venueId, commit, 0, 0, MAX_FARE, 0, 0, { value: 0 });
      const orderId = 1n;
      const fare = ethers.parseEther("0.3");
      await f.orders.connect(f.driver1).placeBid(orderId, fare);
      await f.orders.connect(f.customer).acceptBid(orderId, f.driver1.address, { value: fare });

      await confirmPickupOk(f, orderId, f.driver1);
      expect(await f.vault.balanceOf(f.venueOp.address)).to.equal(0n); // nothing to release
      await confirmDropoffOk(f, orderId, f.driver1);

      const fee = (fare * 250n) / 10_000n;
      expect(await f.vault.balanceOf(f.driver1.address)).to.equal(fare - fee);
    });

    it("auction rules: eligibility, max fare, exact escrow, rebids", async () => {
      const f = await loadFixture(deployAll);
      const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
      await f.orders
        .connect(f.customer)
        .createOrder(f.venueId, commit, 0, 0, MAX_FARE, 0, 0, { value: 0 });
      const orderId = 1n;

      await expect(
        f.orders.connect(f.stranger).placeBid(orderId, ethers.parseEther("0.1"))
      ).to.be.revertedWith("driver-not-eligible");
      await expect(
        f.orders.connect(f.driver1).placeBid(orderId, MAX_FARE + 1n)
      ).to.be.revertedWith("bad-amount");

      // rebid replaces, doesn't duplicate the bidder list
      await f.orders.connect(f.driver1).placeBid(orderId, ethers.parseEther("0.45"));
      await f.orders.connect(f.driver1).placeBid(orderId, ethers.parseEther("0.42"));
      expect((await f.orders.biddersOf(orderId)).length).to.equal(1);

      // exact fare escrow required
      await expect(
        f.orders
          .connect(f.customer)
          .acceptBid(orderId, f.driver1.address, { value: ethers.parseEther("0.41") })
      ).to.be.revertedWith("bad-value");
      // only the customer picks
      await expect(
        f.orders
          .connect(f.stranger)
          .acceptBid(orderId, f.driver1.address, { value: ethers.parseEther("0.42") })
      ).to.be.revertedWith("not-customer");

      // withdrawn bid can't be accepted
      await f.orders.connect(f.driver1).withdrawBid(orderId);
      await expect(
        f.orders
          .connect(f.customer)
          .acceptBid(orderId, f.driver1.address, { value: ethers.parseEther("0.42") })
      ).to.be.revertedWith("no-bid");
    });

    it("tips can be increased until dropoff", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);
      await f.orders.connect(f.customer).increaseTip(orderId, { value: ethers.parseEther("0.05") });
      await confirmPickupOk(f, orderId, f.driver2);
      await f.orders.connect(f.customer).increaseTip(orderId, { value: ethers.parseEther("0.05") });
      await confirmDropoffOk(f, orderId, f.driver2);
      const fee = (fare * 250n) / 10_000n;
      expect(await f.vault.balanceOf(f.driver2.address)).to.equal(
        fare - fee + TIP + ethers.parseEther("0.1")
      );
    });
  });

  describe("cancellations", () => {
    it("cancelOpen refunds the full escrow", async () => {
      const f = await loadFixture(deployAll);
      const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
      await f.orders
        .connect(f.customer)
        .createOrder(f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, {
          value: ORDER_VALUE + TIP,
        });
      await f.orders.connect(f.customer).cancelOpen(1n);
      expect(await f.vault.balanceOf(f.customer.address)).to.equal(ORDER_VALUE + TIP);
      expect(await f.orders.statusOf(1n)).to.equal(5n); // Cancelled
    });

    it("customer cancel after assignment compensates the driver", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);
      await f.orders.connect(f.customer).cancelAssigned(orderId);
      const comp = (fare * 2000n) / 10_000n; // 20%
      expect(await f.vault.balanceOf(f.driver2.address)).to.equal(comp);
      expect(await f.vault.balanceOf(f.customer.address)).to.equal(
        ORDER_VALUE + TIP + fare - comp
      );
    });

    it("driver no-show: full refund + reputation strike", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);
      await time.increase(46 * 60); // past the 45-min pickup window
      await f.orders.connect(f.customer).cancelAssigned(orderId);
      expect(await f.vault.balanceOf(f.customer.address)).to.equal(ORDER_VALUE + TIP + fare);
      expect(await f.vault.balanceOf(f.driver2.address)).to.equal(0n);
      const [, failed] = await f.drivers.reputationOf(f.driver2.address);
      expect(failed).to.equal(1);
    });

    it("driver abandon: full refund + strike", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);
      await f.orders.connect(f.driver2).abandonOrder(orderId);
      expect(await f.vault.balanceOf(f.customer.address)).to.equal(ORDER_VALUE + TIP + fare);
      const [, failed] = await f.drivers.reputationOf(f.driver2.address);
      expect(failed).to.equal(1);
    });
  });

  describe("settlement attestations", () => {
    it("rejects a signature from the wrong key", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      const now = await time.latest();
      const dAtt = {
        orderId, phase: 1, actor: f.driver2.address,
        lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: now,
      };
      const vAtt = {
        orderId, phase: 1, actor: f.venueSigner.address,
        lat: VENUE_LAT, lon: VENUE_LON, timestamp: now,
      };
      const forged = await signLocation(f.stranger, f.domain, dAtt); // stranger signs driver's att
      const vSig = await signLocation(f.venueSigner, f.domain, vAtt);
      await expect(f.settlement.confirmPickup(dAtt, forged, vAtt, vSig)).to.be.revertedWith(
        "bad-signature"
      );
    });

    it("rejects out-of-range driver coordinates", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      const now = await time.latest();
      const dAtt = {
        orderId, phase: 1, actor: f.driver2.address,
        lat: FAR_FROM_VENUE.lat, lon: FAR_FROM_VENUE.lon, timestamp: now,
      };
      const vAtt = {
        orderId, phase: 1, actor: f.venueSigner.address,
        lat: VENUE_LAT, lon: VENUE_LON, timestamp: now,
      };
      const dSig = await signLocation(f.driver2, f.domain, dAtt);
      const vSig = await signLocation(f.venueSigner, f.domain, vAtt);
      await expect(f.settlement.confirmPickup(dAtt, dSig, vAtt, vSig)).to.be.revertedWith(
        "driver-out-of-range"
      );
    });

    it("rejects stale attestations", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      const stale = (await time.latest()) - 16 * 60; // older than 15-min window
      const dAtt = {
        orderId, phase: 1, actor: f.driver2.address,
        lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: stale,
      };
      const vAtt = {
        orderId, phase: 1, actor: f.venueSigner.address,
        lat: VENUE_LAT, lon: VENUE_LON, timestamp: await time.latest(),
      };
      const dSig = await signLocation(f.driver2, f.domain, dAtt);
      const vSig = await signLocation(f.venueSigner, f.domain, vAtt);
      await expect(f.settlement.confirmPickup(dAtt, dSig, vAtt, vSig)).to.be.revertedWith(
        "attestation-stale"
      );
    });

    it("rejects a phase-2 attestation replayed into pickup", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      const now = await time.latest();
      const dAtt = {
        orderId, phase: 2, actor: f.driver2.address,
        lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: now,
      };
      const vAtt = {
        orderId, phase: 1, actor: f.venueSigner.address,
        lat: VENUE_LAT, lon: VENUE_LON, timestamp: now,
      };
      const dSig = await signLocation(f.driver2, f.domain, dAtt);
      const vSig = await signLocation(f.venueSigner, f.domain, vAtt);
      await expect(f.settlement.confirmPickup(dAtt, dSig, vAtt, vSig)).to.be.revertedWith(
        "bad-driver-att"
      );
    });

    it("rejects a dropoff reveal that doesn't match the commitment", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      await confirmPickupOk(f, orderId, f.driver2);
      const now = await time.latest();
      const dAtt = {
        orderId, phase: 2, actor: f.driver2.address,
        lat: NEAR_DROP.lat, lon: NEAR_DROP.lon, timestamp: now,
      };
      const badReveal = { orderId, lat: DROP_LAT, lon: DROP_LON, salt: 999n, timestamp: now };
      const dSig = await signLocation(f.driver2, f.domain, dAtt);
      const cSig = await signReveal(f.customer, f.domain, badReveal);
      await expect(
        f.settlement.confirmDropoff(dAtt, dSig, badReveal, cSig)
      ).to.be.revertedWith("commit-mismatch");
    });

    it("cannot confirm pickup twice (status gate = replay protection)", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      await confirmPickupOk(f, orderId, f.driver2);
      await expect(confirmPickupOk(f, orderId, f.driver2)).to.be.revertedWith("bad-status");
    });

    it("dropoff requires the driver near the REVEALED drop point", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      await confirmPickupOk(f, orderId, f.driver2);
      const now = await time.latest();
      // driver still at the venue (~1.1 km from the drop)
      const dAtt = {
        orderId, phase: 2, actor: f.driver2.address,
        lat: NEAR_VENUE.lat, lon: NEAR_VENUE.lon, timestamp: now,
      };
      const reveal = { orderId, lat: DROP_LAT, lon: DROP_LON, salt: DROP_SALT, timestamp: now };
      const dSig = await signLocation(f.driver2, f.domain, dAtt);
      const cSig = await signReveal(f.customer, f.domain, reveal);
      await expect(f.settlement.confirmDropoff(dAtt, dSig, reveal, cSig)).to.be.revertedWith(
        "driver-out-of-range"
      );
    });
  });

  describe("disputes", () => {
    it("customer opens a dispute, arbiter splits escrow and slashes", async () => {
      const f = await loadFixture(deployAll);
      const { orderId, fare } = await createAndAssign(f);
      await confirmPickupOk(f, orderId, f.driver2);

      await f.disputes.setDisputeBond(ethers.parseEther("0.01"));
      await f.disputes
        .connect(f.customer)
        .openDispute(orderId, "ipfs://evidence", { value: ethers.parseEther("0.01") });
      expect(await f.orders.statusOf(orderId)).to.equal(6n); // Disputed

      // frozen: settlement can't complete a disputed order
      await expect(confirmDropoffOk(f, orderId, f.driver2)).to.be.revertedWith("bad-status");

      // ruling: customer gets 100% of remaining escrow (fare + tip),
      // driver at fault, slash 0.5 from stake to the customer as damages
      const slash = ethers.parseEther("0.5");
      await expect(
        f.disputes.resolve(1n, 10_000, true, true, slash)
      ).to.changeEtherBalance(f.customer, slash); // slash pays direct from stake

      expect(await f.orders.statusOf(orderId)).to.equal(7n); // Resolved
      expect(await f.vault.balanceOf(f.customer.address)).to.equal(
        fare + TIP + ethers.parseEther("0.01") // escrow share + refunded bond
      );
      const [, failed] = await f.drivers.reputationOf(f.driver2.address);
      expect(failed).to.equal(1);
      const d = await f.drivers.drivers(f.driver2.address);
      expect(d.stake).to.equal(ONE - slash);
    });

    it("only order parties can open; arbiter-only resolution; no double dispute", async () => {
      const f = await loadFixture(deployAll);
      const { orderId } = await createAndAssign(f);
      await expect(
        f.disputes.connect(f.stranger).openDispute(orderId, "")
      ).to.be.revertedWith("not-party");
      await f.disputes.connect(f.driver2).openDispute(orderId, "ipfs://x");
      await expect(
        f.disputes.connect(f.customer).openDispute(orderId, "")
      ).to.be.revertedWith("already-disputed");
      await expect(
        f.disputes.connect(f.stranger).resolve(1n, 5_000, true, false, 0)
      ).to.be.revertedWith("not-arbiter");
      // 50/50 split ruling
      await f.disputes.resolve(1n, 5_000, false, false, 0);
      expect(await f.vault.balanceOf(f.customer.address)).to.be.greaterThan(0n);
      expect(await f.vault.balanceOf(f.driver2.address)).to.be.greaterThan(0n);
    });
  });

  describe("vault & safety", () => {
    it("rejects unauthorized credits and empty withdrawals", async () => {
      const f = await loadFixture(deployAll);
      await expect(
        f.vault.connect(f.stranger).credit(f.stranger.address, { value: 1_000_000n })
      ).to.be.revertedWith("not-authorized");
      await expect(f.vault.connect(f.stranger).withdraw()).to.be.revertedWith("zero-balance");
    });

    it("pause blocks new orders and bids but never blocks exits", async () => {
      const f = await loadFixture(deployAll);
      const commit = dropCommit(DROP_LAT, DROP_LON, DROP_SALT);
      await f.orders
        .connect(f.customer)
        .createOrder(f.venueId, commit, 0, 0, MAX_FARE, 0, 0, { value: 0 });

      await f.pause.pause(0); // CAT_ORDERS
      await expect(
        f.orders
          .connect(f.customer)
          .createOrder(f.venueId, commit, 0, 0, MAX_FARE, 0, 0, { value: 0 })
      ).to.be.revertedWith("paused");
      await expect(
        f.orders.connect(f.driver1).placeBid(1n, ethers.parseEther("0.1"))
      ).to.be.revertedWith("paused");
      // exit path stays open under pause
      await f.orders.connect(f.customer).cancelOpen(1n);
      expect(await f.orders.statusOf(1n)).to.equal(5n); // Cancelled
    });

    it("guardian can pause, only owner unpauses", async () => {
      const f = await loadFixture(deployAll);
      await f.pause.setGuardian(f.stranger.address, true);
      await f.pause.connect(f.stranger).pause(1);
      expect(await f.pause.isPaused(1)).to.equal(true);
      await expect(f.pause.connect(f.stranger).unpause(1)).to.be.revertedWithCustomError(
        f.pause,
        "OwnableUnauthorizedAccount"
      );
      await f.pause.unpause(1);
      expect(await f.pause.isPaused(1)).to.equal(false);
    });

    it("PaseoSafeSender queues dust for amounts the Paseo gateway rejects", async () => {
      const f = await loadFixture(deployAll);
      // driver3 stakes an amount whose trailing 10^6 is in the rejected band
      const dirty = 2_600_000n; // % 1e6 = 600_000 >= 500_000 → 600_000 dust
      await f.drivers.connect(f.stranger).register("ipfs://d3", { value: dirty });
      await f.drivers.connect(f.stranger).requestUnstake();
      await time.increase(3 * 24 * 3600 + 1);
      await expect(f.drivers.connect(f.stranger).withdrawStake()).to.changeEtherBalance(
        f.stranger,
        2_000_000n // clean part sent, dust queued
      );
      expect(await f.drivers.pendingPaseoDust(f.stranger.address)).to.equal(600_000n);

      // accumulate more dust; once the pool has a sendable prefix, claim works
      await f.drivers.connect(f.stranger).addStake({ value: dirty });
      await f.drivers.connect(f.stranger).requestUnstake();
      await time.increase(3 * 24 * 3600 + 1);
      await f.drivers.connect(f.stranger).withdrawStake();
      expect(await f.drivers.pendingPaseoDust(f.stranger.address)).to.equal(1_200_000n);
      // 1_200_000 % 1e6 = 200_000 < 500_000 → the whole pool is now sendable
      await expect(f.drivers.connect(f.stranger).claimPaseoDust()).to.changeEtherBalance(
        f.stranger,
        1_200_000n
      );
      expect(await f.drivers.pendingPaseoDust(f.stranger.address)).to.equal(0n);
    });
  });

  // Localization filters on the PUBLIC venue pin; a driver's own position is
  // signed live at attestation time and must never be persisted on-chain.
  // This invariant guards that: no location-shaped field may enter the driver
  // registry's ABI (struct getter, function params, or event topics).
  describe("privacy invariant: driver location stays off-chain", () => {
    it("exposes no location-shaped field in the FareDrivers ABI", async () => {
      const { drivers } = await loadFixture(deployAll);
      const locationLike = /(^|[^a-z])(lat|lon|latitude|longitude|location|geohash|coord|position|geo)([^a-z]|$)/i;
      for (const frag of drivers.interface.fragments) {
        const f = frag as any;
        const names: string[] = [];
        if (f.name) names.push(f.name);
        for (const io of [...(f.inputs ?? []), ...(f.outputs ?? [])]) if (io?.name) names.push(io.name);
        for (const n of names) {
          expect(locationLike.test(n), `FareDrivers ABI leaks a location-shaped field: "${n}"`).to.equal(false);
        }
      }
    });
  });
});
