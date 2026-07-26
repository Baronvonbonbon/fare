// Relay break-even (TEST-PLAN A2). Run: npm test (node --test, no deps).
//
// economics.test.mjs covers the profitability GUARD — given a reward and a
// cost, does it clear the margin. This covers the economics the guard encodes:
// at what fare does running a relay stop losing money, given the parameters
// actually deployed?
//
// That is not a rhetorical question. REMAINING-ACTIONS §1 already warns that
// "with real (tiny) testnet fares the relay will decline settlement (rebate ≪
// gas)". This puts a number on it, from measured gas rather than a guess:
// gas-snapshot.json for the settlement paths, and Paseo's 1000 gwei.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rebateWei, coversCost, breakEvenFareWei } from "./economics.mjs";

const PAS = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const fmt = (wei) => (Number(wei / 10n ** 12n) / 1e6).toFixed(4);

// ── the deployed configuration ───────────────────────────────────────────────
// From REMAINING-ACTIONS §"Live status": relayRebateBps=2000, withdrawFeeBps=100.
// feeBps is the protocol fee the rebate is carved from.
const DEPLOYED = { feeBps: 250, relayRebateBps: 2000, withdrawFeeBps: 100, marginDefault: 1.25 };

// Paseo charges 1000 gwei (measure-costs.mjs and the live e2e runs).
const GAS_PRICE = 1_000n * 10n ** 9n;

// Measured, not estimated — the committed snapshot from test/gas-snapshot.test.ts.
const SNAP = JSON.parse(
  readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "gas-snapshot.json"), "utf8")
);
// What a relay actually fronts for one delivery: the pickup it sponsors with no
// reward, plus the dropoff it settles for the rebate. The dropoff row is
// measured against the mock verifier, so the real Groth16 verify is added back.
const PICKUP_GAS = BigInt(SNAP["settlement.confirmPickup"]);
const DROPOFF_GAS = BigInt(SNAP["settlement.confirmDropoffZK"]) + BigInt(SNAP["FareLocationVerifier.verifyProximity"]);
const PER_ORDER_GAS = PICKUP_GAS + DROPOFF_GAS;
const PER_ORDER_COST = PER_ORDER_GAS * GAS_PRICE;

// ── the inverse is exact ─────────────────────────────────────────────────────

test("breakEvenFareWei is the exact least fare that clears the guard", () => {
  // The property that makes the number trustworthy: at the break-even fare the
  // guard passes, and one wei below it fails. Checked across a spread of costs,
  // margins and parameters rather than at one convenient point.
  // The odd values are load-bearing. With round PAS costs and round bps the
  // division comes out exact, rounding is never exercised, and a floor-instead-
  // of-ceil implementation passes every case. The +7 wei costs and the 333/777
  // bps are there to force remainders.
  const cases = [];
  const costs = [PAS(0.01), PAS(0.4) + 7n, PER_ORDER_COST, PER_ORDER_COST + 3n, PAS(3) + 1n];
  const fees = [100, 250, 333, 1000];
  const rebates = [500, 777, 2000, 10_000];
  for (const cost of costs) {
    for (const margin of [1, 1.25, 1.37, 2]) {
      for (const feeBps of fees) {
        for (const relayRebateBps of rebates) {
          for (const serviceFeeWei of [0n, PAS(0.1) + 11n]) {
            cases.push({ costWei: cost, margin, feeBps, relayRebateBps, serviceFeeWei });
          }
        }
      }
    }
  }

  for (const p of cases) {
    const fare = breakEvenFareWei(p);
    assert.ok(fare !== null, `no break-even for ${JSON.stringify(p, (k, v) => typeof v === "bigint" ? String(v) : v)}`);
    const at = rebateWei(fare, p.feeBps, p.relayRebateBps) + p.serviceFeeWei;
    assert.ok(coversCost(at, p.costWei, p.margin), `break-even fare ${fare} does not actually cover`);

    if (fare > 0n) {
      const below = rebateWei(fare - 1n, p.feeBps, p.relayRebateBps) + p.serviceFeeWei;
      assert.ok(!coversCost(below, p.costWei, p.margin), `fare ${fare} is not the LEAST — ${fare - 1n} also covers`);
    }
  }
});

test("no rebate rate means no break-even at any fare", () => {
  // With relayRebateBps or feeBps at zero the rebate is identically zero, so an
  // arbitrarily large order still does not pay — the honest answer is null, not
  // a huge number.
  const base = { costWei: PAS(0.5), margin: 1.25, serviceFeeWei: 0n };
  assert.equal(breakEvenFareWei({ ...base, feeBps: 250, relayRebateBps: 0 }), null);
  assert.equal(breakEvenFareWei({ ...base, feeBps: 0, relayRebateBps: 2000 }), null);
  // …unless the flat fee alone already covers the cost, which is the whole
  // point of the F6-flat path.
  assert.equal(breakEvenFareWei({ ...base, feeBps: 0, relayRebateBps: 0, serviceFeeWei: PAS(1) }), 0n);
});

test("break-even falls as the rebate share rises, and as the flat fee grows", () => {
  const base = { costWei: PER_ORDER_COST, margin: 1.25, feeBps: DEPLOYED.feeBps, serviceFeeWei: 0n };
  const at = (relayRebateBps) => breakEvenFareWei({ ...base, relayRebateBps });

  assert.ok(at(500) > at(2000), "a bigger rebate share must lower the break-even fare");
  assert.ok(at(2000) > at(10_000));

  const withFee = (serviceFeeWei) =>
    breakEvenFareWei({ ...base, relayRebateBps: DEPLOYED.relayRebateBps, serviceFeeWei });
  assert.ok(withFee(PAS(0.1)) < withFee(0n), "a flat fee must lower the break-even fare");
  assert.equal(withFee(PAS(10)), 0n, "a flat fee above cost breaks even at any fare");
});

// ── the answer, at the parameters actually deployed ──────────────────────────

test("THE NUMBER: at deployed parameters the rebate alone needs an implausible fare", () => {
  // rebate = fare · feeBps · relayRebateBps / 1e8
  //        = fare · 250 · 2000 / 1e8
  //        = fare · 0.5%
  // so the relay keeps half a percent of the fare to cover the whole delivery's
  // gas. Against ~0.73 PAS of measured gas at 1000 gwei, that needs a fare in
  // the hundreds of PAS — orders of magnitude above any real food delivery.
  const fare = breakEvenFareWei({
    costWei: PER_ORDER_COST,
    margin: DEPLOYED.marginDefault,
    feeBps: DEPLOYED.feeBps,
    relayRebateBps: DEPLOYED.relayRebateBps,
  });

  assert.ok(fare > PAS(100), `expected an implausible break-even, got ${fmt(fare)} PAS`);
  assert.ok(fare < PAS(500), `sanity bound — got ${fmt(fare)} PAS`);

  // And the corollary the guard produces in practice: a realistic fare declines.
  const realistic = PAS(2);
  assert.equal(
    coversCost(rebateWei(realistic, DEPLOYED.feeBps, DEPLOYED.relayRebateBps), PER_ORDER_COST, DEPLOYED.marginDefault),
    false,
    "a 2 PAS fare should NOT cover — if this ever passes, the parameters changed"
  );

  console.log(`\n  relay break-even, deployed parameters (${fmt(PER_ORDER_COST)} PAS gas/order @ 1000 gwei):`);
  console.log(`    rebate only ............ ${fmt(fare).padStart(10)} PAS fare`);
});

test("the flat service fee is what actually makes a relay viable", () => {
  // F6-flat exists precisely because the bps rebate cannot work at these gas
  // prices: it is sized to cover the whole per-order cost directly, so
  // viability stops depending on order size at all.
  const needed = (PER_ORDER_COST * 125n) / 100n; // cost × the default 1.25 margin

  assert.equal(
    breakEvenFareWei({
      costWei: PER_ORDER_COST, margin: DEPLOYED.marginDefault,
      feeBps: DEPLOYED.feeBps, relayRebateBps: DEPLOYED.relayRebateBps,
      serviceFeeWei: needed,
    }),
    0n,
    "a service fee at cost×margin should break even at any fare"
  );

  // One notch below and it does not — so the threshold is where it is claimed.
  assert.ok(
    breakEvenFareWei({
      costWei: PER_ORDER_COST, margin: DEPLOYED.marginDefault,
      feeBps: DEPLOYED.feeBps, relayRebateBps: DEPLOYED.relayRebateBps,
      serviceFeeWei: needed - PAS(0.01),
    }) > 0n
  );

  console.log(`    flat fee that removes fare-dependence: ${fmt(needed)} PAS/order`);
});

test("the withdraw fee is a separate, per-withdrawal business", () => {
  // F8 pays withdrawFeeBps of the BALANCE, unrelated to any fare — so it is
  // sized against one withdrawal's gas, not a delivery's. At 1% it needs the
  // driver to be cashing out a meaningful balance before it clears the margin.
  const withdrawCost = BigInt(SNAP["vault.withdrawFor (gasless)"]) * GAS_PRICE;
  const feeOn = (balance) => (balance * BigInt(DEPLOYED.withdrawFeeBps)) / 10_000n;

  assert.equal(coversCost(feeOn(PAS(1)), withdrawCost, DEPLOYED.marginDefault), false,
    "a 1 PAS cash-out should not cover its own gas at 1%");

  // Find the balance that does, by the same inverse: fee = bal/100 ≥ cost×1.25.
  const needBalance = (withdrawCost * 125n * 10_000n) / (100n * BigInt(DEPLOYED.withdrawFeeBps));
  assert.equal(coversCost(feeOn(needBalance), withdrawCost, DEPLOYED.marginDefault), true);
  console.log(`    withdraw fee (1%) breaks even at a ${fmt(needBalance)} PAS cash-out\n`);
});
