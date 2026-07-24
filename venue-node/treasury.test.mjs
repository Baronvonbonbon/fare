// Relay treasury / fee-recovery swap planning (pure logic). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFraction, rebateInNative, shouldTopUp, planSwap, topUpCycle } from "./treasury.mjs";

const PAS = (n) => BigInt(Math.round(n * 1e6)) * (10n ** 12n); // 18dp
const USDC = (n) => BigInt(Math.round(n * 1e6)); // 6dp

test("priceFraction: decimal string → exact fraction", () => {
  assert.deepEqual(priceFraction("0.5"), { num: 5n, den: 10n });
  assert.deepEqual(priceFraction("4"), { num: 4n, den: 1n });
  assert.deepEqual(priceFraction("1.25"), { num: 125n, den: 100n });
  assert.equal(priceFraction(""), null); // unset → no price
});

test("rebateInNative: uses an explicit quote, or null without a price", () => {
  // 0.01875 USDC @ 1 USDC = 0.5 PAS → 0.009375 PAS
  assert.equal(rebateInNative(USDC(0.01875), 6, 18, { num: 1n, den: 2n }), PAS(0.009375));
  // no quote and no config price → null (caller must decline, can't prove coverage)
  assert.equal(rebateInNative(USDC(1), 6, 18, undefined), null);
});

test("shouldTopUp: below floor triggers", () => {
  assert.equal(shouldTopUp(PAS(40), PAS(50)), true);
  assert.equal(shouldTopUp(PAS(60), PAS(50)), false);
});

test("planSwap: swaps enough token to reach target, capped by fee balance + min", () => {
  const price = { num: 1n, den: 2n }; // 1 USDC = 0.5 PAS
  // gas 40, target 200 → deficit 160 PAS → need 320 USDC at 0.5 PAS/USDC
  const p = planSwap({ gasWei: PAS(40), feeTokenWei: USDC(1000), tokenDecimals: 6, nativeDecimals: 18, price, target: PAS(200), minSwapToken: 0n });
  assert.equal(p.swapTokenWei, USDC(320));
  assert.equal(p.wantNativeWei, PAS(160));

  // capped by available fees: only 50 USDC on hand → swap 50, get 25 PAS
  const cap = planSwap({ gasWei: PAS(40), feeTokenWei: USDC(50), tokenDecimals: 6, nativeDecimals: 18, price, target: PAS(200), minSwapToken: 0n });
  assert.equal(cap.swapTokenWei, USDC(50));
  assert.equal(cap.wantNativeWei, PAS(25));

  // above target → nothing to do
  assert.equal(planSwap({ gasWei: PAS(250), feeTokenWei: USDC(1000), tokenDecimals: 6, nativeDecimals: 18, price, target: PAS(200) }), null);
  // below min-swap → skip dust
  assert.equal(planSwap({ gasWei: PAS(199), feeTokenWei: USDC(1000), tokenDecimals: 6, nativeDecimals: 18, price, target: PAS(200), minSwapToken: USDC(100) }), null);
  // no price → null
  assert.equal(planSwap({ gasWei: PAS(40), feeTokenWei: USDC(1000), tokenDecimals: 6, nativeDecimals: 18, price: null }), null);
});

test("topUpCycle: plans but does not execute when swaps are disabled", async () => {
  const ctx = {
    tokenDecimals: 6, nativeDecimals: 18,
    nativeBalance: async () => PAS(40),
    feeTokenBalance: async () => USDC(1000),
    // no ctx.execute + SWAP_ENABLED off → planned, not executed
  };
  // config price via env for this cycle
  process.env.RELAY_TOKEN_PRICE = "0.5";
  const r = await topUpCycle(ctx);
  delete process.env.RELAY_TOKEN_PRICE;
  assert.equal(r.executed, false);
  assert.ok(r.planned && r.planned.swapTokenWei > 0n);
});
