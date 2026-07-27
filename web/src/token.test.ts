import { describe, it, expect, vi } from "vitest";

// Stablecoin asset resolution and amount handling (TEST-PLAN D2).
//
// One UI renders both currencies, and the only thing separating "10 USDC" from
// "0.00000000001 USDC" is which `decimals` this module resolved. A 6-vs-18
// mistake here does not throw — it renders a plausible number and escrows the
// wrong amount, which is the worst failure shape money code has.
//
// The address book is stubbed with a stablecoin present so the token branch is
// reachable at all; with none deployed, `assetOf` returns native for
// everything and every assertion below would be vacuously about PAS.

vi.mock("./chain", () => ({
  ADDRESSES: {
    stablecoin: "0x71FFC15a6961B655Cd3bE34Ef65361f78e6E8620",
    vault: "0x" + "11".repeat(20),
  },
  readProvider: {},
  CHAIN_ID: 420420417,
}));

// The eager on-chain symbol/decimals read must not run: it would reject against
// the stub provider and, more to the point, this file is about the SYNCHRONOUS
// seed values the UI renders before any read completes.
vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  return {
    ...actual,
    Contract: vi.fn(function () {
      return { symbol: async () => { throw new Error("no chain in this test"); } };
    }),
  };
});

import { assetOf, fmtAsset, parseAsset, tokenOrdersEnabled, stablecoinAsset } from "./token";

const USDC = "0x71FFC15a6961B655Cd3bE34Ef65361f78e6E8620";
const NATIVE = "0x0000000000000000000000000000000000000000";

describe("asset resolution", () => {
  it("treats a missing or zero token as native PAS", () => {
    // `address(0)` is the protocol's native sentinel, and an order struct read
    // back from the chain always carries it — so both spellings must land on
    // 18 decimals, not just the undefined one a fresh form produces.
    for (const t of [undefined, NATIVE]) {
      const a = assetOf(t);
      expect(a.isToken).to.equal(false);
      expect(a.decimals).to.equal(18);
      expect(a.symbol).to.equal("PAS");
    }
  });

  it("resolves the configured stablecoin at 6 decimals, whatever the casing", () => {
    // Addresses come checksummed from the chain and lowercased from storage. A
    // case-sensitive compare would silently fall through to the unknown-token
    // default below — which is 18 decimals, i.e. a million-fold error.
    for (const form of [USDC, USDC.toLowerCase(), USDC.toUpperCase().replace("0X", "0x")]) {
      const a = assetOf(form);
      expect(a.isToken, `${form} did not resolve as the stablecoin`).to.equal(true);
      expect(a.decimals).to.equal(6);
    }
  });

  it("falls back to 18 decimals for a token it does not know", () => {
    const a = assetOf("0x" + "ab".repeat(20));
    expect(a.isToken).to.equal(true);
    expect(a.decimals).to.equal(18);
    expect(a.symbol).to.equal("TOKEN");
  });

  it("reports token orders as available when the book has a stablecoin", () => {
    expect(tokenOrdersEnabled()).to.equal(true);
    expect(stablecoinAsset()?.address).to.equal(USDC);
  });
});

describe("amounts, at the asset's decimals", () => {
  it("formats the same integer differently for PAS and USDC", () => {
    // The whole point of the module in one assertion: 10^6 is a millionth of a
    // PAS and exactly one USDC.
    expect(fmtAsset(1_000_000n, USDC)).to.equal("1 USDC");
    expect(fmtAsset(1_000_000n, NATIVE)).to.equal("0 PAS"); // 1e-12, trimmed to nothing
    expect(fmtAsset(10n ** 18n, NATIVE)).to.equal("1 PAS");
  });

  it("round-trips through parse and format", () => {
    for (const [v, token] of [["10", USDC], ["0.5", USDC], ["1", NATIVE], ["0.25", NATIVE]] as const) {
      expect(fmtAsset(parseAsset(v, token), token)).to.equal(`${v} ${assetOf(token).symbol}`);
    }
  });

  it("parses an empty field as zero rather than throwing", () => {
    // A cleared input is the normal state of a form mid-edit; `parseUnits("")`
    // throws, and an uncaught throw there takes the checkout screen down.
    expect(parseAsset("", USDC)).to.equal(0n);
    expect(parseAsset("", NATIVE)).to.equal(0n);
  });

  it("trims display to four decimals without rounding up", () => {
    // Truncation, not rounding: showing a user more than they have is worse
    // than showing slightly less, and the escrow figure must never read high.
    expect(fmtAsset(1_234_567n, USDC)).to.equal("1.2345 USDC");
    expect(fmtAsset(1_999_999n, USDC)).to.equal("1.9999 USDC");
  });

  it("drops trailing zeros but keeps a bare zero", () => {
    expect(fmtAsset(0n, USDC)).to.equal("0 USDC");
    expect(fmtAsset(2_500_000n, USDC)).to.equal("2.5 USDC");
    expect(fmtAsset(3_000_000n, USDC)).to.equal("3 USDC");
  });

  it("parses a 6-decimal amount without silently truncating precision", () => {
    expect(parseAsset("1.234567", USDC)).to.equal(1_234_567n);
    // One digit past what the token can hold is a user error the parser must
    // reject rather than round away — the amount would otherwise be escrowed
    // as something the user did not type.
    expect(() => parseAsset("1.2345678", USDC)).to.throw();
  });
});
