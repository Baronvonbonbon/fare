import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Differential half of TEST-PLAN C5 for the governance, pause and upgrade
// consoles: the client-side gate against the contracts it duplicates.
//
// Each console disables Save rather than letting an operator broadcast a
// transaction that will revert. That is good UX and a second copy of every
// bound — so the two can drift, silently, in either direction:
//
//   console stricter than chain → a legitimate setting becomes unreachable
//   console looser than chain   → the operator gets a revert instead of a warning
//
// So every boundary is probed on BOTH sides and the verdicts compared. The
// shipped modules are imported, never reimplemented.
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const opsPath = (f: string) => pathToFileURL(join(__dirname, "..", "web", "src", "ops", f)).href;

const PAS = (n: string | number) => ethers.parseEther(String(n));

describe("ops consoles: client-side gates match the chain", () => {
  let gov: any, upgrade: any;

  before(async () => {
    gov = await esmImport(opsPath("govparams.ts"));
    upgrade = await esmImport(opsPath("upgrade.ts"));
  });

  async function deploy() {
    const [owner, guardian, treasury, stranger] = await ethers.getSigners();
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const ratings = await (await ethers.getContractFactory("FareRatings")).deploy(forwarder.target);
    const router = await (await ethers.getContractFactory("FareGovernanceRouter")).deploy();
    await settlement.configure(orders.target, venues.target);
    return { owner, guardian, treasury, stranger, pause, vault, drivers, venues, orders, settlement, disputes, ratings, router };
  }

  /// Did the chain accept it? Boolean, not a throw, so it can be compared to a
  /// predicate's verdict directly.
  const chainAccepts = async (send: () => Promise<any>) =>
    send().then(() => true, () => false);

  // ── FareOrders.setParams ──────────────────────────────────────────────────

  it("order-param bounds agree with setParams at every boundary", async () => {
    const f = await deploy();
    const OK = { fee: 250, cancel: 2_500, pickup: 3_600, delivery: 3_600 };

    const cases = [
      { ...OK },
      { ...OK, fee: 0 },
      { ...OK, fee: 1_000 },            // exactly the cap
      { ...OK, fee: 1_001 },            // one over
      { ...OK, cancel: 5_000 },
      { ...OK, cancel: 5_001 },
      { ...OK, pickup: 600 },           // MIN_WINDOW
      { ...OK, pickup: 599 },
      { ...OK, pickup: 86_400 },        // MAX_WINDOW
      { ...OK, pickup: 86_401 },
      { ...OK, delivery: 599 },
      { ...OK, delivery: 86_401 },
      { ...OK, pickup: 0 },             // what a blank field used to produce
    ];

    for (const c of cases) {
      const consoleSays = gov.orderParamsValid(c.fee, c.cancel, c.pickup, c.delivery);
      const chainSays = await chainAccepts(() =>
        f.orders.setParams(c.fee, c.cancel, c.pickup, c.delivery));
      expect(consoleSays, `setParams(${c.fee}, ${c.cancel}, ${c.pickup}, ${c.delivery})`)
        .to.equal(chainSays);
    }
  });

  // ── FareSettlement.setGeoParams ───────────────────────────────────────────

  it("geo bounds agree with setGeoParams at every boundary", async () => {
    const f = await deploy();
    const OK = { pr: 100, dr: 100, age: 300, skew: 60 };

    const cases = [
      { ...OK },
      { ...OK, pr: 25 }, { ...OK, pr: 24 },
      { ...OK, pr: 2_000 }, { ...OK, pr: 2_001 },
      { ...OK, dr: 25 }, { ...OK, dr: 24 },
      { ...OK, dr: 2_000 }, { ...OK, dr: 2_001 },
      { ...OK, age: 60 }, { ...OK, age: 59 },
      { ...OK, age: 7_200 }, { ...OK, age: 7_201 },
      { ...OK, skew: 0 }, { ...OK, skew: 1_800 }, { ...OK, skew: 1_801 },
    ];

    for (const c of cases) {
      const consoleSays = gov.geoParamsValid(c.pr, c.dr, c.age, c.skew);
      const chainSays = await chainAccepts(() =>
        f.settlement.setGeoParams(c.pr, c.dr, c.age, c.skew));
      expect(consoleSays, `setGeoParams(${c.pr}, ${c.dr}, ${c.age}, ${c.skew})`)
        .to.equal(chainSays);
    }
  });

  // ── the blank-field defect, end to end ────────────────────────────────────

  it("a cleared field can no longer set a parameter to zero", async () => {
    // The bug this closed: `Number("")` is 0, so clearing feeBps and pressing
    // Save wrote a real 0 — and 0 is a VALID fee, so the chain accepted it
    // without complaint. The console now refuses to parse it at all.
    const f = await deploy();
    const before = await f.orders.feeBps();

    expect(gov.toInt("")).to.be.NaN;
    expect(gov.feeBpsValid(gov.toInt(""))).to.equal(false);

    // The chain would have taken it — which is exactly why the client-side
    // check has to be the thing that stops it.
    await f.orders.setParams(0, 2_500, 3_600, 3_600);
    expect(await f.orders.feeBps()).to.equal(0);
    expect(before).to.not.equal(0); // the default was non-zero, so this was a real change
  });

  // ── FarePauseRegistry authority ───────────────────────────────────────────

  it("the pause console's authority model matches the registry", async () => {
    // The console enables Pause for `isOwner || guardian`, but Unpause and
    // setGuardian for the owner alone — guardians can stop the bleeding, not
    // resume. Confirm the chain agrees on all three.
    const f = await deploy();
    await f.pause.setGuardian(f.guardian.address, true);

    expect(await f.pause.isGuardian(f.guardian.address)).to.equal(true);
    expect(await f.pause.isGuardian(f.stranger.address)).to.equal(false);

    // guardian may pause…
    expect(await chainAccepts(() => f.pause.connect(f.guardian).pause(0))).to.equal(true);
    expect(await f.pause.isPaused(0)).to.equal(true);
    // …but not unpause
    expect(await chainAccepts(() => f.pause.connect(f.guardian).unpause(0))).to.equal(false);
    expect(await f.pause.isPaused(0)).to.equal(true);
    // owner may
    expect(await chainAccepts(() => f.pause.unpause(0))).to.equal(true);
    expect(await f.pause.isPaused(0)).to.equal(false);

    // a stranger may do neither
    expect(await chainAccepts(() => f.pause.connect(f.stranger).pause(0))).to.equal(false);
    expect(await chainAccepts(() => f.pause.connect(f.stranger).setGuardian(f.stranger.address, true))).to.equal(false);

    // the console lists exactly the categories the registry accepts
    expect(await chainAccepts(() => f.pause.pause(3))).to.equal(true);
    expect(await chainAccepts(() => f.pause.pause(4))).to.equal(false); // bad-category
  });

  // ── FareGovernanceRouter addressing ───────────────────────────────────────

  it("the console's router keys address the entries the deploy path registers", async () => {
    // A name that drifts between console and deploy script does not error — it
    // silently addresses a different registry slot, so a promotion appears to
    // succeed while re-pointing nothing.
    const f = await deploy();
    const deployed: Record<string, string> = {
      orders: f.orders.target as string,
      settlement: f.settlement.target as string,
      disputes: f.disputes.target as string,
      drivers: f.drivers.target as string,
      venues: f.venues.target as string,
      vault: f.vault.target as string,
      ratings: f.ratings.target as string,
      pauseRegistry: f.pause.target as string,
    };

    // Register exactly as scripts/deploy.ts does: encodeBytes32String(name).
    for (const [name, addr] of Object.entries(deployed)) {
      await f.router.register(ethers.encodeBytes32String(name), addr);
    }

    // The console must resolve every one of them, and its list must be complete.
    expect(upgrade.REGISTERED.map((r: any) => r.name).sort()).to.deep.equal(Object.keys(deployed).sort());
    for (const { name } of upgrade.REGISTERED) {
      const resolved = await f.router.currentAddrOf(upgrade.routerKey(name));
      expect(resolved, `console key for "${name}" resolves nowhere`).to.equal(deployed[name]);
      expect(resolved).to.not.equal(ethers.ZeroAddress);
    }
  });

  it("upgradeContract is offered only where the router accepts it", async () => {
    // pauseRegistry is not FareUpgradable, so upgradeContract() on it reverts —
    // the console offers register() instead, and this pins that distinction to
    // the chain's actual behaviour rather than to a comment.
    const f = await deploy();
    for (const [name, addr] of [["orders", f.orders.target], ["pauseRegistry", f.pause.target]] as const) {
      await f.router.register(ethers.encodeBytes32String(name), addr);
    }
    const successor = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();

    const flagFor = (n: string) => upgrade.REGISTERED.find((r: any) => r.name === n)!.upgradable;

    // orders: flagged upgradable, and the router accepts the promotion.
    //
    // The successor needs setRouter() first — `migrate(old)` is router-gated,
    // so promoting a v2 that was never pointed at this router reverts. The
    // console does not do that step (it belongs to the deploy), which is worth
    // knowing: forgetting it produces a revert at Promote, not a warning.
    expect(flagFor("orders")).to.equal(true);
    const ordersV2 = await (await ethers.getContractFactory("FareOrders"))
      .deploy(f.pause.target, ethers.ZeroAddress);
    await ordersV2.setRouter(f.router.target);
    expect(await chainAccepts(() =>
      f.router.upgradeContract(upgrade.routerKey("orders"), ordersV2.target, false))).to.equal(true);

    // pauseRegistry: flagged not-upgradable, and the router refuses
    expect(flagFor("pauseRegistry")).to.equal(false);
    expect(await chainAccepts(() =>
      f.router.upgradeContract(upgrade.routerKey("pauseRegistry"), successor.target, false))).to.equal(false);
    // …while the re-point the console offers instead works
    expect(await chainAccepts(() =>
      f.router.register(upgrade.routerKey("pauseRegistry"), successor.target))).to.equal(true);
  });

  it("the console blocks a promotion the router would treat as a no-op", async () => {
    const f = await deploy();
    await f.router.register(ethers.encodeBytes32String("orders"), f.orders.target);
    const current = await f.router.currentAddrOf(upgrade.routerKey("orders"));

    // Re-registering the live address burns a version bump and, with freezeOld,
    // freezes the contract it just promoted. The console refuses.
    expect(upgrade.checkPromotion(current, current, true).canSubmit).to.equal(false);
    expect(upgrade.checkPromotion(current, current, true).sameAsCurrent).to.equal(true);
  });
});
