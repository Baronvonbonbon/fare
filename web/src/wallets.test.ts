import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Wallet } from "ethers";

// Per-order burner wallets (TEST-PLAN D2).
//
// This is the customer's primary protection: every order is created from a
// FRESH wallet, so consecutive orders share no on-chain identity and a home is
// not derivable from "person X's orders" (docs/PRIVACY.md risk #3).
//
// The failure that matters is silent. If two orders ever came from the same
// address, nothing breaks, no error surfaces, and the app keeps working
// perfectly — while the exact linkage the design exists to prevent is now
// permanent and public. So the first thing asserted here is a NUMBER: mint many,
// count distinct.
//
// The sweep is the other half. It is the one operation that deliberately
// re-links burners to a main address, and its arithmetic has a Paseo-specific
// rounding rule that a naive change would quietly drop.

// ── the chain module, replaced ──────────────────────────────────────────────
// wallets.ts imports a live provider and contract handles from ./chain. Mocked
// wholesale: none of it is under test here, and importing it for real builds
// providers and reads the address book.
const { vaultStub, providerStub } = vi.hoisted(() => ({
  vaultStub: {
    balanceOf: vi.fn(async () => 0n),
    withdraw: vi.fn(async () => ({ wait: async () => ({}) })),
  },
  providerStub: { getBalance: vi.fn(async () => 0n) },
}));

vi.mock("./chain", () => ({
  sendProvider: providerStub,
  contracts: (runner: any) => ({ runner }),
  ADDRESSES: { vault: "0x000000000000000000000000000000000000dEaD" },
}));

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  // Only the vault handle is faked; Wallet and the helpers stay real, because
  // key derivation is the thing under test and a stubbed Wallet would assert
  // nothing about it. A `function` and not an arrow: this is invoked with
  // `new`, and returning an object from a constructor is what swaps in the stub.
  return { ...actual, Contract: vi.fn(function () { return vaultStub; }) };
});

import {
  newOrderWallet,
  orderWallets,
  orderWalletAddresses,
  walletFor,
  sweepToMain,
} from "./wallets";

function memoryLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
  return m;
}

const PAS = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

describe("per-order burner wallets", () => {
  let store: Map<string, string>;
  let sent: { to: string; value: bigint }[];

  beforeEach(() => {
    store = memoryLocalStorage();
    sent = [];
    vaultStub.balanceOf.mockResolvedValue(0n);
    vaultStub.withdraw.mockClear();
    providerStub.getBalance.mockResolvedValue(0n);

    // Capture outbound transfers instead of broadcasting them. The Wallet is
    // real, so the signing key and the sender address are real too.
    vi.spyOn(Wallet.prototype, "sendTransaction").mockImplementation(async function (
      this: Wallet,
      tx: any
    ) {
      sent.push({ to: tx.to, value: tx.value });
      return { hash: "0x" + "11".repeat(32), wait: async () => ({}) } as any;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  // ── the linkability claim, as a number ────────────────────────────────────

  // Key generation is deliberately expensive, and 100 of them under coverage
  // instrumentation runs long enough to trip the default timeout — hence the
  // explicit one. A determinism bug would show at N=2; the larger N is guarding
  // against a subtle cycle, not against the obvious case.
  it("mints a distinct identity every single time", { timeout: 60_000 }, () => {
    const N = 100;
    const addrs = new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < N; i++) {
      const w = newOrderWallet();
      addrs.add(w.address.toLowerCase());
      keys.add(w.privateKey);
    }
    expect(addrs.size, "two orders shared an address — they are now linked on chain").to.equal(N);
    expect(keys.size, "two burners shared a key").to.equal(N);
    expect(orderWallets()).to.have.length(N);
  });

  it("every stored key actually derives the address stored beside it", () => {
    // A record whose key and address disagree is unrecoverable: the order can
    // never be cancelled, tipped, or accepted from, and the failure only
    // appears later as an inexplicable `not-customer` revert.
    for (let i = 0; i < 25; i++) newOrderWallet();
    for (const rec of orderWallets()) {
      expect(new Wallet(rec.key).address).to.equal(rec.address);
    }
  });

  it("the returned signer is bound to the broadcast provider, not a read one", async () => {
    // Local-key wallets cannot broadcast through a light client, so the signer
    // has to carry the send provider or every order fails at submission.
    const w = newOrderWallet();
    expect(w.provider).to.equal(providerStub);
  });

  it("persists across a reload, and survives a corrupted registry", async () => {
    const a = newOrderWallet().address;
    const b = newOrderWallet().address;
    expect(orderWalletAddresses()).to.deep.equal(new Set([a.toLowerCase(), b.toLowerCase()]));

    // A half-written localStorage value must not take the app down — it should
    // read as "no wallets yet" rather than throwing on every render.
    store.set("fare.customer.wallets", "{not json");
    expect(orderWallets()).to.deep.equal([]);
    expect(orderWalletAddresses().size).to.equal(0);
  });

  // ── lookup ────────────────────────────────────────────────────────────────

  it("finds the signer for an order whatever the address casing", () => {
    // Addresses arrive from the chain checksummed and from storage as typed;
    // a case-sensitive lookup would lose orders on one path and not the other.
    const w = newOrderWallet();
    for (const form of [w.address, w.address.toLowerCase(), w.address.toUpperCase().replace("0X", "0x")]) {
      const found = walletFor(form);
      expect(found, `no wallet found for ${form}`).to.not.equal(null);
      expect(found!.address).to.equal(w.address);
    }
    expect(walletFor("0x" + "ab".repeat(20))).to.equal(null);
  });

  // ── the sweep ─────────────────────────────────────────────────────────────

  it("rounds the swept amount DOWN to a whole micro-PAS", async () => {
    // Paseo's eth-rpc rejects a transfer whose value % 1e6 lands in
    // [5e5, 1e6) — so the amount is floored to a whole micro-PAS. Rounding the
    // other way, or not at all, produces a send the node refuses, on the one
    // path a user takes to get their money back.
    const w = newOrderWallet();
    const dust = 999_999n; // the top of the rejected band
    providerStub.getBalance.mockResolvedValue(PAS("1") + dust);

    const steps = await sweepToMain("0x" + "cd".repeat(20), 0n);

    expect(steps).to.have.length(1);
    expect(sent).to.have.length(1);
    expect(sent[0].value).to.equal(PAS("1"), "the dust was not rounded away");
    expect(sent[0].value % 1_000_000n).to.equal(0n);
    expect(steps[0].swept).to.equal(PAS("1"));
    expect(steps[0].wallet).to.equal(w.address);
  });

  it("holds back the gas reserve, and sends nothing when the balance is under it", async () => {
    newOrderWallet();
    providerStub.getBalance.mockResolvedValue(PAS("5"));
    await sweepToMain("0x" + "cd".repeat(20), PAS("2"));
    expect(sent[0].value).to.equal(PAS("3"));

    // Under the reserve the subtraction goes negative — it must not send, and
    // must not throw either.
    sent.length = 0;
    providerStub.getBalance.mockResolvedValue(PAS("1"));
    const steps = await sweepToMain("0x" + "cd".repeat(20), PAS("2"));
    expect(sent).to.have.length(0);
    expect(steps[0].swept).to.equal(undefined);
    expect(steps[0].error).to.equal(undefined);
  });

  it("withdraws a vault balance first, and skips the call when nothing is owed", async () => {
    newOrderWallet();
    providerStub.getBalance.mockResolvedValue(0n);

    await sweepToMain("0x" + "cd".repeat(20));
    expect(vaultStub.withdraw).not.toHaveBeenCalled();

    vaultStub.balanceOf.mockResolvedValue(PAS("4"));
    const steps = await sweepToMain("0x" + "cd".repeat(20));
    expect(vaultStub.withdraw).toHaveBeenCalledTimes(1);
    expect(steps[0].withdrew).to.equal(PAS("4"));
  });

  it("never sweeps the main address into itself", async () => {
    const keep = newOrderWallet();
    newOrderWallet();
    providerStub.getBalance.mockResolvedValue(PAS("10"));

    // Sweeping to an address that is itself a burner must skip that one — a
    // self-transfer would burn gas forever and report progress that never ends.
    const steps = await sweepToMain(keep.address.toLowerCase(), 0n);
    expect(steps).to.have.length(1);
    expect(steps[0].wallet).to.not.equal(keep.address);
    expect(sent.every((s) => s.to !== keep.address)).to.equal(true);
  });

  it("one failing wallet does not abandon the rest", async () => {
    // The sweep is a recovery operation, usually run because something is
    // already wrong. Aborting the batch on the first bad wallet would strand
    // every wallet behind it.
    const a = newOrderWallet();
    const b = newOrderWallet();
    const c = newOrderWallet();
    providerStub.getBalance.mockResolvedValue(PAS("3"));
    vaultStub.balanceOf.mockImplementation(async (addr: string) =>
      addr === b.address ? Promise.reject(new Error("node exploded")) : 0n
    );

    const seen: string[] = [];
    const steps = await sweepToMain("0x" + "cd".repeat(20), 0n, (s) => seen.push(s.wallet));

    expect(steps.map((s) => s.wallet)).to.deep.equal([a.address, b.address, c.address]);
    expect(steps[1].error).to.match(/node exploded/);
    expect(steps[0].swept).to.equal(PAS("3"));
    expect(steps[2].swept, "the wallet after the failure was skipped").to.equal(PAS("3"));
    expect(seen, "the progress callback missed a step").to.have.length(3);
  });
});
