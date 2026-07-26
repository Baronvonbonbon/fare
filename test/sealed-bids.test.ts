import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Sealed bids (privacy phase 4).
//
// `BidPlaced` publishes (order, driver, amount) for every bid, including losses.
// Drivers are persistent identities, so that is a standing record of where each
// driver was willing to work and for how much — assembled about people who never
// won the job. A sealed bid puts only a hash on-chain; the terms reach the
// customer off-chain and are revealed on accept.

const VENUE_LAT = 37_774_900;
const VENUE_LON = -122_419_400;
const PAS = (n: string) => ethers.parseEther(n);

describe("sealed bids (privacy phase 4)", () => {
  async function fixture() {
    const [owner, customer, driver1, driver2, driver3, venueOp, treasury, relay] = await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    for (const d of [driver1, driver2, driver3]) await drivers.connect(d).register("demo://d");
    await venues.connect(venueOp).registerVenue(VENUE_LAT, VENUE_LON, venueOp.address, venueOp.address, "demo://v");

    const dropCommit = ethers.keccak256(ethers.toUtf8Bytes("drop"));
    await orders.connect(customer).createOrder(1, dropCommit, PAS("1"), 0, PAS("2"), 3600, 3600, {
      value: PAS("1"),
    });
    return { orders, drivers, vault, owner, customer, driver1, driver2, driver3, relay, orderId: 1n };
  }

  const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const revokeSecret = (s: string) => ethers.keccak256(ethers.toUtf8Bytes("revoke:" + s));
  const revokeHash = (s: string) =>
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [revokeSecret(s)]));

  /// A driver bids: the relay submits the hash, so the chain never sees who.
  async function commit(f: any, driver: any, amount: bigint, tag: string) {
    const hash = await f.orders.bidHashOf(f.orderId, driver.address, amount, salt(tag));
    const tx = await f.orders.connect(f.relay).commitBid(f.orderId, hash, revokeHash(tag));
    return { hash, tx, amount, salt: salt(tag) };
  }

  it("a committed bid names neither the driver nor the amount", async () => {
    // This is the entire point: the losing bids must not be attributable.
    const f = await loadFixture(fixture);
    const amount = PAS("0.7");
    const bid = await commit(f, f.driver1, amount, "a");
    const rec = await bid.tx.wait();

    const blob = (bid.tx.data + rec!.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    expect(blob, "commit leaked the driver").to.not.include(f.driver1.address.slice(2).toLowerCase());
    expect(blob, "commit leaked the amount").to.not.include(amount.toString(16));

    await expect(bid.tx).to.emit(f.orders, "BidCommitted").withArgs(f.orderId, bid.hash);
    expect(await f.orders.sealedBidCount(f.orderId)).to.equal(1);
  });

  it("the customer accepts a revealed bid and the order assigns normally", async () => {
    const f = await loadFixture(fixture);
    const amount = PAS("0.7");
    const bid = await commit(f, f.driver1, amount, "a");

    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, amount, bid.salt, { value: amount })
    ).to.emit(f.orders, "OrderAssigned").withArgs(f.orderId, f.driver1.address, amount, anyUint());

    const o = await f.orders.orders(f.orderId);
    expect(o.driver).to.equal(f.driver1.address);
    expect(o.fare).to.equal(amount);
    expect(o.status).to.equal(2); // Assigned
  });

  it("losing bids stay unattributable after the winner is revealed", async () => {
    // Revealing the winner must not reveal anyone else — the losers' hashes are
    // preimage-hidden and nothing on-chain ties them to an address.
    const f = await loadFixture(fixture);
    const win = await commit(f, f.driver1, PAS("0.7"), "a");
    const lose1 = await commit(f, f.driver2, PAS("0.9"), "b");
    const lose2 = await commit(f, f.driver3, PAS("1.1"), "c");

    await f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, PAS("0.7"), win.salt, {
      value: PAS("0.7"),
    });

    for (const [tag, loser, amt] of [["b", f.driver2, PAS("0.9")], ["c", f.driver3, PAS("1.1")]] as const) {
      // The commitment is on-chain, but only someone who already knows the
      // (driver, amount, salt) triple can confirm whose it is.
      const guess = await f.orders.bidHashOf(f.orderId, loser.address, amt, salt(tag));
      expect((await f.orders.sealedBid(f.orderId, guess)).exists).to.equal(true);
      const wrongSalt = await f.orders.bidHashOf(f.orderId, loser.address, amt, salt("wrong"));
      expect((await f.orders.sealedBid(f.orderId, wrongSalt)).exists).to.equal(false);
    }
    expect(lose1.hash).to.not.equal(lose2.hash);
  });

  it("cannot accept at a price the driver never bid", async () => {
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");
    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, PAS("0.3"), bid.salt, {
        value: PAS("0.3"),
      })
    ).to.be.revertedWith("no-bid");
  });

  it("cannot attribute a bid to a driver who never made it", async () => {
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");
    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver2.address, PAS("0.7"), bid.salt, {
        value: PAS("0.7"),
      })
    ).to.be.revertedWith("no-bid");
  });

  it("enforces maxFare and eligibility at reveal, since they can't be checked at commit", async () => {
    const f = await loadFixture(fixture);
    const over = PAS("3"); // maxFare is 2
    const bid = await commit(f, f.driver1, over, "a");
    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, over, bid.salt, { value: over })
    ).to.be.revertedWith("bad-amount");

    // An unregistered address can have a hash committed for it, but never assigned.
    const stranger = (await ethers.getSigners())[9];
    const sb = await commit(f, stranger, PAS("0.5"), "x");
    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, stranger.address, PAS("0.5"), sb.salt, {
        value: PAS("0.5"),
      })
    ).to.be.revertedWith("driver-not-eligible");
  });

  it("only the customer can accept", async () => {
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");
    await expect(
      f.orders.connect(f.driver2).acceptSealedBid(f.orderId, f.driver1.address, PAS("0.7"), bid.salt, {
        value: PAS("0.7"),
      })
    ).to.be.revertedWith("not-customer");
  });

  it("a bidder can retract with the revoke secret, and nobody else can", async () => {
    // Bid hashes are public, so revocation must take a secret — a signature
    // would put the bidder's address on-chain and undo the point.
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");

    await expect(
      f.orders.connect(f.driver2).revokeBid(f.orderId, bid.hash, salt("guess"))
    ).to.be.revertedWith("bad-secret");

    await expect(f.orders.connect(f.relay).revokeBid(f.orderId, bid.hash, revokeSecret("a")))
      .to.emit(f.orders, "BidRevoked").withArgs(f.orderId, bid.hash);

    await expect(
      f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, PAS("0.7"), bid.salt, {
        value: PAS("0.7"),
      })
    ).to.be.revertedWith("bid-revoked");
  });

  it("rejects duplicate and zero commitments, and caps them per order", async () => {
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");
    await expect(
      f.orders.connect(f.relay).commitBid(f.orderId, bid.hash, revokeHash("a"))
    ).to.be.revertedWith("already-committed");
    await expect(
      f.orders.connect(f.relay).commitBid(f.orderId, ethers.ZeroHash, revokeHash("z"))
    ).to.be.revertedWith("zero-hash");
    expect(await f.orders.MAX_SEALED_BIDS()).to.equal(256);
  });

  it("cannot commit once the order is no longer open", async () => {
    const f = await loadFixture(fixture);
    const bid = await commit(f, f.driver1, PAS("0.7"), "a");
    await f.orders.connect(f.customer).acceptSealedBid(f.orderId, f.driver1.address, PAS("0.7"), bid.salt, {
      value: PAS("0.7"),
    });
    const late = await f.orders.bidHashOf(f.orderId, f.driver2.address, PAS("0.8"), salt("late"));
    await expect(
      f.orders.connect(f.relay).commitBid(f.orderId, late, revokeHash("late"))
    ).to.be.revertedWith("bad-status");
  });

  it("leaves the open-bid path working, so the change is additive", async () => {
    const f = await loadFixture(fixture);
    await f.orders.connect(f.driver1).placeBid(f.orderId, PAS("0.6"));
    await f.orders.connect(f.customer).acceptBid(f.orderId, f.driver1.address, { value: PAS("0.6") });
    expect((await f.orders.orders(f.orderId)).status).to.equal(2);
  });
});

// Deadline is computed from block time; match any value.
function anyUint() {
  return (v: bigint) => typeof v === "bigint" && v > 0n;
}
