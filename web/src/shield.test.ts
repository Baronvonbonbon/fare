import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Shielded burner funding — the seam (TEST-PLAN §6).
//
// Per-order burners are only unlinkable while their funding source is
// anonymous. Funding one from the customer's main wallet writes an on-chain
// edge that collapses the whole scheme, so this module's job is to be the ONLY
// way a burner gets escrow — and to refuse loudly when it cannot be.
//
// That refusal is the property under test. `degradation.test.ts` already covers
// the call site (`fundBurner` throws rather than falling back); this covers the
// registry underneath it, where the failure would be quieter: a funder that
// reports itself available while holding nothing spendable, or a `fundViaShield`
// that returned an unfunded result instead of throwing, would let the caller
// proceed and fund the burner some other way.
//
// The note store is the other half. It holds SECRETS, it is the only record
// that a deposit happened, and both a lost note and a double-spent one are
// unrecoverable.

const { poolStub, gasStub } = vi.hoisted(() => ({
  poolStub: {
    depositAndSnapshot: vi.fn(async () => ({ record: { nullifier: "n1", value: "1000", spent: false } })),
    buildWithdrawal: vi.fn(async (_p?: any, _pool?: string, _note?: any, _recipient?: string, _value?: bigint) =>
      ({ pA: [], pB: [], pC: [], pubSignals: [], change: { value: "0" } })),
    recordChangeNote: vi.fn(async () => ({ nullifier: "change", value: "5", spent: false })),
    commitmentOf: () => 42n,
  },
  gasStub: { DEPOSIT_GAS: 1n, RETURN_GAS: 2n, RETURN_RESERVE_WEI: 10n ** 18n },
}));

vi.mock("./shieldpool", () => poolStub);
vi.mock("./gasbudget", () => gasStub);
vi.mock("./chain", () => ({ readProvider: {}, sendProvider: {} }));

import {
  registerShieldedFunder, shieldedFundingAvailable, fundViaShield, adoptShieldedNote,
  type ShieldedFunder,
} from "./shield";

function memoryLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

/// A funder whose availability and payout are dictated per test.
function funder(over: Partial<ShieldedFunder> = {}): ShieldedFunder {
  return {
    available: async () => true,
    deposit: async () => ({ commitment: "0xc", denominationWei: "1", createdAt: 0 }),
    fundBurner: async () => ({ funded: true, txHash: "0xabc" }),
    ...over,
  } as ShieldedFunder;
}

/// The registry is module state, so each test re-imports for a clean one.
async function freshShield() {
  vi.resetModules();
  memoryLocalStorage();
  return await import("./shield");
}

beforeEach(() => { memoryLocalStorage(); });
afterEach(() => vi.restoreAllMocks());

describe("the funding registry", () => {
  it("reports unavailable until a backend registers", async () => {
    // The default state, and the one that matters: with no shielded backend
    // deployed the app must know it, so call sites take the documented
    // fallback rather than silently funding a burner in the clear.
    const s = await freshShield();
    expect(s.shieldedFundingAvailable()).to.equal(false);

    s.registerShieldedFunder(funder());
    expect(s.shieldedFundingAvailable()).to.equal(true);
  });

  it("throws rather than returning an unfunded result when nothing is registered", async () => {
    // The distinction is the whole point. An unfunded RESULT is something a
    // caller can shrug off and route around; a throw is not. A burner funded
    // any other way carries an on-chain edge straight back to the customer.
    const s = await freshShield();
    await expect(s.fundViaShield("0xburner", 1n)).rejects.toThrow(/no funder registered/);
  });

  it("throws when the funder is registered but holds no spendable note", async () => {
    // Registered ≠ usable. A pool with no deposit left cannot fund anything,
    // and reporting success here would hand the caller a burner with nothing
    // in it and no error to explain why the order then failed.
    const s = await freshShield();
    s.registerShieldedFunder(funder({ available: async () => false }));

    expect(s.shieldedFundingAvailable(), "capability check is about registration, not balance").to.equal(true);
    await expect(s.fundViaShield("0xburner", 1n)).rejects.toThrow(/no spendable note/);
  });

  it("checks availability BEFORE spending anything", async () => {
    // Order matters: asking the backend to fund and then discovering it was
    // empty can leave a half-consumed note behind.
    const s = await freshShield();
    const order: string[] = [];
    s.registerShieldedFunder(funder({
      available: async () => { order.push("available"); return false; },
      fundBurner: async () => { order.push("fund"); return { funded: true }; },
    }));

    await expect(s.fundViaShield("0xburner", 1n)).rejects.toThrow();
    expect(order, "tried to fund before checking it could").to.deep.equal(["available"]);
  });

  it("passes the burner and amount through untouched", async () => {
    const s = await freshShield();
    const seen: any[] = [];
    s.registerShieldedFunder(funder({
      fundBurner: async (b: string, a: bigint) => { seen.push([b, a]); return { funded: true, txHash: "0x1" }; },
    }));

    const r = await s.fundViaShield("0xBurnerAddress", 5n * 10n ** 18n);
    expect(seen[0]).to.deep.equal(["0xBurnerAddress", 5n * 10n ** 18n]);
    expect(r.funded).to.equal(true);
  });

  it("lets a later registration replace an earlier one", async () => {
    // The registry is a setter so the real backend can land as an additive
    // module. Two funders must not both be live — the second is the answer.
    const s = await freshShield();
    s.registerShieldedFunder(funder({ fundBurner: async () => ({ funded: false, reason: "old" }) }));
    s.registerShieldedFunder(funder({ fundBurner: async () => ({ funded: true, reason: "new" }) }));
    expect((await s.fundViaShield("0xb", 1n)).reason).to.equal("new");
  });
});

describe("the device-local note store", () => {
  const note = (nullifier: string, value = "100") => ({ nullifier, value, spent: false }) as any;

  it("adopts a note this device did not deposit", async () => {
    // A batched shielded PAYOUT: the vault's keeper made the deposit and the
    // recipient derives their tree position afterwards. It lands in the same
    // store as customer-side notes, so a driver's shielded earnings spend
    // through the path a customer's funding already uses.
    const s = await freshShield();
    s.adoptShieldedNote(note("n1"));
    expect(JSON.parse(localStorage.getItem("fare.shield.notes")!)).to.have.length(1);
  });

  it("is idempotent — claiming twice does not duplicate the note", async () => {
    // A claim can be retried (the UI offers it, and a failed submit invites a
    // second press). Two records with the same nullifier means the second spend
    // is rejected as a double-spend, and the note looks stolen.
    const s = await freshShield();
    s.adoptShieldedNote(note("n1"));
    s.adoptShieldedNote(note("n1"));
    expect(JSON.parse(localStorage.getItem("fare.shield.notes")!), "a repeated claim duplicated the note")
      .to.have.length(1);
  });

  it("keeps distinct notes side by side", async () => {
    const s = await freshShield();
    s.adoptShieldedNote(note("n1"));
    s.adoptShieldedNote(note("n2"));
    const stored = JSON.parse(localStorage.getItem("fare.shield.notes")!);
    expect(stored.map((n: any) => n.nullifier)).to.deep.equal(["n1", "n2"]);
  });

  it("survives a corrupted store instead of throwing", async () => {
    // These secrets are the only record a deposit happened. A half-written
    // value must not take the wallet screen down on render — and adopting into
    // a corrupt store must recover rather than compound it.
    const s = await freshShield();
    localStorage.setItem("fare.shield.notes", "{not json");
    s.adoptShieldedNote(note("n1"));
    expect(JSON.parse(localStorage.getItem("fare.shield.notes")!)).to.have.length(1);
  });
});

// ── the Kusama Shield backend ───────────────────────────────────────────────
//
// Constructed directly rather than through `initShieldedFunder`, which reads
// `import.meta.env` — vitest does not populate that, so a test going through it
// could never reach the class. What is worth driving here is the withdrawal: it
// is the only path that actually funds a burner, and it has to survive a
// documented quirk of somebody else's system.

describe("the Kusama Shield funder", () => {
  const POOL = "0x" + "aa".repeat(20);
  const RELAY = "https://relay.example";
  const BURNER = "0x" + "b1".repeat(20);

  let balance = 0n;
  let posts: { url: string; body: any }[] = [];

  /// The burner's balance is ground truth — the funder confirms by EFFECT
  /// rather than by the returned hash, because the load-balanced RPC may not
  /// resolve the relay's transaction.
  const provider = {
    getBalance: async () => balance,
    getBlockNumber: async () => 100,
  } as any;

  /// /health first, then /shield-withdraw. `sequence` drives the retry.
  function stubFetch(sequence: number[], health: any = { shieldFeePAS: "0", relay: "0xrelay" }) {
    let call = 0;
    (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => health } as any;
      posts.push({ url: u, body: JSON.parse(init.body) });
      const status = sequence[Math.min(call++, sequence.length - 1)];
      // The balance must rise AFTER the funder captures its baseline, or it
      // never observes a change and polls the full 24 s — which is exactly the
      // shape of the bug this confirm-by-effect loop exists to tolerate.
      if (status === 200) setTimeout(() => { balance += 1n; }, 100);
      return {
        ok: status === 200, status,
        json: async () => (status === 200 ? { txHash: "0xwd" } : { error: "unknown root", retry: true }),
      } as any;
    });
  }

  /// A funder with one spendable note, adopted the way a shielded payout arrives.
  async function funderWithNote(value = 10n ** 20n) {
    vi.resetModules();
    memoryLocalStorage();
    const s = await import("./shield");
    if (value > 0n) {
      s.adoptShieldedNote({ nullifier: "n1", value: value.toString(), spent: false } as any);
    }
    return new s.KusamaShieldFunder(POOL, provider, () => null, () => RELAY);
  }

  beforeEach(() => {
    balance = 0n;
    posts = [];
    poolStub.buildWithdrawal.mockClear();
    poolStub.recordChangeNote.mockClear();
    // The funder polls the burner's balance every 2 s for 24 s. Auto-advancing
    // fake time keeps that real behaviour without paying for it in wall clock.
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 20 });
  });
  afterEach(() => vi.useRealTimers());

  it("is available only while it holds an unspent note", async () => {
    expect(await (await funderWithNote()).available()).to.equal(true);
    expect(
      await (await funderWithNote(0n)).available(),
      "claimed it could fund with an empty note store"
    ).to.equal(false);
  });

  it("refuses without a relay, since the withdrawal needs submitting", async () => {
    vi.resetModules();
    memoryLocalStorage();
    const s = await import("./shield");
    s.adoptShieldedNote({ nullifier: "n1", value: "100", spent: false } as any);
    const f = new s.KusamaShieldFunder(POOL, provider, () => null, () => undefined);
    await expect(f.fundBurner(BURNER, 1n)).rejects.toThrow(/needs a relay/);
  });

  it("refuses when no note is large enough", async () => {
    // Notes are spent whole. Asking for more than any single note holds has to
    // fail with a message that says to deposit, not with an opaque proof error.
    const f = await funderWithNote(10n);
    stubFetch([200]);
    await expect(f.fundBurner(BURNER, 10n ** 18n)).rejects.toThrow(/no shielded note/);
  });

  it("retries against a fresh root when the relay 409s (KS Issue 4)", async () => {
    // The pool keeps a 16-entry root window. A proof built against a root that
    // falls out of it before mining is rejected — a race, not a failure — and
    // the fix is to rebuild. Without the retry, a busy pool makes shielded
    // funding fail intermittently and inexplicably.
    const f = await funderWithNote();
    stubFetch([409, 409, 200]);

    const r = await f.fundBurner(BURNER, 10n);
    expect(r.funded).to.equal(true);
    expect(posts, "did not retry an evicted root").to.have.length(3);
    // Each attempt must build a NEW withdrawal — resubmitting the same proof
    // would hit the same evicted root forever.
    expect(poolStub.buildWithdrawal.mock.calls.length, "resubmitted a stale proof").to.equal(3);
  });

  it("gives up after three evicted roots rather than looping", async () => {
    const f = await funderWithNote();
    stubFetch([409]);
    await expect(f.fundBurner(BURNER, 10n)).rejects.toThrow(/evicted root/);
    expect(posts).to.have.length(3);
  });

  it("directs the withdrawal at the burner in sponsor mode", async () => {
    // With no relay fee the pool pays the burner directly, so no main→burner
    // edge exists anywhere — the entire point of the module.
    const f = await funderWithNote();
    stubFetch([200], { shieldFeePAS: "0", relay: "0xrelay" });

    await f.fundBurner(BURNER, 10n);
    expect(posts[0].body.recipient).to.equal(BURNER);
    expect(posts[0].body.burner).to.equal(BURNER);
  });

  it("directs it at the RELAY in fee mode, and covers the fee on top", async () => {
    // Fee mode pays the relay, which forwards the remainder — so the withdrawal
    // must be sized amount + fee, or the burner receives short by exactly the
    // fee and the order fails for want of escrow.
    const f = await funderWithNote();
    stubFetch([200], { shieldFeePAS: "0.5", relay: "0xrelayaddr" });

    await f.fundBurner(BURNER, 10n ** 18n);
    expect(posts[0].body.recipient, "fee mode paid the burner, not the relay").to.equal("0xrelayaddr");
    // buildWithdrawal(provider, pool, note, recipient, withdrawnValue)
    expect(
      poolStub.buildWithdrawal.mock.calls[0][4],
      "the fee was not added on top of the burner's amount"
    ).to.equal(10n ** 18n + 5n * 10n ** 17n);
  });

  it("marks the note spent once the withdrawal is accepted", async () => {
    // A note left unspent in the store is offered again, and the second spend
    // is rejected as a double-spend — which looks like theft rather than a
    // bookkeeping slip.
    const f = await funderWithNote();
    stubFetch([200]);
    await f.fundBurner(BURNER, 10n);
    const stored = JSON.parse(localStorage.getItem("fare.shield.notes")!);
    expect(stored[0].spent, "the spent note is still on offer").to.equal(true);
  });
});
