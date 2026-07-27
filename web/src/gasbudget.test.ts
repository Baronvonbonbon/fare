import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEther, formatEther } from "ethers";
import {
  PASEO_GAS_PRICE_WEI, BURNER_FUNDING_WEI, reservationFor,
  MAX_BURNER_GAS_LIMIT, DEPOSIT_GAS, RETURN_GAS, RETURN_RESERVE_WEI, RETURN_MARGIN_WEI,
} from "./gasbudget";

// The Paseo gas-reservation regression (TEST-PLAN A5).
//
// Paseo reserves `gasLimit × gasPrice` at SUBMISSION, not at execution — so a
// generous limit demands the sender already hold that much, whatever the call
// actually burns. The operator scripts and the relay use a 500 M weight-scale
// limit, which is fine from a funded deployer and reserves ~500 PAS at 1000
// gwei. A freshly-shielded burner holds 5.
//
// That already cost a live run. These tests guard the two ways it comes back:
// the arithmetic quietly stops holding, or a 500 M literal is copied from a
// script into client code.

describe("burner gas budget", () => {
  it("every client-side limit is affordable for the burner that signs it", () => {
    // The reservation is on TOP of whatever value the transaction carries, so a
    // limit that consumed the whole balance would leave nothing to send.
    for (const [name, limit] of [["DEPOSIT_GAS", DEPOSIT_GAS], ["RETURN_GAS", RETURN_GAS]] as const) {
      const reserved = reservationFor(limit);
      expect(limit, `${name} exceeds the burner ceiling`).toBeLessThanOrEqual(MAX_BURNER_GAS_LIMIT);
      expect(reserved, `${name} reserves ${formatEther(reserved)} PAS of a ${formatEther(BURNER_FUNDING_WEI)} PAS burner`)
        .toBeLessThan(BURNER_FUNDING_WEI);
    }
  });

  it("the operator's 500 M limit would price a burner out — which is the point", () => {
    // The control. If this ever stops being true the whole budget is moot, and
    // it is what makes the ceiling above a real constraint rather than a number.
    const operatorLimit = 500_000_000n;
    expect(reservationFor(operatorLimit)).toBe(parseEther("500"));
    expect(reservationFor(operatorLimit)).toBeGreaterThan(BURNER_FUNDING_WEI * 50n);
    expect(operatorLimit).toBeGreaterThan(MAX_BURNER_GAS_LIMIT);
  });

  it("shieldedReturn holds back enough to cover its own submission", () => {
    // The subtle one, and the exact shape of the original bug: the hold-back
    // and the gas limit are two numbers that have to agree. Raising RETURN_GAS
    // without raising the reserve makes every shielded return fail at
    // submission, on a path that only runs when a user is cashing out.
    expect(RETURN_RESERVE_WEI).toBeGreaterThan(reservationFor(RETURN_GAS));
    expect(RETURN_RESERVE_WEI - reservationFor(RETURN_GAS)).toBe(RETURN_MARGIN_WEI);

    // And it has to leave something worth depositing: a burner at full funding
    // must still be able to return a meaningful amount.
    const usable = BURNER_FUNDING_WEI - RETURN_RESERVE_WEI;
    expect(usable).toBeGreaterThan(parseEther("3"));
  });

  it("reservationFor is the submission cost, not the execution cost", () => {
    expect(reservationFor(1n, 1n)).toBe(1n);
    expect(reservationFor(21_000n)).toBe(21_000n * PASEO_GAS_PRICE_WEI);
    expect(reservationFor(1_000_000n)).toBe(parseEther("1")); // 1M gas = 1 PAS at 1000 gwei
  });
});

// ── the literal that must never reach the client ─────────────────────────────

describe("no oversized gas limit in client code", () => {
  /// Every .ts/.tsx under web/src, which is the only code a burner ever signs
  /// with. scripts/ and venue-node/ are operator paths and are excluded on
  /// purpose — that separation IS the design.
  function clientSources(dir = join(__dirname)): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...clientSources(full));
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /// Find gas-limit literals a burner could not afford to reserve.
  /// Matches `gasLimit: 500_000_000n`, `gasLimit = 21000`, and the same inside
  /// an options object — the shapes a copy-paste from scripts/ actually takes.
  function oversizedLimits(sources: { path: string; src: string }[]): string[] {
    const out: string[] = [];
    for (const { path, src } of sources) {
      for (const m of src.matchAll(/gasLimit\s*[:=]\s*([\d_]+)n?/g)) {
        const limit = BigInt(m[1].replace(/_/g, ""));
        const reserved = reservationFor(limit);
        if (reserved >= BURNER_FUNDING_WEI) {
          out.push(`${path}: gasLimit ${limit} reserves ${formatEther(reserved)} PAS ` +
                   `(a burner holds ${formatEther(BURNER_FUNDING_WEI)})`);
        }
      }
    }
    return out;
  }

  const realSources = () =>
    clientSources().map((f) => ({ path: f.slice(f.indexOf("web/src")), src: readFileSync(f, "utf8") }));

  it("web/src contains no gas limit a burner could not afford", () => {
    // The healthy state is zero matches — every client limit now goes through a
    // named constant in gasbudget.ts. What this stops is a 500 M literal being
    // copied out of scripts/ into the app, which is the specific regression.
    expect(oversizedLimits(realSources())).toEqual([]);
  });

  it("CONTROL: the scan walks real files and catches a planted literal", () => {
    // Zero matches is the goal, which makes this control mandatory: without it
    // the assertion above would pass just as happily with a broken regex or an
    // empty file walk.
    const sources = realSources();
    expect(sources.length, "the file walk found no client sources").toBeGreaterThan(20);
    expect(sources.some((s) => s.path.endsWith("shieldpool.ts"))).toBe(true);

    // Plant the exact thing being policed, through the same function.
    const planted = oversizedLimits([
      ...sources,
      { path: "web/src/evil.ts", src: "const tx = await c.f(a, { gasLimit: 500_000_000n });" },
    ]);
    expect(planted).toHaveLength(1);
    expect(planted[0]).toContain("evil.ts");
    expect(planted[0]).toContain("500.0 PAS");

    // An affordable limit is not flagged — the check is a budget, not a ban.
    expect(oversizedLimits([{ path: "ok.ts", src: "{ gasLimit: 3_000_000n }" }])).toEqual([]);
    // …and the boundary is where the burner's funding is.
    expect(oversizedLimits([{ path: "edge.ts", src: "{ gasLimit: 5_000_000n }" }])).toHaveLength(1);
    expect(oversizedLimits([{ path: "edge.ts", src: "{ gasLimit: 4_999_999n }" }])).toEqual([]);
  });

  it("client gas now goes through named constants, not inline numbers", () => {
    // The reason the scan finds nothing: both call sites budget through
    // gasbudget.ts. If someone reintroduces an inline literal this notices even
    // when the value happens to be affordable, because the next one might not be.
    const inline = realSources().flatMap(({ path, src }) =>
      [...src.matchAll(/gasLimit\s*[:=]\s*([\d_]+)n?/g)].map((m) => `${path}: ${m[1]}`)
    );
    expect(inline, `inline gas limits in client code:\n  ${inline.join("\n  ")}`).toEqual([]);
  });
});
