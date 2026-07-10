import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Freeze-and-drain upgrade layer: FareGovernanceRouter registry +
// FareUpgradable base. Invariants under test:
//   1. registry re-points and versions bump
//   2. frozen v1 blocks ENTRY mutators only
//   3. exits and in-flight completion keep working on a frozen v1 (drain)
//   4. record imports copy identity/reputation but never stake/escrow
//   5. only the router can freeze; only the owner drives the router

const VENUE_LAT = 37_774_900;
const VENUE_LON = -122_419_400;
const DROP_LAT = 37_784_900;
const DROP_LON = -122_419_400;
const SALT = 42n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const name = (s: string) => ethers.encodeBytes32String(s);

describe("Upgradability", () => {
  async function deployAll() {
    const [deployer, treasury, customer, driver1, venueOp] = await ethers.getSigners();

    const router = await (await ethers.getContractFactory("FareGovernanceRouter")).deploy();
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await drivers.setAuthorized(orders.target, true);
    await drivers.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);

    for (const [n, c] of [
      ["pauseRegistry", pause], ["vault", vault], ["drivers", drivers], ["venues", venues],
      ["orders", orders], ["settlement", settlement], ["disputes", disputes],
    ] as const) {
      await router.register(name(n), c.target);
    }
    for (const c of [vault, drivers, venues, orders, settlement, disputes]) {
      await (c as any).setRouter(router.target);
    }

    await drivers.connect(driver1).register("ipfs://d1", { value: ethers.parseEther("1") });
    await venues.connect(venueOp).registerVenue(VENUE_LAT, VENUE_LON, venueOp.address, venueOp.address, "ipfs://v1");

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: settlement.target as string };

    return { deployer, treasury, customer, driver1, venueOp, router, pause, vault, drivers, venues, orders, settlement, disputes, domain };
  }

  const LOCATION_TYPES = {
    LocationAttestation: [
      { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
      { name: "actor", type: "address" }, { name: "lat", type: "int32" },
      { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
    ],
  };
  const REVEAL_TYPES = {
    DropoffReveal: [
      { name: "orderId", type: "uint256" }, { name: "lat", type: "int32" },
      { name: "lon", type: "int32" }, { name: "salt", type: "uint256" },
      { name: "timestamp", type: "uint64" },
    ],
  };

  function dropCommit() {
    return ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT]));
  }

  async function createAssignedOrder(f: Awaited<ReturnType<typeof deployAll>>) {
    await f.orders.connect(f.customer).createOrder(1n, dropCommit(), 0, 0, ethers.parseEther("0.5"), 0, 0, { value: 0 });
    const orderId = (await f.orders.nextOrderId()) - 1n;
    const fare = ethers.parseEther("0.3");
    await f.orders.connect(f.driver1).placeBid(orderId, fare);
    await f.orders.connect(f.customer).acceptBid(orderId, f.driver1.address, { value: fare });
    return { orderId, fare };
  }

  it("registry: register + upgrade re-points, versions bump, history kept", async () => {
    const f = await loadFixture(deployAll);
    expect(await f.router.currentAddrOf(name("orders"))).to.equal(f.orders.target);
    expect(await f.router.versionOf(name("orders"))).to.equal(1n);

    const ordersV2 = await (await ethers.getContractFactory("FareOrders")).deploy(f.pause.target);
    await ordersV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("orders"), ordersV2.target, true);

    expect(await f.router.currentAddrOf(name("orders"))).to.equal(ordersV2.target);
    expect(await f.router.versionOf(name("orders"))).to.equal(2n);
    expect(await f.router.historyOf(name("orders"))).to.deep.equal([f.orders.target]);
    expect(await f.orders.frozen()).to.equal(true);
    expect(await ordersV2.frozen()).to.equal(false);
  });

  it("freeze-and-drain: frozen orders v1 blocks entries but in-flight orders settle and cancel", async () => {
    const f = await loadFixture(deployAll);
    const { orderId, fare } = await createAssignedOrder(f);
    // a second in-flight order to cancel under freeze
    await f.orders.connect(f.customer).createOrder(1n, dropCommit(), 0, 0, ethers.parseEther("0.5"), 0, 0, { value: 0 });
    const openId = (await f.orders.nextOrderId()) - 1n;

    const ordersV2 = await (await ethers.getContractFactory("FareOrders")).deploy(f.pause.target);
    await ordersV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("orders"), ordersV2.target, true);

    // entries blocked on v1
    await expect(
      f.orders.connect(f.customer).createOrder(1n, dropCommit(), 0, 0, 1n, 0, 0, { value: 0 })
    ).to.be.revertedWith("frozen");
    await expect(f.orders.connect(f.driver1).placeBid(openId, 1n)).to.be.revertedWith("frozen");

    // exits open on v1: cancel the open order
    await f.orders.connect(f.customer).cancelOpen(openId);
    expect(await f.orders.statusOf(openId)).to.equal(5n); // Cancelled

    // drain: the assigned order settles end-to-end on frozen v1
    // (settlement is still wired to v1 until the operator re-points it)
    const now = await time.latest();
    const dPick = { orderId, phase: 1, actor: f.driver1.address, lat: VENUE_LAT + 400, lon: VENUE_LON, timestamp: now };
    const vPick = { orderId, phase: 1, actor: f.venueOp.address, lat: VENUE_LAT, lon: VENUE_LON, timestamp: now };
    await f.settlement.confirmPickup(
      dPick, await f.driver1.signTypedData(f.domain, LOCATION_TYPES, dPick),
      vPick, await f.venueOp.signTypedData(f.domain, LOCATION_TYPES, vPick)
    );
    const now2 = await time.latest();
    const dDrop = { orderId, phase: 2, actor: f.driver1.address, lat: DROP_LAT + 300, lon: DROP_LON, timestamp: now2 };
    const reveal = { orderId, lat: DROP_LAT, lon: DROP_LON, salt: SALT, timestamp: now2 };
    await f.settlement.confirmDropoff(
      dDrop, await f.driver1.signTypedData(f.domain, LOCATION_TYPES, dDrop),
      reveal, await f.customer.signTypedData(f.domain, REVEAL_TYPES, reveal)
    );
    expect(await f.orders.statusOf(orderId)).to.equal(4n); // Delivered
    const fee = (fare * 250n) / 10_000n;
    expect(await f.vault.balanceOf(f.driver1.address)).to.equal(fare - fee);

    // and v2 accepts new orders once configured
    await ordersV2.configure(f.vault.target, f.drivers.target, f.venues.target, f.settlement.target, f.disputes.target, f.treasury.address);
    await f.vault.setAuthorized(ordersV2.target, true);
    await f.drivers.setAuthorized(ordersV2.target, true);
    await f.venues.setAuthorized(ordersV2.target, true);
    await ordersV2.connect(f.customer).createOrder(1n, dropCommit(), 0, 0, 1000000n, 0, 0, { value: 0 });
    expect(await ordersV2.nextOrderId()).to.equal(2n);
  });

  it("drivers upgrade: importRecords copies reputation, not stake; stake exits frozen v1", async () => {
    const f = await loadFixture(deployAll);
    // give driver1 some reputation
    const { orderId } = await createAssignedOrder(f);
    await f.orders.connect(f.driver1).abandonOrder(orderId); // failed++

    const driversV2 = await (await ethers.getContractFactory("FareDrivers")).deploy(f.pause.target);
    await driversV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("drivers"), driversV2.target, true);

    // registration blocked on frozen v1
    await expect(f.drivers.connect(f.treasury).register("x")).to.be.revertedWith("frozen");

    // records import to v2 (paginated batch)
    await driversV2.importRecords(f.drivers.target, [f.driver1.address]);
    const d = await driversV2.drivers(f.driver1.address);
    expect(d.registered).to.equal(true);
    expect(d.failed).to.equal(1);
    expect(d.stake).to.equal(0n); // stake intentionally not copied
    // idempotent / no clobber
    await driversV2.importRecords(f.drivers.target, [f.driver1.address]);
    expect((await driversV2.drivers(f.driver1.address)).failed).to.equal(1);

    // stake drains from frozen v1
    await f.drivers.connect(f.driver1).requestUnstake();
    await time.increase(3 * 24 * 3600 + 1);
    await expect(f.drivers.connect(f.driver1).withdrawStake()).to.changeEtherBalance(
      f.driver1,
      ethers.parseEther("1")
    );
  });

  it("venues upgrade: importVenues preserves IDs and operator custody", async () => {
    const f = await loadFixture(deployAll);
    const venuesV2 = await (await ethers.getContractFactory("FareVenues")).deploy(f.pause.target);
    await venuesV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("venues"), venuesV2.target, true);

    await expect(
      f.venues.connect(f.venueOp).registerVenue(0, 0, f.venueOp.address, f.venueOp.address, "x")
    ).to.be.revertedWith("frozen");

    await venuesV2.importVenues(f.venues.target, [1n]);
    const v = await venuesV2.venues(1n);
    expect(v.operator).to.equal(f.venueOp.address);
    expect(v.lat).to.equal(VENUE_LAT);
    expect(await venuesV2.nextVenueId()).to.equal(2n);
    // operator can immediately manage the imported venue
    await venuesV2.connect(f.venueOp).setActive(1n, false);
    expect(await venuesV2.isActive(1n)).to.equal(false);
  });

  it("rollback: router can unfreeze a demoted contract", async () => {
    const f = await loadFixture(deployAll);
    const ordersV2 = await (await ethers.getContractFactory("FareOrders")).deploy(f.pause.target);
    await ordersV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("orders"), ordersV2.target, true);
    expect(await f.orders.frozen()).to.equal(true);

    // v2 is bad: re-point back and unfreeze v1
    await f.router.register(name("orders"), f.orders.target);
    await f.router.setContractFrozen(name("orders"), f.orders.target, false);
    expect(await f.orders.frozen()).to.equal(false);
    await f.orders.connect(f.customer).createOrder(1n, dropCommit(), 0, 0, 1n, 0, 0, { value: 0 });
  });

  it("authorization: only router freezes, only owner drives router, setRouter is one-time", async () => {
    const f = await loadFixture(deployAll);
    await expect(f.orders.connect(f.deployer).setFrozen(true)).to.be.revertedWith("not-router");
    await expect(
      f.router.connect(f.customer).upgradeContract(name("orders"), f.vault.target, true)
    ).to.be.revertedWithCustomError(f.router, "OwnableUnauthorizedAccount");
    await expect(f.orders.setRouter(f.customer.address)).to.be.revertedWith("router-set");
    await expect(f.orders.migrate(f.vault.target)).to.be.revertedWith("not-router");
  });

  it("vault posture: upgrade with freezeOld=false leaves v1 fully live", async () => {
    const f = await loadFixture(deployAll);
    const { orderId } = await createAssignedOrder(f);
    await f.orders.connect(f.driver1).abandonOrder(orderId); // customer refund credited to v1 vault

    const vaultV2 = await (await ethers.getContractFactory("FareVault")).deploy();
    await vaultV2.setRouter(f.router.target);
    await f.router.upgradeContract(name("vault"), vaultV2.target, false);

    expect(await f.vault.frozen()).to.equal(false); // never frozen
    // old balances still withdrawable
    await expect(f.vault.connect(f.customer).withdraw()).to.changeEtherBalance(
      f.customer,
      ethers.parseEther("0.3")
    );
  });
});
