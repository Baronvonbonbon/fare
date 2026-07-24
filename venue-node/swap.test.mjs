// Asset-conversion coverage-swap planning (pure logic). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCoverage, buildSwapDescriptor, assetLoc, NATIVE_LOC, fallbackAccountId, RUNTIME_PALLETS_ADDR, scaleAmount } from "./swap.mjs";

const PAS = (n) => BigInt(Math.round(n * 1e6)) * (10n ** 12n); // 18dp (EVM view)
const USDC = (n) => BigInt(Math.round(n * 1e6));               // 6dp
const price = { num: 1n, den: 4n }; // 1 USDC = 0.25 PAS (live pool ~0.2496)

test("planCoverage: swaps enough PAS to buy the exact fare+tip in USDC", () => {
  // need 5 USDC → at 0.25 PAS/USDC = 1.25 PAS mid; +1% slippage = 1.2625 PAS max in
  const p = planCoverage({
    haveNativeWei: PAS(10), needTokenWei: USDC(5), gasReserveNativeWei: PAS(1),
    tokenDecimals: 6, nativeDecimals: 18, price,
  });
  assert.equal(p.ok, true);
  assert.equal(p.method, "swapTokensForExactTokens");
  assert.equal(p.amountOut, USDC(5));
  assert.equal(p.needNativeEstWei, PAS(1.25));
  assert.equal(p.amountInMax, PAS(1.25) * 10100n / 10000n); // +1%
  assert.equal(p.keepNativeWei, PAS(10) - p.amountInMax);   // ≥ gas reserve
  assert.ok(p.keepNativeWei >= PAS(1));
});

test("planCoverage: underfunded burner → ok:false with the shortfall", () => {
  // have 1 PAS, reserve 0.9 for gas → 0.1 spendable, but need ~1.2625 PAS of swap
  const p = planCoverage({
    haveNativeWei: PAS(1), needTokenWei: USDC(5), gasReserveNativeWei: PAS(0.9),
    tokenDecimals: 6, nativeDecimals: 18, price,
  });
  assert.equal(p.ok, false);
  const maxIn = PAS(1.25) * 10100n / 10000n;
  assert.equal(p.shortfallNativeWei, maxIn - PAS(0.1));
});

test("planCoverage: nothing to cover (native-only order) → null", () => {
  assert.equal(planCoverage({ haveNativeWei: PAS(10), needTokenWei: 0n, tokenDecimals: 6, nativeDecimals: 18, price }), null);
});

test("planCoverage: no price → null (cannot plan)", () => {
  assert.equal(planCoverage({ haveNativeWei: PAS(10), needTokenWei: USDC(5), tokenDecimals: 6, nativeDecimals: 18, price: null }), null);
});

test("planCoverage: below min-swap dust threshold → null", () => {
  const p = planCoverage({
    haveNativeWei: PAS(10), needTokenWei: USDC(0.001), gasReserveNativeWei: 0n,
    tokenDecimals: 6, nativeDecimals: 18, price, minSwapNativeWei: PAS(0.1),
  });
  assert.equal(p, null);
});

test("buildSwapDescriptor: PAS→token exact-out call for the mapped burner", () => {
  const p = planCoverage({ haveNativeWei: PAS(10), needTokenWei: USDC(5), gasReserveNativeWei: PAS(1), tokenDecimals: 6, nativeDecimals: 18, price });
  const d = buildSwapDescriptor(p, { assetId: 1337, sendTo: "5FburnerMapped" });
  assert.equal(d.pallet, "assetConversion");
  assert.equal(d.method, "swapTokensForExactTokens");
  assert.deepEqual(d.args.path, [NATIVE_LOC, assetLoc(1337)]);
  assert.equal(d.args.amountOut, USDC(5).toString());
  assert.equal(d.args.sendTo, "5FburnerMapped");
  assert.equal(d.args.keepAlive, false);
});

test("buildSwapDescriptor: refuses a non-ok plan", () => {
  assert.throws(() => buildSwapDescriptor({ ok: false }, { assetId: 1337, sendTo: "x" }), /plan not ok/);
});

test("scaleAmount: EVM 18-dp native → substrate 10-dp (round up bounds)", () => {
  assert.equal(scaleAmount(PAS(1.26), 18, 10), 12600000000n);          // 1.26 PAS in 10-dp
  assert.equal(scaleAmount(1260622204970000000n, 18, 10, true), 12606222050n); // ceil upper bound
  assert.equal(scaleAmount(1260622204970000000n, 18, 10, false), 12606222049n); // truncated
  assert.equal(scaleAmount(USDC(5), 6, 6), USDC(5));                   // same base → unchanged
  assert.equal(scaleAmount(5n, 6, 18), 5n * 10n ** 12n);              // up-scale
});

test("RUNTIME_PALLETS_ADDR is the PalletId('py/paddr') sentinel", () => {
  // ascii "modlpy/paddr" + zero pad — matches revive lib.rs RUNTIME_PALLETS_ADDR.
  assert.equal(RUNTIME_PALLETS_ADDR, "0x6d6f646c70792f70616464720000000000000000");
  assert.equal(Buffer.from(RUNTIME_PALLETS_ADDR.slice(2, 26), "hex").toString(), "modlpy/paddr");
});

test("fallbackAccountId: H160 ++ 0xEE×12 (revive fallback origin)", () => {
  const h160 = "0x1234567890abcdef1234567890abcdef12345678";
  assert.equal(fallbackAccountId(h160), "0x1234567890abcdef1234567890abcdef12345678" + "ee".repeat(12));
  assert.equal(fallbackAccountId(h160.toUpperCase().replace("0X", "0x")).length, 66); // 32-byte AccountId32
  assert.throws(() => fallbackAccountId("0xdeadbeef"), /bad H160/);
});
