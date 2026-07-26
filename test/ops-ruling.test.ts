import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The differential half of TEST-PLAN C5: the arbiter console's escrow-split
// PREVIEW against what FareOrders.resolveDisputed actually does.
//
// The preview has no authority — the contract does the real split. That is
// precisely why it has to agree to the wei. An arbiter shown "1.5 / 1.5" who
// actually causes something else has been misled by their own tool, and a
// ruling is not reversible.
//
// The real shipped module is imported rather than reimplemented; a copy of the
// formula here would only ever test itself.
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

const PAS = (n: string | number) => ethers.parseEther(String(n));
const abi = ethers.AbiCoder.defaultAbiCoder();
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const NEAR = { lat: 37_775_100, lon: -122_419_400 };
const DROP_SALT = 0x1234n;

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};

describe("arbiter console: the ruling preview matches the chain", () => {
  let splitEscrow: (e: bigint, bps: number) => { customerAmt: bigint; driverAmt: bigint };

  before(async () => {
    ({ splitEscrow } = await esmImport(
      pathToFileURL(join(__dirname, "..", "web", "src", "ops", "ruling.ts")).href
    ));
  });

  async function deployAll() {
    const [deployer, treasury, customer, driver, venueOp, venueSigner] = await ethers.getSigners();
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
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
    await drivers.connect(driver).register("ipfs://d", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://v");

    const domain = {
      name: "FareSettlement", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: settlement.target as string,
    };
    return { deployer, treasury, customer, driver, venueOp, venueSigner, vault, drivers, venues, orders, settlement, disputes, domain };
  }

  /// Drive an order to Disputed with a chosen escrow, then rule on it.
  /// Returns what the chain credited each side.
  async function ruleOn(f: any, orderValue: bigint, fare: bigint, bps: number, orderId: bigint) {
    const commit = ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [37_784_913, -122_431_777, DROP_SALT]));
    await f.orders.connect(f.customer).createOrder(1n, commit, orderValue, 0, fare, 0, 0, { value: orderValue });
    await f.orders.connect(f.driver).placeBid(orderId, fare);
    await f.orders.connect(f.customer).acceptBid(orderId, f.driver.address, { value: fare });

    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: f.driver.address, lat: NEAR.lat, lon: NEAR.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: f.venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    await f.settlement.confirmPickup(
      dAtt, await f.driver.signTypedData(f.domain, LOCATION_TYPES, dAtt),
      vAtt, await f.venueSigner.signTypedData(f.domain, LOCATION_TYPES, vAtt)
    );

    // The escrow the console would display, read the same way it reads it.
    const escrow: bigint = (await f.orders.orders(orderId)).escrow;
    await f.disputes.connect(f.customer).openDispute(orderId, "ipfs://e");

    const cBefore = await f.vault.balanceOf(f.customer.address);
    const dBefore = await f.vault.balanceOf(f.driver.address);
    // Dispute ids are sequential from 1 and this fixture opens one per order.
    await f.disputes.resolve(orderId, bps, false, false, 0);
    return {
      escrow,
      onChain: {
        customerAmt: (await f.vault.balanceOf(f.customer.address)) - cBefore,
        driverAmt: (await f.vault.balanceOf(f.driver.address)) - dBefore,
      },
    };
  }

  it("agrees with the chain across the ratios an arbiter actually picks", async () => {
    const f = await deployAll();
    // The escrows carry ODD WEI on purpose. A round PAS amount is divisible by
    // 10,000 many times over, so the split never truncates and every plausible
    // formula agrees — this test passed against a deliberately dust-losing
    // implementation until these remainders were added.
    const cases: [bigint, bigint, number][] = [
      [PAS(1) + 7n, PAS("0.7") + 3n, 5_000],
      [PAS(1) + 1n, PAS("0.7") + 2n, 3_333],
      [PAS(1) + 9n, PAS("0.7") + 4n, 6_667],
      [PAS("0.3") + 5n, PAS("0.11") + 1n, 2_500],
      [PAS(2) + 3n, PAS("1.9") + 6n, 9_999],
    ];
    let orderId = 1n;
    for (const [orderValue, fare, bps] of cases) {
      const { escrow, onChain } = await ruleOn(f, orderValue, fare, bps, orderId);
      const preview = splitEscrow(escrow, bps);
      expect(preview.customerAmt, `customer @ ${bps}bps on escrow ${escrow}`).to.equal(onChain.customerAmt);
      expect(preview.driverAmt, `driver @ ${bps}bps on escrow ${escrow}`).to.equal(onChain.driverAmt);
      expect(preview.customerAmt + preview.driverAmt).to.equal(escrow);
      orderId += 1n;
    }
  });

  it("agrees at the extremes, where one side gets nothing", async () => {
    const f = await deployAll();
    let orderId = 1n;
    for (const bps of [0, 10_000]) {
      const { escrow, onChain } = await ruleOn(f, PAS(1), PAS("0.7"), bps, orderId);
      expect(splitEscrow(escrow, bps)).to.deep.equal(onChain);
      orderId += 1n;
    }
  });

  it("the preview refuses exactly the share the contract refuses", async () => {
    const f = await deployAll();
    const commit = ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [37_784_913, -122_431_777, DROP_SALT]));
    await f.orders.connect(f.customer).createOrder(1n, commit, PAS(1), 0, PAS("0.7"), 0, 0, { value: PAS(1) });
    await f.orders.connect(f.driver).placeBid(1n, PAS("0.7"));
    await f.orders.connect(f.customer).acceptBid(1n, f.driver.address, { value: PAS("0.7") });
    await f.disputes.connect(f.customer).openDispute(1n, "ipfs://e");

    // Chain: bad-bps. Console: throws rather than rendering an impossible split.
    await expect(f.disputes.resolve(1n, 10_001, false, false, 0)).to.be.revertedWith("bad-bps");
    expect(() => splitEscrow(PAS(1), 10_001)).to.throw(/out of range/);
  });
});
