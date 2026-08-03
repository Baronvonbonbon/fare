// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { shieldedBalance, shieldedNoteValues, adoptShieldedNote } from "./shield";
import { shieldNotesFor, makeShieldNote } from "./shieldnote";
import { precompileFor } from "./shieldpool";
import { assetIdOf, nativeOrdersEnabled, tokenOrdersEnabled } from "./token";

const USDC_ID = 1337n;
const USDC_KEY = precompileFor(USDC_ID);
const USDC_PRECOMPILE = "0x0000053900000000000000000000000001200000";

const note = (value: bigint, asset?: bigint, i = 0) => ({
  nullifier: String(1000 + i), secret: String(2000 + i),
  value: value.toString(), ...(asset !== undefined ? { asset: asset.toString() } : {}),
  index: i, leftSnapshot: {}, depositBlock: 1,
}) as any;

describe("the shielded note wallet is per-asset", () => {
  beforeEach(() => localStorage.clear());

  it("keeps native and token notes in separate balances", () => {
    adoptShieldedNote(note(10n ** 18n, undefined, 1));       // 1 PAS, asset omitted
    adoptShieldedNote(note(5n * 10n ** 18n, 0n, 2));          // 5 PAS, asset explicitly 0
    adoptShieldedNote(note(25_000_000n, USDC_KEY, 3));        // 25 USDC

    expect(shieldedBalance(0n)).toBe(6n * 10n ** 18n);
    expect(shieldedBalance(USDC_KEY)).toBe(25_000_000n);
  });

  it("treats an omitted asset as native", () => {
    // Notes written before multi-asset support have no `asset` field at all.
    // Reading them as anything but native would strand them.
    adoptShieldedNote(note(10n ** 18n, undefined, 1));
    expect(shieldedBalance(0n)).toBe(10n ** 18n);
    expect(shieldedNoteValues(0n)).toEqual([10n ** 18n]);
  });

  it("does not let a USDC note count toward a native balance", () => {
    // THE BUG THIS GUARDS. Token notes reach the same device store through
    // spendShieldNote → adoptShieldedNote. Before filtering, a wallet holding
    // only USDC reported native funding as available and then failed at the pick.
    adoptShieldedNote(note(100_000_000n, USDC_KEY, 1)); // 100 USDC
    expect(shieldedBalance(0n)).toBe(0n);
    expect(shieldedNoteValues(0n)).toEqual([]);
    expect(shieldedBalance(USDC_KEY)).toBe(100_000_000n);
  });

  it("ignores spent notes", () => {
    adoptShieldedNote({ ...note(10n ** 18n, 0n, 1), spent: true });
    adoptShieldedNote(note(10n ** 18n, 0n, 2));
    expect(shieldedBalance(0n)).toBe(10n ** 18n);
  });

  it("reports note denominations, not just a total", () => {
    // The crowd a spend hides in is per-denomination, so a payee needs to see
    // the rungs, not one summed figure.
    adoptShieldedNote(note(5_000_000n, USDC_KEY, 1));
    adoptShieldedNote(note(1_000_000n, USDC_KEY, 2));
    adoptShieldedNote(note(1_000_000n, USDC_KEY, 3));
    expect(shieldedNoteValues(USDC_KEY)).toEqual([1_000_000n, 1_000_000n, 5_000_000n]);
  });
});

describe("vault note filtering is per-asset too", () => {
  beforeEach(() => localStorage.clear());

  it("separates native and token vault notes", () => {
    // These live in a DIFFERENT store from the pool notes above (vault tree vs
    // pool tree) but have the same hazard: one list, several trees.
    const key = "fare.shield.notes.zk";
    const nativeNote = makeShieldNote(10n ** 18n);
    const tokenNote = makeShieldNote(1_000_000n, USDC_PRECOMPILE);
    localStorage.setItem(key, JSON.stringify([nativeNote, tokenNote]));

    expect(shieldNotesFor()).toEqual([nativeNote]);
    expect(shieldNotesFor(USDC_PRECOMPILE)).toEqual([tokenNote]);
    // Case-insensitive: address books and events disagree on checksum casing.
    expect(shieldNotesFor(USDC_PRECOMPILE.toUpperCase().replace("0X", "0x"))).toEqual([tokenNote]);
  });

  it("does not tag a native note with an asset", () => {
    // A stray `token` field would send it to the wrong tree.
    expect(makeShieldNote(10n ** 18n).token).toBeUndefined();
    expect(makeShieldNote(10n ** 18n, "0x0000000000000000000000000000000000000000").token).toBeUndefined();
  });
});

describe("asset id derivation", () => {
  it("reads the id out of an ERC-20 precompile address", () => {
    expect(assetIdOf(USDC_PRECOMPILE)).toBe(1337n);
    expect(assetIdOf("0x000007C000000000000000000000000001200000")).toBe(1984n); // USDt
  });

  it("returns null for an ordinary contract, which has no asset id", () => {
    expect(assetIdOf("0x1234567890123456789012345678901234567890")).toBe(null);
    expect(assetIdOf("0x0000000000000000000000000000000000000000")).toBe(null);
  });

  it("round-trips through precompileFor", () => {
    // The pair that must never disagree: depositAsset takes the ID, the note
    // commitment carries the ADDRESS.
    const id = assetIdOf(USDC_PRECOMPILE)!;
    expect(precompileFor(id)).toBe(BigInt(USDC_PRECOMPILE));
  });
});

describe("checkout asset gating", () => {
  it("hides the native option when a stablecoin is deployed", () => {
    // Without VITE_ALLOW_NATIVE_ORDERS set, a deployment with a stablecoin
    // offers only the stablecoin — a free choice splits the anonymity set and
    // lets a customer pick the smaller crowd without knowing.
    if (tokenOrdersEnabled()) expect(nativeOrdersEnabled()).toBe(false);
    else expect(nativeOrdersEnabled()).toBe(true); // nothing else to pay with
  });
});
