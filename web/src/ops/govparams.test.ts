import { describe, it, expect } from "vitest";
import {
  toInt, pct, secsLabel, bpsValid,
  feeBpsValid, cancelBpsValid, windowValid,
  radiusValid, maxAgeValid, skewValid,
  orderParamsValid, geoParamsValid,
  FEE_BPS_MAX, CANCEL_BPS_MAX, WINDOW_MIN, WINDOW_MAX,
  RADIUS_MIN, RADIUS_MAX, MAX_AGE_MIN, MAX_AGE_MAX, SKEW_MAX,
} from "./govparams";
import { REGISTERED, routerKey, checkPromotion } from "./upgrade";

// Unit half of TEST-PLAN C5 for the governance, pause and upgrade consoles.
// The bounds are checked against the real contracts in
// test/ops-governance.test.ts; what is checked here is the parsing in front of
// them, where a governance parameter is decided before any chain sees it.

describe("toInt", () => {
  it("refuses blank input instead of reading it as zero", () => {
    // This was a live defect. `Number("")` is 0, so clearing a field and
    // pressing Save wrote a real 0 — silently, because 0 is inside the valid
    // range for feeBps, assignedCancelBps, relayRebateBps, withdrawFeeBps and
    // unbondingSeconds. Setting the protocol fee to zero should take typing it.
    expect(toInt("")).toBeNaN();
    expect(toInt("   ")).toBeNaN();
    expect(feeBpsValid(toInt(""))).toBe(false);
    expect(bpsValid(toInt(""), 10_000)).toBe(false);
  });

  it("refuses hex and exponent forms, which a decimal field never means", () => {
    // Number("0x10") is 16 and Number("1e3") is 1000 — both would be accepted
    // silently and neither is what an operator typed.
    expect(toInt("0x10")).toBeNaN();
    expect(toInt("1e3")).toBeNaN();
    expect(toInt("0b101")).toBeNaN();
    expect(toInt("abc")).toBeNaN();
    expect(toInt("Infinity")).toBeNaN();
    expect(toInt("1,000")).toBeNaN();
  });

  it("accepts plain decimals, trimming and truncating toward zero", () => {
    expect(toInt(" 12 ")).toBe(12);
    expect(toInt("0")).toBe(0);
    expect(toInt("2.9")).toBe(2);
    expect(toInt("-3.7")).toBe(-3);
    expect(toInt("+250")).toBe(250);
  });
});

describe("bounds mirror the contracts", () => {
  it("feeBps: 0…1000", () => {
    expect(feeBpsValid(0)).toBe(true);
    expect(feeBpsValid(FEE_BPS_MAX)).toBe(true);
    expect(feeBpsValid(FEE_BPS_MAX + 1)).toBe(false);
    expect(feeBpsValid(-1)).toBe(false);
  });

  it("assignedCancelBps: 0…5000", () => {
    expect(cancelBpsValid(CANCEL_BPS_MAX)).toBe(true);
    expect(cancelBpsValid(CANCEL_BPS_MAX + 1)).toBe(false);
  });

  it("windows: 600…86400, both ends closed", () => {
    expect(windowValid(WINDOW_MIN)).toBe(true);
    expect(windowValid(WINDOW_MAX)).toBe(true);
    expect(windowValid(WINDOW_MIN - 1)).toBe(false);
    expect(windowValid(WINDOW_MAX + 1)).toBe(false);
    expect(windowValid(0)).toBe(false); // a blank field must not read as valid
  });

  it("geo: radii 25…2000, maxAge 60…7200, skew 0…1800", () => {
    expect(radiusValid(RADIUS_MIN)).toBe(true);
    expect(radiusValid(RADIUS_MAX)).toBe(true);
    expect(radiusValid(RADIUS_MIN - 1)).toBe(false);
    expect(radiusValid(RADIUS_MAX + 1)).toBe(false);
    expect(maxAgeValid(MAX_AGE_MIN)).toBe(true);
    expect(maxAgeValid(MAX_AGE_MAX)).toBe(true);
    expect(maxAgeValid(MAX_AGE_MIN - 1)).toBe(false);
    expect(skewValid(0)).toBe(true);
    expect(skewValid(SKEW_MAX)).toBe(true);
    expect(skewValid(SKEW_MAX + 1)).toBe(false);
  });

  it("the combined gates reject if any single field is bad", () => {
    expect(orderParamsValid(250, 2_500, 3_600, 3_600)).toBe(true);
    expect(orderParamsValid(1_001, 2_500, 3_600, 3_600)).toBe(false);
    expect(orderParamsValid(250, 2_500, 599, 3_600)).toBe(false);
    expect(orderParamsValid(250, 2_500, 3_600, NaN)).toBe(false);
    expect(geoParamsValid(100, 100, 300, 60)).toBe(true);
    expect(geoParamsValid(24, 100, 300, 60)).toBe(false);
    expect(geoParamsValid(100, 100, 300, NaN)).toBe(false);
  });
});

describe("display helpers", () => {
  it("pct renders basis points", () => {
    expect(pct(250)).toBe("2.50%");
    expect(pct(10_000)).toBe("100.00%");
    expect(pct(0)).toBe("0.00%");
  });

  it("secsLabel picks the coarsest exact unit", () => {
    expect(secsLabel(0)).toBe("0s");
    expect(secsLabel(45)).toBe("45s");
    expect(secsLabel(2_700)).toBe("45m");
    expect(secsLabel(7_200)).toBe("2h");
    expect(secsLabel(86_400)).toBe("1d");
    expect(secsLabel(90)).toBe("90s"); // not an exact minute
  });
});

describe("upgrade console addressing", () => {
  it("derives router keys the way the deploy script does", () => {
    // Both sides use encodeBytes32String. A drift here would not error — it
    // would silently address a different registry slot.
    expect(routerKey("orders")).toBe(
      "0x6f72646572730000000000000000000000000000000000000000000000000000"
    );
    expect(routerKey("pauseRegistry")).toBe(
      "0x7061757365526567697374727900000000000000000000000000000000000000"
    );
    for (const { name } of REGISTERED) {
      expect(routerKey(name)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(routerKey(name)).not.toBe(routerKey(name + "x"));
    }
  });

  it("knows which entries are upgradable", () => {
    // pauseRegistry is not FareUpgradable — upgradeContract() on it would
    // revert, so the console must offer register() instead.
    const byName = Object.fromEntries(REGISTERED.map((r) => [r.name, r.upgradable]));
    expect(byName.pauseRegistry).toBe(false);
    expect(byName.orders).toBe(true);
    expect(REGISTERED.filter((r) => !r.upgradable).map((r) => r.name)).toEqual(["pauseRegistry"]);
  });

  it("blocks a promotion to the address already registered", () => {
    const cur = "0x1111111111111111111111111111111111111111";
    const other = "0x2222222222222222222222222222222222222222";

    // Re-registering the live address burns a version bump and, with
    // freezeOld, freezes the contract it just promoted — an outage from a no-op.
    const same = checkPromotion(cur, cur, true);
    expect(same.sameAsCurrent).toBe(true);
    expect(same.canSubmit).toBe(false);

    // Case-insensitive: a checksummed paste of the same address is still same.
    expect(checkPromotion(cur.toUpperCase().replace("0X", "0x"), cur, true).sameAsCurrent).toBe(true);

    expect(checkPromotion(other, cur, true).canSubmit).toBe(true);
    expect(checkPromotion("not-an-address", cur, true).canSubmit).toBe(false);
    expect(checkPromotion(other, cur, false).canSubmit).toBe(false); // not the owner
    expect(checkPromotion(other, cur, false).reason).toMatch(/router owner/);
  });
});
