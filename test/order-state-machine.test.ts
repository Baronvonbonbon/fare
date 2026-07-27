import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The order state machine, exhaustively (TEST-PLAN D5).
//
// Every status-gated function in FareOrders, against every status an order can
// hold. The invariant campaign reaches some of these incidentally — it walks
// random operations and would eventually try a cancel on a delivered order —
// but "eventually, on some seeds" is not the same claim as "never, on any
// path". This is the explicit version: 13 actions × 8 statuses = **104 cells**,
// each one asserted.
//
// Two things make it worth more than its size suggests.
//
// **Every call is valid apart from its status.** The point of a cell is that
// the STATUS is what rejected it, so each action is invoked by the right caller
// with the right arguments and enough setup to reach the status check. A test
// that called `cancelAssigned` as a stranger would pass on `not-customer` and
// prove nothing about the state machine — the same failure mode that makes most
// such matrices decorative (and see §5 C3, which had to solve it for
// authorization).
//
// **The table is checked against the contract.** A new status-gated function,
// or a widened guard, breaks no other test in the repo: no other suite calls
// that function in that status. It breaks the completeness check here.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const b32 = (x: string) => ethers.keccak256(ethers.toUtf8Bytes(x));

/// IFare.Status, in order. `None` is 0 — an order id that was never created.
const STATUS = ["None", "Open", "Assigned", "PickedUp", "Delivered", "Cancelled", "Disputed", "Resolved"] as const;
type StatusName = (typeof STATUS)[number];

/// What the contracts say, transcribed from the `require(o.status == …)` guards.
/// This is the specification the cells are checked against.
const ACTIONS: {
  name: string;
  legal: StatusName[];
  /// Invoke it as the party who is allowed to, with arguments that would work.
  call: (c: Ctx) => Promise<any>;
  /// Drive a stablecoin order instead of a native one, when that is what makes
  /// the action's status guard reachable at all.
  token?: true;
  /// Statuses where a check EARLIER than the status guard legitimately fires
  /// first, and the reason it gives. Listed per cell rather than waved through
  /// by a permissive regex: the call must still be refused, and refused for
  /// this exact stated reason, so a guard that stopped firing would surface.
  earlierGuard?: Partial<Record<StatusName, RegExp>>;
}[] = [
  {
    name: "increaseTip",
    legal: ["Open", "Assigned", "PickedUp"],
    call: (c) => c.orders.connect(c.customer).increaseTip(c.id, { value: PAS("0.1") }),
  },
  {
    name: "increaseTipERC20",
    legal: ["Open", "Assigned", "PickedUp"],
    // Driven against a STABLECOIN order. On a native one `use-native-tip` is
    // checked before the status, so every cell in this row would be refused for
    // the wrong reason and the row would assert nothing about the state machine
    // — vacuous in the exact way TEST-FINDINGS #8–11 collects.
    token: true,
    call: (c) => c.orders.connect(c.customer).increaseTipERC20(c.id, 1n),
  },
  {
    name: "cancelOpen",
    legal: ["Open"],
    call: (c) => c.orders.connect(c.customer).cancelOpen(c.id),
  },
  {
    name: "cancelAssigned",
    legal: ["Assigned"],
    call: (c) => c.orders.connect(c.customer).cancelAssigned(c.id),
  },
  {
    name: "abandonOrder",
    legal: ["Assigned"],
    // In `Open` there is no driver yet, so the identity check fires before the
    // status one. That is not an evasion — it is the honest answer to "can a
    // driver abandon an unassigned order", and it is asserted as such.
    earlierGuard: { Open: /not-driver/ },
    call: (c) => c.orders.connect(c.driver).abandonOrder(c.id),
  },
  {
    name: "placeBid",
    legal: ["Open"],
    call: (c) => c.orders.connect(c.driver2).placeBid(c.id, PAS("1")),
  },
  {
    name: "commitBid",
    legal: ["Open"],
    // Deliberately callable by anyone — it is submitted by a relay so the
    // transaction does not name the bidder.
    call: (c) => c.orders.connect(c.relay).commitBid(c.id, b32("d5-bid-" + c.id), b32("d5-rev")),
  },
  {
    name: "acceptBid",
    legal: ["Open"],
    call: (c) => c.orders.connect(c.customer).acceptBid(c.id, c.driver.address, { value: PAS("1") }),
  },
  {
    name: "acceptSealedBid",
    legal: ["Open"],
    call: (c) =>
      c.orders.connect(c.customer).acceptSealedBid(c.id, c.driver.address, PAS("1"), b32("d5-salt"), { value: PAS("1") }),
  },
  {
    name: "onPickupConfirmed",
    legal: ["Assigned"],
    call: (c) => c.orders.connect(c.asSettlement).onPickupConfirmed(c.id),
  },
  {
    name: "onDropoffConfirmed",
    legal: ["PickedUp"],
    call: (c) => c.orders.connect(c.asSettlement).onDropoffConfirmed(c.id, c.relay.address),
  },
  {
    name: "markDisputed",
    legal: ["Assigned", "PickedUp"],
    call: (c) => c.orders.connect(c.asDisputes).markDisputed(c.id),
  },
  {
    name: "resolveDisputed",
    legal: ["Disputed"],
    call: (c) => c.orders.connect(c.asDisputes).resolveDisputed(c.id, 5_000),
  },
];

type Ctx = {
  orders: any; id: bigint;
  customer: any; driver: any; driver2: any; relay: any;
  asSettlement: any; asDisputes: any;
};

describe("order state machine: every action, every status", function () {
  this.timeout(180_000);

  async function fixture() {
    const [deployer, treasury, customer, driver, driver2, relay, venueOp, venueSigner] =
      await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);

    // The settlement and dispute hooks are `onlySettlement` / `onlyDisputes`,
    // so those roles are held by EOAs here. Configuring them as accounts rather
    // than impersonating contracts keeps every transition a plain call, and the
    // real contracts driving the same transitions are covered by fare.test.ts
    // and the D4 lifecycle.
    const settlementRole = deployer;
    const disputesRole = relay;
    await orders.configure(
      vault.target, drivers.target, venues.target,
      settlementRole.address, disputesRole.address, treasury.address
    );
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    for (const d of [driver, driver2]) await drivers.connect(d).register("ipfs://d", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(37_774_900, -122_419_400, venueSigner.address, venueOp.address, "ipfs://v");

    // A stablecoin, so the ERC20 tip guard is reachable (see increaseTipERC20).
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await orders.setAcceptedToken(usdc.target, true);
    await usdc.mint(customer.address, 1_000_000_000n);
    await usdc.connect(customer).approve(orders.target, ethers.MaxUint256);

    return { orders, vault, drivers, usdc, deployer, treasury, customer, driver, driver2, relay,
             settlementRole, disputesRole };
  }

  /// Create a fresh order and drive it to `target`. Returns its id.
  ///
  /// Each status is reached through the real transition that produces it, so a
  /// cell is testing the machine rather than a hand-written storage value.
  async function orderIn(f: any, target: StatusName, token = false): Promise<bigint> {
    if (target === "None") return 9_999n; // never created

    const FARE = token ? 1_000_000n : PAS("1");
    const tx = token
      ? await f.orders.connect(f.customer).createOrderERC20(
          f.usdc.target, 1n, b32("d5-drop"), 1_000_000n, 0, 2_000_000n, 0, 0)
      : await f.orders.connect(f.customer).createOrder(
          1n, b32("d5-drop"), PAS("1"), 0, PAS(2), 0, 0, { value: PAS("1") });
    const rc = await tx.wait();
    const id = BigInt(rc.logs.find((l: any) => l.fragment?.name === "OrderCreated")!.args[0]);
    if (target === "Open") return id;

    await f.orders.connect(f.driver).placeBid(id, FARE);
    if (token) await f.orders.connect(f.customer).acceptBidERC20(id, f.driver.address);
    else await f.orders.connect(f.customer).acceptBid(id, f.driver.address, { value: FARE });

    // Cancelled is reached from ASSIGNED, not from Open. Both produce the same
    // status, but cancelling an open order leaves no driver — and then
    // `abandonOrder` is refused on identity rather than on status, and that
    // cell silently stops testing the state machine. Which path reaches a
    // status can decide which guard answers.
    if (target === "Cancelled") {
      await f.orders.connect(f.customer).cancelAssigned(id);
      return id;
    }
    if (target === "Assigned") return id;

    if (target === "Disputed") {
      await f.orders.connect(f.disputesRole).markDisputed(id);
      return id;
    }
    if (target === "Resolved") {
      await f.orders.connect(f.disputesRole).markDisputed(id);
      await f.orders.connect(f.disputesRole).resolveDisputed(id, 5_000);
      return id;
    }

    await f.orders.connect(f.settlementRole).onPickupConfirmed(id);
    if (target === "PickedUp") return id;

    await f.orders.connect(f.settlementRole).onDropoffConfirmed(id, f.relay.address);
    if (target === "Delivered") return id;

    throw new Error(`unreachable status ${target}`);
  }

  const ctxFor = (f: any, id: bigint): Ctx => ({
    orders: f.orders, id,
    customer: f.customer, driver: f.driver, driver2: f.driver2, relay: f.relay,
    asSettlement: f.settlementRole, asDisputes: f.disputesRole,
  });

  /// Decode the revert reason, falling back to the raw message. Several of these
  /// come back as plain `Error(string)`, but a call that reverts for an
  /// unexpected reason must be distinguishable from one that was rejected on
  /// status — otherwise every cell "passes".
  async function reasonOf(p: Promise<any>): Promise<string | null> {
    try {
      await p;
      return null; // did not revert
    } catch (e: any) {
      return String(e?.reason ?? e?.shortMessage ?? e?.message ?? e);
    }
  }

  // ── reachability ──────────────────────────────────────────────────────────

  it("every status in the enum is reachable through real transitions", async () => {
    // If a status cannot be reached, its whole row below is vacuous — so this
    // has to be established before anything trusts the matrix.
    const f = await loadFixture(fixture);
    for (const s of STATUS) {
      const id = await orderIn(f, s);
      const got = s === "None" ? 0 : Number(await f.orders.statusOf(id));
      expect(STATUS[got], `drove an order to ${s} but it reports ${STATUS[got]}`).to.equal(s);
    }
  });

  // ── the matrix ────────────────────────────────────────────────────────────

  it("no action succeeds from a status that does not permit it", async () => {
    const f = await loadFixture(fixture);
    const failures: string[] = [];
    let illegal = 0;

    for (const status of STATUS) {
      for (const action of ACTIONS) {
        if (action.legal.includes(status)) continue;
        illegal++;

        const id = await orderIn(f, status, action.token);
        const reason = await reasonOf(action.call(ctxFor(f, id)));

        if (reason === null) {
          failures.push(`${action.name} SUCCEEDED from ${status}`);
          continue;
        }
        // `None` is the one status where an earlier guard legitimately fires
        // first: the order does not exist, so `o.customer` is the zero address
        // and the identity check rejects before the status is ever read. That
        // is still a refusal, and it is asserted as one rather than waved past.
        const expected =
          action.earlierGuard?.[status] ??
          // `None` is the one status where an earlier guard fires for a uniform
          // reason across the whole column: the order does not exist, so
          // `o.customer` and `o.driver` are the zero address and the identity
          // check rejects before the status is ever read.
          (status === "None" ? /bad-status|not-customer|not-driver/ : /bad-status/);
        if (!expected.test(reason)) {
          failures.push(`${action.name} from ${status}: rejected on "${reason}", expected ${expected}`);
        }
      }
    }

    // Derived, not hardcoded: the guard against a shrinking matrix is that the
    // two halves still tile the whole grid.
    const legalCells = ACTIONS.reduce((n, a) => n + a.legal.length, 0);
    expect(illegal).to.equal(ACTIONS.length * STATUS.length - legalCells);
    expect(illegal, "suspiciously few illegal cells — did an action lose its guard?").to.equal(86);
    expect(failures, `\n  ${failures.join("\n  ")}\n`).to.have.length(0);
  });

  it("every action is permitted from each status it declares legal", async () => {
    // The other half, and the reason the matrix cannot be satisfied by a
    // contract that simply reverts everything: a legal cell must NOT be
    // rejected on status. It may still revert for a different reason —
    // `acceptBid` with no bid placed, `increaseTipERC20` on a native order —
    // and those are other suites' questions.
    const f = await loadFixture(fixture);
    const failures: string[] = [];
    let legal = 0;

    for (const status of STATUS) {
      for (const action of ACTIONS) {
        if (!action.legal.includes(status)) continue;
        legal++;

        const id = await orderIn(f, status, action.token);
        const reason = await reasonOf(action.call(ctxFor(f, id)));
        if (reason !== null && /bad-status/.test(reason)) {
          failures.push(`${action.name} was rejected on status from ${status}, which it declares legal`);
        }
      }
    }

    expect(legal).to.equal(ACTIONS.reduce((n, a) => n + a.legal.length, 0));
    expect(legal).to.equal(18);
    expect(failures, `\n  ${failures.join("\n  ")}\n`).to.have.length(0);
  });

  // ── the table cannot fall behind the contract ─────────────────────────────

  it("the table covers every status guard in FareOrders", async () => {
    // A new status-gated function, or a widened guard, breaks no other test in
    // this repo — no other suite calls that function in that status. It breaks
    // this. Compare the SOURCE, not the ABI: the guard is what defines the
    // machine, and a function can be added without changing any signature the
    // table happens to name.
    const src = readFileSync(join(__dirname, "..", "contracts", "FareOrders.sol"), "utf8");

    // Each `bad-status` require, with the function it sits in.
    const guarded = new Set<string>();
    let current = "";
    for (const line of src.split("\n")) {
      const fn = line.match(/^\s*function\s+([A-Za-z0-9_]+)\s*\(/);
      if (fn) current = fn[1];
      if (/"bad-status"/.test(line) && current) guarded.add(current);
    }
    expect(guarded.size, "found no bad-status guards — did the regex go stale?").to.be.greaterThan(0);

    // The two internal helpers are reached through their public wrappers, which
    // is how the table names them.
    const viaWrapper: Record<string, string[]> = {
      _prepareAccept: ["acceptBid"],
      _prepareSealedAccept: ["acceptSealedBid"],
    };
    const covered = new Set(ACTIONS.map((a) => a.name));
    const missing: string[] = [];
    for (const fn of guarded) {
      const names = viaWrapper[fn] ?? [fn];
      if (!names.some((n) => covered.has(n))) missing.push(fn);
    }

    expect(missing, `status-gated but absent from the matrix: ${missing.join(", ")}`).to.have.length(0);
  });

  it("the legal sets match the guards the contract actually writes", async () => {
    // Not just "the function appears" but "it permits what the table says".
    // Transcribed guards drift silently otherwise: widening a require to admit
    // one more status is a one-word diff that no cell above would notice,
    // because the new cell would simply stop being tested as illegal.
    const src = readFileSync(join(__dirname, "..", "contracts", "FareOrders.sol"), "utf8");
    const body = (fn: string) => {
      const start = src.indexOf(`function ${fn}(`);
      if (start < 0) return "";
      return src.slice(start, start + 1200);
    };
    const declared = (fn: string) => {
      const seg = body(fn);
      const upto = seg.indexOf('"bad-status"');
      if (upto < 0) return null;
      const window = seg.slice(0, upto);
      // The statuses named in the require immediately preceding "bad-status".
      const names = [...window.matchAll(/Status\.([A-Za-z]+)/g)].map((m) => m[1]);
      const tail: string[] = [];
      for (let i = names.length - 1; i >= 0; i--) {
        if (!STATUS.includes(names[i] as StatusName)) break;
        tail.unshift(names[i]);
      }
      return tail;
    };

    const wrapper: Record<string, string> = {
      acceptBid: "_prepareAccept",
      acceptSealedBid: "_prepareSealedAccept",
      // Reads the same guard as its native sibling.
      increaseTipERC20: "increaseTipERC20",
    };

    for (const action of ACTIONS) {
      const fn = wrapper[action.name] ?? action.name;
      const fromSource = declared(fn);
      expect(fromSource, `could not read the guard for ${fn}`).to.not.equal(null);
      expect(new Set(fromSource!), `${action.name}: the table says ${action.legal.join("/")} `
        + `but the contract permits ${fromSource!.join("/")}`).to.deep.equal(new Set(action.legal));
    }
  });
});
