// Relay profitability-guard math (F6/F8). Run: npm test (node --test, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rebateWei, withdrawFeeWei, coversCost, withinBudget, windowSpent, tokenToNativeWei } from "./economics.mjs";

const PAS = (n) => BigInt(Math.round(n * 1e6)) * (10n ** 12n); // n PAS → wei (18dp)
const USDC = (n) => BigInt(Math.round(n * 1e6)); // n USDC → wei (6dp)

test("tokenToNativeWei: value a USDC rebate in PAS at a price (the currency fix)", () => {
  // 1 USDC = 0.5 PAS.  0.01875 USDC → 0.009375 PAS.
  assert.equal(tokenToNativeWei(USDC(0.01875), 6, 18, 1n, 2n), PAS(0.009375));
  // 1 USDC = 4 PAS.  1 USDC → 4 PAS (decimals bridged 6→18).
  assert.equal(tokenToNativeWei(USDC(1), 6, 18, 4n, 1n), PAS(4));
  // same decimals, price 1 → identity
  assert.equal(tokenToNativeWei(1000n, 18, 18, 1n, 1n), 1000n);
  // this is what the guard now compares: a token rebate valued in native vs gas.
  // 0.01875 USDC @ 1 USDC=0.5 PAS = 0.009375 PAS; against ~0.088 PAS gas → does NOT cover.
  assert.equal(coversCost(tokenToNativeWei(USDC(0.01875), 6, 18, 1n, 2n), PAS(0.088), 1.0), false);
});

test("rebateWei: fare · feeBps · relayRebateBps / 1e8 (deployed 250/2000)", () => {
  // 0.4 PAS fare, 2.5% fee, 20% rebate → 0.4 · 0.025 · 0.20 = 0.002 PAS
  assert.equal(rebateWei(PAS(0.4), 250, 2000), PAS(0.002));
  assert.equal(rebateWei(0n, 250, 2000), 0n); // zero fare → zero rebate
});

test("withdrawFeeWei: balance · withdrawFeeBps / 1e4 (deployed 100 = 1%)", () => {
  assert.equal(withdrawFeeWei(PAS(5), 100), PAS(0.05));
  assert.equal(withdrawFeeWei(PAS(5), 0), 0n); // fee disabled → nothing
});

test("coversCost: reward ≥ cost × margin, at the boundary", () => {
  // margin 1.25: reward 125 covers cost 100 exactly; 124 does not
  assert.equal(coversCost(125n, 100n, 1.25), true);
  assert.equal(coversCost(124n, 100n, 1.25), false);
  // break-even margin 1.0
  assert.equal(coversCost(100n, 100n, 1.0), true);
  assert.equal(coversCost(99n, 100n, 1.0), false);
});

test("coversCost: an unprofitable settlement (tiny rebate vs real gas) is declined", () => {
  const rebate = PAS(0.002); // 0.5% of a 0.4 PAS fare
  const gas = PAS(0.05); // cumulative fare gas
  assert.equal(coversCost(rebate, gas, 1.25), false);
});

test("withinBudget: no-reward spend fits until the window budget is exhausted", () => {
  const budget = PAS(10);
  assert.equal(withinBudget(PAS(9), PAS(0.5), budget), true);
  assert.equal(withinBudget(PAS(9.8), PAS(0.5), budget), false); // 10.3 > 10
  assert.equal(withinBudget(0n, PAS(10), budget), true); // exactly the cap
});

test("windowSpent: resets after the window elapses", () => {
  const win = { spent: PAS(7), start: 1000 };
  assert.equal(windowSpent(win, 1000 + 500, 1000), PAS(7)); // within window
  assert.equal(windowSpent(win, 1000 + 2000, 1000), 0n); // elapsed → reset
  assert.equal(win.spent, 0n);
});
