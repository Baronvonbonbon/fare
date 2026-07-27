import { describe, it, expect, beforeEach, vi } from "vitest";

// Runtime router resolution and log discovery (TEST-PLAN D2, finishing it).
//
// The address book shipped in the bundle is a SNAPSHOT. Contracts are upgraded
// through the freeze-and-drain router, so a client that trusts its build-time
// addresses keeps talking to a frozen v1 — reads return stale state and writes
// revert. `syncAddressesFromRouter` is what stops that, and it had no test.
//
// Its failure modes are all quiet:
//
//   · Overwriting a live address with the zero address a router returns for a
//     name it does not know would brick every call to that contract.
//   · Throwing on an RPC hiccup at boot would take the app down when falling
//     back to the shipped addresses is both possible and correct.
//   · Re-syncing on every render would put a burst of `currentAddrOf` calls
//     behind every UI update.
//
// `registrySynced` is module state and the sync runs once per module instance,
// so each test re-imports `./chain` under `vi.resetModules()` to get a fresh
// one. That is also why this is a separate file from chainglue.test.ts.

const ROUTER = "0x" + "a0".repeat(20);
const SHIPPED = {
  router: ROUTER,
  vault: "0x" + "11".repeat(20),
  orders: "0x" + "22".repeat(20),
  settlement: "0x" + "33".repeat(20),
  drivers: "0x" + "44".repeat(20),
  venues: "0x" + "55".repeat(20),
  disputes: "0x" + "66".repeat(20),
  pauseRegistry: "0x" + "77".repeat(20),
};
const ZERO = "0x0000000000000000000000000000000000000000";

/// What the router will answer, keyed by the decoded registry name. Set per
/// test before importing chain.
let routerAnswers: Record<string, string> = {};
let routerThrows: Error | null = null;
let currentAddrCalls = 0;

/// Log rows a queryFilter should return, per event name.
let logRows: Record<string, any[]> = {};
let queryFilterCalls = 0;

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeContract {
    filters: any;
    constructor(public address: string, _abi: any, _runner: any) {
      this.filters = {
        OrderCreated: () => ({ event: "OrderCreated" }),
        OrderAssigned: () => ({ event: "OrderAssigned" }),
        OrderRegion: (region: string) => ({ event: "OrderRegion", region }),
      };
    }
    async currentAddrOf(nameBytes32: string) {
      currentAddrCalls++;
      if (routerThrows) throw routerThrows;
      const name = actual.decodeBytes32String(nameBytes32);
      return routerAnswers[name] ?? ZERO;
    }
    async queryFilter(filter: any) {
      queryFilterCalls++;
      return logRows[filter.event] ?? [];
    }
  }
  return { ...actual, Contract: FakeContract };
});

async function freshChain(book: Record<string, string> = SHIPPED) {
  vi.resetModules();
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  vi.doMock("./deployed-addresses.json", () => ({
    default: { addresses: { ...book }, chainId: 420420417, network: "polkadotTestnet" },
  }));
  return await import("./chain");
}

beforeEach(() => {
  routerAnswers = {};
  routerThrows = null;
  currentAddrCalls = 0;
  queryFilterCalls = 0;
  logRows = {};
});

describe("runtime router resolution", () => {
  it("re-points every entry the router has moved", async () => {
    // The upgrade case: orders and settlement were redeployed and the router
    // now returns v2. A client still calling v1 hits a frozen contract.
    const v2Orders = "0x" + "ee".repeat(20);
    const v2Settlement = "0x" + "ff".repeat(20);
    routerAnswers = { ...SHIPPED, orders: v2Orders, settlement: v2Settlement };

    const chain = await freshChain();
    expect(await chain.syncAddressesFromRouter()).to.equal(true);

    expect(chain.ADDRESSES.orders).to.equal(v2Orders);
    expect(chain.ADDRESSES.settlement).to.equal(v2Settlement);
    // Untouched entries keep their shipped values rather than being cleared.
    expect(chain.ADDRESSES.vault).to.equal(SHIPPED.vault);
  });

  it("keeps the shipped address when the router answers zero", async () => {
    // A registry that has never been told about a name returns address(0).
    // Writing that through would point the app at nothing and every call to
    // that contract would revert with no useful error.
    routerAnswers = { ...SHIPPED, vault: ZERO, disputes: ZERO };

    const chain = await freshChain();
    await chain.syncAddressesFromRouter();

    expect(chain.ADDRESSES.vault, "a zero answer blanked a live address").to.equal(SHIPPED.vault);
    expect(chain.ADDRESSES.disputes).to.equal(SHIPPED.disputes);
  });

  it("falls back to the shipped book when the router read fails", async () => {
    // This runs at boot. Throwing would take the whole app down over an RPC
    // hiccup, when continuing with the bundled addresses is both possible and
    // usually correct.
    routerThrows = new Error("network unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const chain = await freshChain();
    expect(await chain.syncAddressesFromRouter()).to.equal(false);

    expect(chain.ADDRESSES.orders).to.equal(SHIPPED.orders);
    expect(warn, "a silent fallback — nobody would know the app is on stale addresses")
      .toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retries after a failure, and then stops once it succeeds", async () => {
    // A failed sync must not latch: the next call should try again. A
    // successful one must latch, or every render re-reads seven registry
    // entries over the network.
    routerThrows = new Error("down");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chain = await freshChain();

    expect(await chain.syncAddressesFromRouter()).to.equal(false);
    const afterFirst = currentAddrCalls;
    expect(afterFirst).to.be.greaterThan(0);

    expect(await chain.syncAddressesFromRouter()).to.equal(false);
    expect(currentAddrCalls, "gave up after one failure").to.be.greaterThan(afterFirst);

    routerThrows = null;
    routerAnswers = { ...SHIPPED };
    expect(await chain.syncAddressesFromRouter()).to.equal(true);
    const afterSuccess = currentAddrCalls;

    expect(await chain.syncAddressesFromRouter()).to.equal(true);
    expect(currentAddrCalls, "re-read the registry after it had already synced")
      .to.equal(afterSuccess);
    warn.mockRestore();
  });

  it("does nothing at all when the deployment has no router", async () => {
    // Pre-router deployments are a real configuration; the app must run on the
    // shipped addresses without reaching for a contract that isn't there.
    const { router, ...noRouter } = SHIPPED;
    const chain = await freshChain(noRouter);

    expect(await chain.syncAddressesFromRouter()).to.equal(false);
    expect(currentAddrCalls).to.equal(0);
    expect(chain.ADDRESSES.orders).to.equal(SHIPPED.orders);
  });
});

describe("log discovery", () => {
  it("decodes OrderCreated rows into the fields the boards render", async () => {
    logRows = {
      OrderCreated: [
        { args: { orderId: 7n, venueId: 3n, customer: "0x" + "ab".repeat(20) }, blockNumber: 100 },
        { args: { orderId: 8n, venueId: 4n, customer: "0x" + "cd".repeat(20) }, blockNumber: 101 },
      ],
    };
    const chain = await freshChain();
    const out = await chain.discoverOrders(0, 200);

    expect(out).to.have.length(2);
    expect(out[0]).to.deep.equal({ id: 7n, venueId: 3n, customer: "0x" + "ab".repeat(20), block: 100 });
    // The block number is what the incremental scan resumes from; losing it
    // would make every refresh re-read the chain from genesis.
    expect(out[1].block).to.equal(101);
  });

  it("decodes OrderAssigned into id and driver", async () => {
    logRows = { OrderAssigned: [{ args: { orderId: 9n, driver: "0x" + "ef".repeat(20) } }] };
    const chain = await freshChain();
    expect(await chain.discoverAssignments(0, 10))
      .to.deep.equal([{ id: 9n, driver: "0x" + "ef".repeat(20) }]);
  });

  it("returns nothing, and asks nothing, for an empty region list", async () => {
    // A driver with no location yet produces no cover. Querying "all regions"
    // — or issuing a filter with no topic — would pull the whole stream.
    const chain = await freshChain();
    logRows = { OrderRegion: [{ args: { orderId: 1n } }] };

    expect(await chain.orderIdsInRegions([], 0, 10)).to.deep.equal([]);
    expect(queryFilterCalls, "queried the chain for an empty region list").to.equal(0);

    // Control: the counter does move when there IS a region, so the zero above
    // is a real absence and not a counter that never increments.
    await chain.orderIdsInRegions(["0xaa"], 0, 10);
    expect(queryFilterCalls).to.equal(1);
  });

  it("flattens ids across every region it was given", async () => {
    logRows = { OrderRegion: [{ args: { orderId: 5n } }, { args: { orderId: 6n } }] };
    const chain = await freshChain();
    const ids = await chain.orderIdsInRegions(["0xaa", "0xbb"], 0, 10);
    // Two regions × two rows each — the flatten is what turns a per-region
    // array of arrays into the flat id list callers expect.
    expect(ids).to.deep.equal([5n, 6n, 5n, 6n]);
  });
});
