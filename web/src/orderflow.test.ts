import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Order-flow decisions, extracted from App.tsx (TEST-PLAN §6).
//
// App.tsx was 2,689 lines with no tests, and the reason it had none is that
// everything worth asserting was welded to a component. This covers the four
// decisions that were buried in it, now that they are not:
//
//   · when an order counts as abandoned (deadline hygiene)
//   · what a driver is shown, and in what order
//   · where the drop secret and receipt go
//   · what actually happens when a customer presses Place order
//
// The last one is the money path, and its ordering is load-bearing: the drop
// secret is written BEFORE the transaction, because a secret for an order that
// never existed is harmless while a missing secret for one that did makes the
// drop unprovable and the escrow unrecoverable.

const { chainStub, walletsStub, relayStub, tokenStub, threadStub } = vi.hoisted(() => ({
  chainStub: {
    randomSalt: () => "424242",
    computeDropCommit: (lat: number, lon: number, salt: string) => `0xcommit:${lat}:${lon}:${salt}`,
    contracts: (_w: any) => contractsImpl(),
    parse: (v: string) => BigInt(Math.round(Number(v) * 1e18)),
    ADDRESSES: { orders: "0x" + "01".repeat(20) },
  },
  walletsStub: { newOrderWallet: () => ({ address: "0xburner", privateKey: "0xkey" }) },
  relayStub: {
    fundBurner: vi.fn(async (_a: string, _v: bigint) => true),
    forwarderAvailable: () => forwarder,
  },
  tokenStub: {
    mintStablecoin: vi.fn(async () => {}),
    approveToken: vi.fn(async () => {}),
    gaslessCreateOrderERC20: vi.fn(async () => ({ hash: "0xgasless" })),
  },
  threadStub: { OrderThread: class { constructor(..._a: any[]) {} async open() { opened.push(1); return {}; } } },
}));

vi.mock("./chain", () => chainStub);
vi.mock("./wallets", () => walletsStub);
vi.mock("./relay", () => relayStub);
vi.mock("./token", () => tokenStub);
vi.mock("./channel", () => threadStub);

let forwarder = false;
let opened: number[] = [];
const calls: { fn: string; args: any[] }[] = [];

function contractsImpl() {
  return {
    orders: {
      createOrder: async (...args: any[]) => {
        calls.push({ fn: "createOrder", args });
        return {
          hash: "0xnative",
          wait: async () => ({ logs: [{ x: 1 }] }),
        };
      },
      createOrderERC20: async (...args: any[]) => {
        calls.push({ fn: "createOrderERC20", args });
        return { hash: "0xerc20", wait: async () => ({ logs: [] }) };
      },
      interface: { parseLog: (_l: any) => ({ name: "OrderCreated", args: { orderId: 7n } }) },
    },
  };
}

import {
  orderExpiry, fmtLeft, driverBoard, loadReceipt, loadDropSecret,
  dropStoreKey, receiptKey, placeOrder, badgeClass, TERMINAL_STATUS, discoverRelevantOrders,
  type OrderRow, type VenueRow,
} from "./orderflow";

// ── fixtures ────────────────────────────────────────────────────────────────

const order = (o: Partial<OrderRow> & { id: bigint; status: number }): OrderRow => ({
  customer: "0x" + "c0".repeat(20),
  venueId: 1n,
  driver: "0x0000000000000000000000000000000000000000",
  orderValue: 0n, tip: 0n, fare: 0n, maxFare: 0n,
  dropCommit: "0xdrop",
  createdAt: 1000n, pickupWindowSecs: 1800n,
  pickupDeadline: 5000n, deliveryDeadline: 9000n,
  token: "0x0000000000000000000000000000000000000000",
  ...o,
});

const venue = (id: bigint, lat: number, lon: number): VenueRow => ({
  id, operator: "0xop", signer: "0xsig", payout: "0xpay",
  lat, lon, active: true, pickups: 0, metadataURI: "",
});

function memoryLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

beforeEach(() => {
  forwarder = false;
  opened = [];
  calls.length = 0;
  relayStub.fundBurner.mockClear();
  tokenStub.mintStablecoin.mockClear();
  tokenStub.approveToken.mockClear();
  tokenStub.gaslessCreateOrderERC20.mockClear();
  memoryLocalStorage();
});
afterEach(() => vi.restoreAllMocks());

// ── deadline hygiene ────────────────────────────────────────────────────────

describe("when an order counts as abandoned", () => {
  it("treats an OPEN order past its own pickup window as stale", () => {
    // Open orders carry no on-chain deadline — one is only written at
    // assignment — so this is the only signal that nobody is coming. Without
    // it a driver board fills with orders whose customers gave up days ago.
    const o = order({ id: 1n, status: 1, createdAt: 1000n, pickupWindowSecs: 1800n });
    expect(orderExpiry(o, 2799)).to.equal(null);
    expect(orderExpiry(o, 2800), "expired exactly at the boundary").to.equal(null);
    expect(orderExpiry(o, 2801)?.label).to.equal("stale");
  });

  it("uses the real on-chain deadline once assigned", () => {
    const o = order({ id: 1n, status: 2, pickupDeadline: 5000n });
    expect(orderExpiry(o, 5000)).to.equal(null);
    expect(orderExpiry(o, 5001)?.label).to.equal("pickup overdue");
  });

  it("switches to the delivery deadline after pickup", () => {
    // The two deadlines are different fields; reading the pickup one after
    // pickup would mark every in-flight delivery overdue the moment it starts.
    const o = order({ id: 1n, status: 3, pickupDeadline: 5000n, deliveryDeadline: 9000n });
    expect(orderExpiry(o, 6000), "used the pickup deadline after pickup").to.equal(null);
    expect(orderExpiry(o, 9001)?.label).to.equal("delivery overdue");
  });

  it("never marks a terminal order late", () => {
    // Delivered, cancelled and resolved orders are done. A "delivery overdue"
    // badge on a completed order is pure noise, and it would appear on every
    // historical order forever.
    for (const status of [4, 5, 6, 7]) {
      expect(orderExpiry(order({ id: 1n, status }), 10 ** 9), `status ${status} was marked late`).to.equal(null);
    }
  });

  it("is not fooled by bigint fields arriving as strings from the chain", () => {
    // createdAt + pickupWindowSecs are bigints; adding them before Number() is
    // what keeps this exact past 2^53. A string concat here would produce
    // "10001800" and nothing would ever look stale.
    const o = order({ id: 1n, status: 1, createdAt: 1000n, pickupWindowSecs: 1800n });
    expect(Number(o.createdAt + o.pickupWindowSecs)).to.equal(2800);
    expect(orderExpiry(o, 10_001_800)).to.not.equal(null);
  });
});

describe("countdown formatting", () => {
  it("collapses to the coarsest useful unit", () => {
    expect(fmtLeft(0)).to.equal("now");
    expect(fmtLeft(-5), "a passed deadline should read as now, not negative").to.equal("now");
    expect(fmtLeft(45)).to.equal("45s");
    expect(fmtLeft(90)).to.equal("1m 30s");
    expect(fmtLeft(3700)).to.equal("1h 1m"); // seconds dropped past an hour
  });
});

// ── the driver board ────────────────────────────────────────────────────────

describe("what a driver is shown", () => {
  const ME = "0x" + "d1".repeat(20);
  const venues = [venue(1n, 37_774_900, -122_419_400), venue(2n, 37_874_900, -122_419_400)];
  const HERE = { lat: 37_774_900, lon: -122_419_400 };
  const now = 2000;

  it("lists only my own in-flight jobs", () => {
    // Status 2/3/6 are assigned, picked up and disputed — work still in hand.
    // A delivered order in this list would never leave the driver's screen.
    const orders = [
      order({ id: 1n, status: 2, driver: ME }),
      order({ id: 2n, status: 3, driver: ME }),
      order({ id: 3n, status: 6, driver: ME }),
      order({ id: 4n, status: 4, driver: ME }),                       // delivered
      order({ id: 5n, status: 2, driver: "0x" + "ff".repeat(20) }),   // someone else's
    ];
    const b = driverBoard(orders, venues, { me: ME, myLoc: null, radiusKm: 0, nowSec: now });
    expect(b.jobs.map((j) => j.id)).to.deep.equal([1n, 2n, 3n]);
  });

  it("matches my address whatever its casing", () => {
    // The order's driver comes back checksummed from the chain and the session
    // address is whatever the wallet gave us. A case-sensitive compare empties
    // the driver's job list with no error anywhere.
    const orders = [order({ id: 1n, status: 2, driver: ME.toUpperCase().replace("0X", "0x") })];
    const b = driverBoard(orders, venues, { me: ME.toLowerCase(), myLoc: null, radiusKm: 0, nowSec: now });
    expect(b.jobs, "case-sensitive driver match lost a job").to.have.length(1);
  });

  it("shows nothing as mine when no wallet is connected", () => {
    const orders = [order({ id: 1n, status: 2, driver: ME })];
    expect(driverBoard(orders, venues, { me: null, myLoc: null, radiusKm: 0, nowSec: now }).jobs).to.have.length(0);
  });

  it("hides stale open orders and counts them", () => {
    const orders = [
      order({ id: 1n, status: 1, createdAt: 1000n, pickupWindowSecs: 1800n }), // live at t=2000
      order({ id: 2n, status: 1, createdAt: 0n, pickupWindowSecs: 100n }),     // stale
    ];
    const b = driverBoard(orders, venues, { me: ME, myLoc: null, radiusKm: 0, nowSec: now });
    expect(b.shown.map((x) => x.o.id)).to.deep.equal([1n]);
    expect(b.staleCount).to.equal(1);
  });

  it("sorts nearest first, with unknown distances last", () => {
    // An order whose venue is missing has no distance. Sorting it first would
    // put the least-known work at the top of the board.
    const orders = [
      order({ id: 1n, status: 1, venueId: 2n }),  // far venue
      order({ id: 2n, status: 1, venueId: 1n }),  // right here
      order({ id: 3n, status: 1, venueId: 99n }), // no such venue → null distance
    ];
    const b = driverBoard(orders, venues, { me: ME, myLoc: HERE, radiusKm: 0, nowSec: now });
    expect(b.shown.map((x) => x.o.id)).to.deep.equal([2n, 1n, 3n]);
    expect(b.shown[0].dist).to.be.lessThan(100);
    expect(b.shown[2].dist).to.equal(null);
  });

  it("hides out-of-radius pickups and reports how many", () => {
    const orders = [
      order({ id: 1n, status: 1, venueId: 1n }), // ~0 km
      order({ id: 2n, status: 1, venueId: 2n }), // ~11 km north
    ];
    const b = driverBoard(orders, venues, { me: ME, myLoc: HERE, radiusKm: 5, nowSec: now });
    expect(b.shown.map((x) => x.o.id)).to.deep.equal([1n]);
    expect(b.hidden).to.equal(1);
  });

  it("shows the whole board when location is unavailable", () => {
    // A driver who declined the location prompt must still see work. Filtering
    // on a null fix would silently show an empty board and look like no
    // demand.
    const orders = [order({ id: 1n, status: 1, venueId: 1n }), order({ id: 2n, status: 1, venueId: 2n })];
    const b = driverBoard(orders, venues, { me: ME, myLoc: null, radiusKm: 5, nowSec: now });
    expect(b.shown, "a driver with no fix was shown nothing").to.have.length(2);
    expect(b.hidden).to.equal(0);
  });

  it("treats radius 0 as no filter rather than an empty board", () => {
    const orders = [order({ id: 1n, status: 1, venueId: 2n })];
    const b = driverBoard(orders, venues, { me: ME, myLoc: HERE, radiusKm: 0, nowSec: now });
    expect(b.shown).to.have.length(1);
  });

  it("counts live open orders per venue for the map pins", () => {
    const orders = [
      order({ id: 1n, status: 1, venueId: 1n }),
      order({ id: 2n, status: 1, venueId: 1n }),
      order({ id: 3n, status: 1, venueId: 2n }),
      order({ id: 4n, status: 1, venueId: 1n, createdAt: 0n, pickupWindowSecs: 1n }), // stale
      order({ id: 5n, status: 4, venueId: 1n }),                                       // delivered
    ];
    const b = driverBoard(orders, venues, { me: ME, myLoc: null, radiusKm: 0, nowSec: now });
    expect(b.openByVenue.get("1"), "stale or finished orders inflated a pin").to.equal(2);
    expect(b.openByVenue.get("2")).to.equal(1);
  });

  it("does not mutate the array it was given", () => {
    // The sort is on a copy. Sorting React state in place is the classic way to
    // get a list that renders in a different order than the state it came from.
    const orders = [order({ id: 1n, status: 1, venueId: 2n }), order({ id: 2n, status: 1, venueId: 1n })];
    const before = orders.map((o) => o.id);
    driverBoard(orders, venues, { me: ME, myLoc: HERE, radiusKm: 0, nowSec: now });
    expect(orders.map((o) => o.id), "the caller's array was reordered").to.deep.equal(before);
  });
});

// ── receipts and drop secrets ───────────────────────────────────────────────

describe("locally held order data", () => {
  it("keys both stores case-insensitively on the commitment", () => {
    // The commitment comes back from the chain checksummed in some paths and
    // lowercase in others; a case-sensitive key loses the drop secret, and with
    // it the ability to prove the dropoff at all.
    const mixed = "0xAbCdEf";
    expect(dropStoreKey(mixed)).to.equal(dropStoreKey(mixed.toLowerCase()));
    expect(receiptKey(mixed)).to.equal(receiptKey(mixed.toUpperCase()));
  });

  it("returns null for a missing or corrupt receipt rather than throwing", () => {
    // These run during render. A throw here white-screens the order list.
    expect(loadReceipt("0xnope")).to.equal(null);
    localStorage.setItem(receiptKey("0xbad"), "{not json");
    expect(loadReceipt("0xbad")).to.equal(null);
    localStorage.setItem(dropStoreKey("0xbad"), "{not json");
    expect(loadDropSecret("0xbad")).to.equal(null);
  });
});

// ── placing an order ────────────────────────────────────────────────────────

const RECEIPT = {
  venueId: "1", venueName: "Golden Gate Grill",
  items: [{ name: "burrito", price: "0.5", qty: 2 }],
  orderValue: "1", tip: "0.1", maxFare: "2",
};

/// `act` as the app supplies it: runs the thunk and returns its result.
const act = async (_label: string, fn: () => Promise<any>) => fn();

describe("placing an order", () => {
  it("stores the drop secret BEFORE the transaction is attempted", async () => {
    // The ordering is the point. A secret stored for an order that never
    // existed is harmless; losing the secret for one that did makes the drop
    // unprovable and the escrow unrecoverable.
    const seen: string[] = [];
    await placeOrder({
      venueId: 1n, orderValueWei: 10n ** 18n, tipWei: 0n, maxFareWei: 2n * 10n ** 18n,
      lat: 37_784_900, lon: -122_419_400, receipt: RECEIPT,
      say: () => {},
      act: async (_l, fn) => {
        // By the time the transaction runs, the secret must already be down.
        seen.push(localStorage.getItem(dropStoreKey("0xcommit:37784900:-122419400:424242")) ?? "MISSING");
        return fn();
      },
    });
    expect(seen[0], "the transaction ran before the drop secret was saved").to.not.equal("MISSING");
    expect(JSON.parse(seen[0])).to.deep.equal({ lat: 37_784_900, lon: -122_419_400, salt: "424242" });
  });

  it("commits to the drop with a fresh salt, and never puts it on chain", async () => {
    await placeOrder({
      venueId: 1n, orderValueWei: 10n ** 18n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, act, say: () => {},
    });
    const [venueId, commit] = calls[0].args;
    expect(venueId).to.equal(1n);
    expect(commit).to.equal("0xcommit:1:2:424242");
    // The coordinates themselves are nowhere in the call.
    const asText = JSON.stringify(calls[0].args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(asText).to.not.include('"lat"');
    expect(asText, "the raw drop latitude went out with the order").to.not.include("37784900");
  });

  it("escrows order value plus tip, and funds the burner for gas on top", async () => {
    // Under-funding by the tip is the bug that would make every tipped order
    // fail at submission, and only tipped ones.
    await placeOrder({
      venueId: 1n, orderValueWei: 10n ** 18n, tipWei: 5n * 10n ** 17n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, act, say: () => {},
    });
    const escrow = 10n ** 18n + 5n * 10n ** 17n;
    // createOrder(venueId, commit, orderValue, tip, maxFare, 0, 0, overrides)
    expect(calls[0].args[7]).to.deep.equal({ value: escrow });
    expect(relayStub.fundBurner.mock.calls[0][1], "burner funded without a gas margin")
      .to.equal(escrow + 10n ** 17n * 2n);
  });

  it("stamps the receipt with a placement time", async () => {
    await placeOrder({
      venueId: 1n, orderValueWei: 1n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, act, say: () => {},
    });
    const r = loadReceipt("0xcommit:1:2:424242")!;
    expect(r.venueName).to.equal("Golden Gate Grill");
    expect(r.items).to.deep.equal(RECEIPT.items);
    expect(r.placedAt, "no placement time — the receipt cannot be ordered by date").to.be.a("number");
  });

  it("announces the order wallet's key once the order id is known", async () => {
    // Sealed bids are sealed TO the customer, and a driver has no other way to
    // get the key of a wallet that has never spoken. No announcement means no
    // bids arrive, silently.
    await placeOrder({
      venueId: 1n, orderValueWei: 1n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, act, say: () => {},
    });
    expect(opened, "the order wallet never announced itself").to.have.length(1);
  });

  it("uses the gasless forwarded path for a token order when a forwarder exists", async () => {
    forwarder = true;
    await placeOrder({
      venueId: 1n, orderValueWei: 10n ** 6n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, token: "0x" + "77".repeat(20), act, say: () => {},
    });
    expect(tokenStub.gaslessCreateOrderERC20).toHaveBeenCalledOnce();
    // Only a little gas — the escrow is the stablecoin, and the relay pays for
    // the order itself.
    expect(relayStub.fundBurner.mock.calls[0][1]).to.equal(5n * 10n ** 17n);
    expect(tokenStub.mintStablecoin).toHaveBeenCalledOnce();
    expect(tokenStub.approveToken, "approved despite going gasless").not.toHaveBeenCalled();
  });

  it("falls back to a direct token order when no forwarder is deployed", async () => {
    forwarder = false;
    await placeOrder({
      venueId: 1n, orderValueWei: 10n ** 6n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, token: "0x" + "77".repeat(20), act, say: () => {},
    });
    expect(tokenStub.gaslessCreateOrderERC20).not.toHaveBeenCalled();
    expect(tokenStub.approveToken, "sent a token order without approving the escrow").toHaveBeenCalledOnce();
    expect(calls.map((c) => c.fn)).to.deep.equal(["createOrderERC20"]);
  });

  it("treats the zero address as native, not as a token", async () => {
    // An order struct read back from the chain carries address(0) for native.
    // Taking that branch as a token order would try to mint a stablecoin that
    // does not exist.
    await placeOrder({
      venueId: 1n, orderValueWei: 1n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT,
      token: "0x0000000000000000000000000000000000000000", act, say: () => {},
    });
    expect(calls[0].fn).to.equal("createOrder");
    expect(tokenStub.mintStablecoin).not.toHaveBeenCalled();
  });

  it("lets a funding failure surface instead of ordering unfunded", async () => {
    // fundBurner throws when shielded funding is unconfigured — the one case
    // that must NOT degrade quietly, since a burner funded any other way
    // carries an on-chain edge back to the customer.
    relayStub.fundBurner.mockRejectedValueOnce(new Error("shielded funding unavailable"));
    await expect(placeOrder({
      venueId: 1n, orderValueWei: 1n, tipWei: 0n, maxFareWei: 0n,
      lat: 1, lon: 2, receipt: RECEIPT, act, say: () => {},
    })).rejects.toThrow(/shielded funding unavailable/);
    expect(calls, "submitted an order after funding failed").to.have.length(0);
  });
});

describe("status labels", () => {
  it("maps every status to a badge class, and an unknown one to empty", () => {
    expect(badgeClass(1)).to.equal("open");
    expect(badgeClass(4)).to.equal("delivered");
    expect(badgeClass(99), "an unknown status produced a broken class name").to.equal("");
  });

  it("counts exactly the three end-states as terminal", () => {
    // Terminal orders are never re-read. Marking a live status terminal would
    // freeze it in the UI at whatever it last looked like.
    expect([...TERMINAL_STATUS].sort()).to.deep.equal([4, 5, 7]);
    for (const live of [1, 2, 3, 6]) {
      expect(TERMINAL_STATUS.has(live), `status ${live} was treated as finished`).to.equal(false);
    }
  });
});

// ── which orders each role fetches ──────────────────────────────────────────

describe("what each role even knows about", () => {
  const ME = "0x" + "d1".repeat(20);
  const BURNER_A = "0x" + "0a".repeat(20);
  const BURNER_B = "0x" + "0b".repeat(20);
  const venues = [
    { ...venue(1n, 37_774_900, -122_419_400), operator: ME, signer: "0xsig" },
    { ...venue(2n, 37_874_900, -122_419_400), operator: "0xelse", signer: "0xelse2" },
  ];
  const HERE = { lat: 37_774_900, lon: -122_419_400 };

  const CREATED = [
    { id: 1n, venueId: 1n, customer: BURNER_A, block: 10 },
    { id: 2n, venueId: 2n, customer: BURNER_B, block: 11 },
    { id: 3n, venueId: 1n, customer: "0x" + "ff".repeat(20), block: 12 },
  ];

  /// Deps with counters, so "which queries ran" is assertable — the phase-2
  /// region path exists precisely to avoid one of them.
  function deps(over: Partial<any> = {}) {
    const counts = { created: 0, assigns: 0, regions: 0, nextId: 0 };
    const d = {
      discoverOrders: async () => { counts.created++; return CREATED; },
      discoverAssignments: async () => { counts.assigns++; return [{ id: 9n, driver: ME }]; },
      orderIdsInRegions: async () => { counts.regions++; return [1n]; },
      regionsCovering: () => ["0xregion"],
      myOrderWallets: () => new Set([BURNER_A.toLowerCase()]),
      nextOrderId: async () => { counts.nextId++; return 4n; },
      ...over,
    };
    return { d, counts };
  }
  const base = { myLoc: null, radiusKm: 0, venues, from: 0, to: 100 };

  it("scopes a customer to their LOCAL burner registry, not one address", async () => {
    // A customer's orders span many per-order wallets by design. Matching a
    // single session address would show them nothing they had ever ordered.
    const { d } = deps();
    const ids = await discoverRelevantOrders(d, { ...base, role: "customer", me: null });
    expect([...ids]).to.deep.equal(["1"]);
  });

  it("finds a customer's orders even with no wallet connected", async () => {
    // The burner registry is device-local; the customer view works before any
    // session exists, and must.
    const { d, counts } = deps();
    const ids = await discoverRelevantOrders(d, { ...base, role: "customer", me: null });
    expect(ids.size).to.equal(1);
    expect(counts.assigns, "pulled driver assignments for a customer").to.equal(0);
  });

  it("scopes a venue to venues it operates OR signs for", async () => {
    // Operator and signer are different keys on purpose — a venue can delegate
    // attestation signing. Matching only one loses that venue's whole board.
    const { d } = deps();
    const asOperator = await discoverRelevantOrders(d, { ...base, role: "venue", me: ME });
    expect([...asOperator]).to.deep.equal(["1", "3"]);

    const signerVenues = [{ ...venues[0], operator: "0xelse", signer: ME }, venues[1]];
    const asSigner = await discoverRelevantOrders(d, { ...base, role: "venue", me: ME, venues: signerVenues });
    expect([...asSigner], "a venue's signer key saw nothing").to.deep.equal(["1", "3"]);
  });

  it("matches a venue operator whatever the address casing", async () => {
    const { d } = deps();
    const ids = await discoverRelevantOrders(d, {
      ...base, role: "venue", me: ME.toUpperCase().replace("0X", "0x"),
    });
    expect(ids.size, "case-sensitive operator match emptied the venue board").to.equal(2);
  });

  it("shows a venue nothing when no wallet is connected", async () => {
    const { d } = deps();
    expect((await discoverRelevantOrders(d, { ...base, role: "venue", me: null })).size).to.equal(0);
  });

  it("uses the server-side region query for a located driver, and skips the full stream", async () => {
    // This is the whole point of phase 2: region is the LEADING indexed topic,
    // so it filters at the node. Pulling the full OrderCreated stream anyway
    // would work and would silently undo the optimisation.
    const { d, counts } = deps();
    const ids = await discoverRelevantOrders(d, { ...base, role: "driver", me: ME, myLoc: HERE, radiusKm: 5 });

    expect(counts.regions).to.equal(1);
    expect(counts.created, "fetched the whole stream despite a region query").to.equal(0);
    expect([...ids].sort()).to.deep.equal(["1", "9"]);
  });

  it("falls back to the full stream when the node has no OrderRegion topic", async () => {
    // A pre-phase-2 node throws on the region filter. Falling back is what
    // keeps the driver board working on an older RPC instead of empty.
    const { d, counts } = deps({
      orderIdsInRegions: async () => { throw new Error("unknown topic"); },
    });
    const ids = await discoverRelevantOrders(d, { ...base, role: "driver", me: ME, myLoc: HERE, radiusKm: 5 });

    expect(counts.created, "did not fall back to the stream").to.equal(1);
    // Client-side region filter: venue 1 is here, venue 2 is ~11 km away.
    expect([...ids].sort()).to.deep.equal(["1", "3", "9"]);
  });

  it("shows a driver everything when they have no location fix", async () => {
    const { d, counts } = deps();
    const ids = await discoverRelevantOrders(d, { ...base, role: "driver", me: ME });
    expect(counts.regions, "ran a region query with no location").to.equal(0);
    expect([...ids].sort()).to.deep.equal(["1", "2", "3", "9"]);
  });

  it("keeps a driver's own jobs regardless of radius", async () => {
    // The property this branch exists for: an active delivery must not vanish
    // from the driver's screen the moment they walk out of the radius they set.
    // Order 9 is assigned to them and is in NO region result.
    const { d } = deps({ orderIdsInRegions: async () => [] });
    const ids = await discoverRelevantOrders(d, { ...base, role: "driver", me: ME, myLoc: HERE, radiusKm: 1 });
    expect([...ids], "the driver's own job was filtered out by their radius").to.deep.equal(["9"]);
  });

  it("does not pull assignments for a driver with no session", async () => {
    const { d, counts } = deps();
    await discoverRelevantOrders(d, { ...base, role: "driver", me: null });
    expect(counts.assigns).to.equal(0);
  });

  it("enumerates every order when the node has no eth_getLogs", async () => {
    // Slow and correct beats fast and blank: a light client without log queries
    // must still show a working app, with the views filtering locally.
    const { d, counts } = deps({
      discoverOrders: async () => { throw new Error("eth_getLogs unsupported"); },
    });
    const ids = await discoverRelevantOrders(d, { ...base, role: "customer", me: null });
    expect(counts.nextId).to.equal(1);
    expect([...ids].sort()).to.deep.equal(["1", "2", "3"]); // 1 .. nextOrderId-1
  });

  it("fetches the OrderCreated stream at most once", async () => {
    // It is the most expensive call in a refresh, and both the customer and the
    // driver-fallback branches want it.
    const { d, counts } = deps({
      orderIdsInRegions: async () => { throw new Error("no topic"); },
    });
    await discoverRelevantOrders(d, { ...base, role: "driver", me: ME, myLoc: HERE, radiusKm: 5 });
    expect(counts.created).to.equal(1);
  });

  it("deduplicates ids that more than one branch found", async () => {
    // A driver's assigned job that is also in their region must appear once —
    // the ids key a struct-read map downstream, and a duplicate is a wasted
    // round trip per refresh.
    const { d } = deps({ orderIdsInRegions: async () => [9n, 9n, 1n] });
    const ids = await discoverRelevantOrders(d, { ...base, role: "driver", me: ME, myLoc: HERE, radiusKm: 5 });
    expect([...ids].sort()).to.deep.equal(["1", "9"]);
  });
});
