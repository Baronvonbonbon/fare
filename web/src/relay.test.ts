import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The gasless-relay client (TEST-PLAN D2, finishing it).
//
// `degradation.test.ts` already covers the relay being ABSENT — `sponsorGas`
// declining cleanly, `forwarderAvailable()` false, callers falling back to the
// gas-paying path. What was never covered is the relay being PRESENT: the
// decline protocol, the fallback prompt, and the serialization on the way out.
//
// Three things here are load-bearing and would each fail quietly:
//
//   · A 402 is a *decline*, not an error. Treating it as a failure would strand
//     the user instead of offering them the direct path.
//   · Declining and then REFUSING the prompt must submit nothing at all. A
//     fallback that fires anyway spends gas the user just said no to.
//   · Bodies carry BigInts (ZK public signals). `JSON.stringify` throws on
//     those, so the replacer is the only reason a dropoff proof can be posted.

const { poolStub, shieldStub, chainStub } = vi.hoisted(() => ({
  poolStub: { relayPool: () => [] as string[] },
  shieldStub: {
    // Typed as `boolean`, not inferred as the literal `true` — these are
    // reassigned per test.
    shieldedFundingAvailable: (): boolean => true,
    fundViaShield: async () => ({ funded: true }),
  },
  chainStub: {
    sendProvider: { waitForTransaction: async (h: string) => ({ hash: h, status: 1 }) },
    readProvider: {},
    nativeBalance: async () => 0n,
    CHAIN_ID: 420420417,
    ADDRESSES: { forwarder: "0x" + "f0".repeat(20), orders: "0x" + "01".repeat(20) },
  },
}));

vi.mock("./pool", () => poolStub);
vi.mock("./shield", () => shieldStub);
vi.mock("./chain", () => chainStub);

import {
  activeRelayUrl, relayConfigured, forwarderAvailable,
  sponsorGas, ensureGas, fundBurner, relaySettle,
} from "./relay";

const RELAY = "https://relay.example";

/// Record every outbound request so the body can be inspected — the point of
/// several assertions is what got serialized, not just what came back.
function stubFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; body: any; raw: string }[] = [];
  (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
    const raw = init?.body ?? "";
    calls.push({ url: String(url), raw, body: raw ? JSON.parse(raw) : undefined });
    return handler(String(url), init);
  });
  return calls;
}

const json = (status: number, body: any) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("relay selection", () => {
  afterEach(() => { poolStub.relayPool = () => []; vi.restoreAllMocks(); });

  it("prefers a region relay discovered from a venue manifest", () => {
    // Relay location is discoverable and region-scoped rather than hardcoded:
    // a venue advertising `services.relayUrl` serves its region automatically,
    // and must win over the build-time anchor.
    poolStub.relayPool = () => ["https://region.example", "https://other.example"];
    expect(activeRelayUrl()).to.equal("https://region.example");
    expect(relayConfigured()).to.equal(true);
  });

  it("needs BOTH a relay and a deployed forwarder for gasless actions", () => {
    // Either one missing means meta-transactions are impossible, and the
    // caller has to take the direct gas-paying path. A pre-forwarder
    // deployment with a relay is a real configuration, not a hypothetical.
    poolStub.relayPool = () => [RELAY];
    expect(forwarderAvailable()).to.equal(true);

    (chainStub.ADDRESSES as any).forwarder = "";
    expect(forwarderAvailable(), "claimed gasless with no forwarder deployed").to.equal(false);
    chainStub.ADDRESSES.forwarder = "0x" + "f0".repeat(20);

    poolStub.relayPool = () => [];
    expect(forwarderAvailable()).to.equal(false);
  });
});

describe("gas sponsorship", () => {
  beforeEach(() => { poolStub.relayPool = () => [RELAY]; });
  afterEach(() => { poolStub.relayPool = () => []; vi.restoreAllMocks(); });

  it("reports the relay's answer when it funds", async () => {
    stubFetch(() => json(200, { funded: true, txHash: "0x" + "aa".repeat(32) }));
    expect((await sponsorGas("0x" + "01".repeat(20))).funded).to.equal(true);
  });

  it("passes through 'already sufficient' as a success, not a failure", async () => {
    // /fund declines an address that already holds gas, which is correct
    // behaviour and must not read as "could not fund" — the caller would
    // otherwise block a perfectly fundable order.
    stubFetch(() => json(200, { funded: false, reason: "sufficient" }));
    const r = await sponsorGas("0x" + "01".repeat(20));
    expect(r.reason).to.equal("sufficient");
  });

  it("never throws when the relay is unreachable", async () => {
    // This runs on the create-order path. A throw here takes out checkout;
    // the documented behaviour is an unfunded result and no faucet.
    (globalThis as any).fetch = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const r = await sponsorGas("0x" + "01".repeat(20));
    expect(r.funded).to.equal(false);
    expect(r.reason).to.match(/no-faucet/);
  });

  it("ensureGas short-circuits when the burner is already funded", async () => {
    // No relay call at all — a needless /fund would be rate limiter budget
    // spent on an address that does not need it.
    chainStub.nativeBalance = async () => 10n ** 18n;
    const calls = stubFetch(() => json(200, { funded: true }));
    expect(await ensureGas("0x" + "01".repeat(20), 10n ** 17n)).to.equal(true);
    expect(calls, "called /fund for an already-funded burner").to.have.length(0);
    chainStub.nativeBalance = async () => 0n;
  });

  it("ensureGas accepts the relay's 'sufficient' without waiting for a balance change", async () => {
    chainStub.nativeBalance = async () => 0n;
    stubFetch(() => json(200, { funded: false, reason: "sufficient" }));
    expect(await ensureGas("0x" + "01".repeat(20), 10n ** 17n)).to.equal(true);
  });

  it("fundBurner refuses rather than falling back to a non-shielded path", async () => {
    // The one case that must NOT degrade quietly: a burner funded outside the
    // pool carries an on-chain edge back to the customer, so absence has to be
    // an error rather than a fallback.
    shieldStub.shieldedFundingAvailable = () => false;
    await expect(fundBurner("0x" + "01".repeat(20), 1n)).rejects.toThrow(/shielded funding unavailable/);
    shieldStub.shieldedFundingAvailable = () => true;
  });
});

describe("the decline protocol", () => {
  let runner: any;
  let directCalls: number;

  beforeEach(() => {
    poolStub.relayPool = () => [RELAY];
    directCalls = 0;
    runner = {
      settlement: {
        confirmPickup: async () => { directCalls++; return { hash: "0xdirect", wait: async () => ({}) }; },
        confirmDropoffZK: async () => { directCalls++; return { hash: "0xdirect", wait: async () => ({}) }; },
      },
    };
  });
  afterEach(() => { poolStub.relayPool = () => []; vi.restoreAllMocks(); });

  it("submits through the relay when it accepts", async () => {
    const calls = stubFetch(() => json(200, { txHash: "0x" + "bb".repeat(32) }));
    const tx = await relaySettle(runner, "confirmPickup", [{ orderId: 1n }, "0xsig"]);

    expect(tx.hash).to.equal("0x" + "bb".repeat(32));
    expect(directCalls, "paid its own gas despite the relay accepting").to.equal(0);
    expect(calls[0].url).to.equal(`${RELAY}/submit`);
    expect(calls[0].body.method).to.equal("confirmPickup");
    // The receipt has to be resolvable, or the UI never advances past "pending".
    expect((await tx.wait()).hash).to.equal("0x" + "bb".repeat(32));
  });

  it("offers the direct path on a 402, and takes it when the user agrees", async () => {
    // 402 is the relay's profitability guard, not a fault. The user is asked,
    // and a yes means the same call goes out paying its own gas.
    stubFetch(() => json(402, { declined: true, error: "relay comp below relayed cost", action: "settle" }));
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal("window", { confirm });

    const tx = await relaySettle(runner, "confirmDropoffZK", [{ orderId: 1n }]);
    expect(directCalls).to.equal(1);
    expect(tx.hash).to.equal("0xdirect");
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).to.match(/confirmDropoffZK/);
  });

  it("submits NOTHING when the user refuses the fallback", async () => {
    // The assertion that matters most here. A refused prompt must leave the
    // chain untouched — a fallback that fires anyway spends gas the user just
    // declined to spend.
    stubFetch(() => json(402, { declined: true, error: "subsidy budget exhausted" }));
    vi.stubGlobal("window", { confirm: () => false });

    await expect(relaySettle(runner, "confirmPickup", [{ orderId: 1n }]))
      .rejects.toThrow(/cancelled/);
    expect(directCalls, "submitted after the user said no").to.equal(0);
  });

  it("treats a 200 carrying `declined` as a decline too", async () => {
    // The relay signals a decline with 402 AND a body flag. Reading only the
    // status would take a declined response as a success with no txHash and
    // fail much further downstream.
    stubFetch(() => json(200, { declined: true, error: "subsidy budget exhausted" }));
    vi.stubGlobal("window", { confirm: () => true });
    await relaySettle(runner, "confirmPickup", [{ orderId: 1n }]);
    expect(directCalls).to.equal(1);
  });

  it("a genuine relay error is NOT offered as a fallback prompt", async () => {
    // A 500 means the relay broke, not that it declined. Prompting "pay your
    // own gas?" for a transport fault trains users to click through real
    // problems — and the caller should see the error.
    stubFetch(() => json(500, { error: "boom" }));
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal("window", { confirm });

    await expect(relaySettle(runner, "confirmPickup", [{ orderId: 1n }])).rejects.toThrow(/boom/);
    expect(confirm).not.toHaveBeenCalled();
    expect(directCalls).to.equal(0);
  });

  it("a 200 with no txHash is an error, not a silent success", async () => {
    stubFetch(() => json(200, {}));
    vi.stubGlobal("window", { confirm: () => false });
    await expect(relaySettle(runner, "confirmPickup", [{ orderId: 1n }])).rejects.toThrow();
  });

  it("serializes BigInt arguments instead of throwing on them", async () => {
    // ZK public signals are bigints, and plain JSON.stringify throws on a
    // BigInt — so without the replacer every ZK dropoff fails at the point of
    // posting, with an error that names JSON rather than the proof.
    const calls = stubFetch(() => json(200, { txHash: "0x" + "cc".repeat(32) }));
    const pub = [1n, 2n ** 200n, 0n];

    await relaySettle(runner, "confirmDropoffZK", [{ orderId: 42n }, "0xsig", "0xproof", pub]);

    expect(calls).to.have.length(1);
    const sent = calls[0].body.args;
    expect(sent[0].orderId).to.equal("42");
    expect(sent[3]).to.deep.equal(["1", (2n ** 200n).toString(), "0"]);
    // And nothing was lost to scientific notation on the way.
    expect(calls[0].raw).to.include((2n ** 200n).toString());
  });

  it("goes direct without asking when no relay is configured", async () => {
    poolStub.relayPool = () => [];
    const confirm = vi.fn((_msg?: string) => true);
    vi.stubGlobal("window", { confirm });
    (globalThis as any).fetch = vi.fn(async () => { throw new Error("should not be called"); });

    const tx = await relaySettle(runner, "confirmPickup", [{ orderId: 1n }]);
    expect(tx.hash).to.equal("0xdirect");
    expect(confirm, "prompted about a relay that does not exist").not.toHaveBeenCalled();
  });
});
