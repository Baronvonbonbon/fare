// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import GovernanceConsole from "./GovernanceConsole";
import type { ConsoleProps } from "./OpsApp";

// The governance console, rendered (TEST-PLAN D1).
//
// C5 covered `govparams.ts` — the bounds, differentially against the contracts
// — and found a live defect there: a cleared numeric field parsed as `0`, so
// blanking the protocol-fee box set the fee to zero, silently, because 0 is
// inside the valid range (TEST-FINDINGS #13).
//
// That fix lives in `toInt`. What it does NOT prove is that the console still
// wires `toInt`'s verdict to the Save button. A component that computed the
// error correctly and rendered `disabled={false}` anyway would pass every unit
// test in `govparams.test.ts` and lose the fee again. So the first thing
// asserted here is exactly that regression, at the DOM.
//
// The other half is per-domain authority. Each contract is its own
// Ownable2Step, so owning `orders` must not unlock the vault's card — a global
// "is owner" would be an easy and invisible mistake.

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

/// Which domain each contract reports as its owner. Per-domain on purpose.
let ownerOf: Record<string, string> = {};
let readsFail = false;
const sent: { fn: string; args: any[] }[] = [];

const num = (n: number) => async () => BigInt(n);
const record = (fn: string) => async (...args: any[]) => {
  sent.push({ fn, args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)) });
  return { wait: async () => ({}) };
};

vi.mock("../chain", () => ({
  short: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"),
  nodeLabel: () => "hosted",
  syncAddressesFromRouter: async () => true,
  fmt: (w: bigint) => (Number(w) / 1e18).toString(),
  parse: (v: string) => BigInt(Math.round(Number(v || "0") * 1e18)),
  contracts: () => ({
    orders: {
      feeBps: num(250), assignedCancelBps: num(1000), defaultPickupWindow: num(1800),
      defaultDeliveryWindow: num(3600), relayRebateBps: num(2000),
      owner: async () => { if (readsFail) throw new Error("node unreachable"); return ownerOf.orders; },
      setParams: record("setParams"),
      setRelayRebateBps: record("setRelayRebateBps"),
    },
    drivers: {
      minStake: num(10n ** 18n as any), unbondingSeconds: num(86400),
      owner: async () => ownerOf.drivers,
      setMinStake: record("setMinStake"), setUnbondingSeconds: record("setUnbondingSeconds"),
    },
    disputes: { disputeBond: num(10n ** 17n as any), owner: async () => ownerOf.disputes, setDisputeBond: record("setDisputeBond") },
    vault: { withdrawFeeBps: num(100), owner: async () => ownerOf.vault, setWithdrawFeeBps: record("setWithdrawFeeBps") },
    settlement: {
      pickupRadiusMeters: num(150), dropoffRadiusMeters: num(100),
      attestationMaxAgeSecs: num(600), attestationFutureSkewSecs: num(120),
      owner: async () => ownerOf.settlement, setGeoParams: record("setGeoParams"),
    },
  }),
}));

function props(address: string | null): ConsoleProps {
  return {
    session: address ? ({ address, signer: {} } as any) : null,
    busy: false,
    run: async (_l: string, fn: () => Promise<any>, after?: () => Promise<any> | void) => { await fn(); await after?.(); },
    say: vi.fn(),
  };
}

const card = (heading: RegExp) =>
  screen.getByRole("heading", { name: heading }).closest(".card") as HTMLElement;

/// A field's text input, located by its label text.
function field(cardEl: HTMLElement, label: RegExp): HTMLInputElement {
  const labelEl = within(cardEl).getByText(label);
  const wrap = labelEl.closest("label") ?? labelEl.parentElement!;
  const input = wrap.querySelector("input") ?? within(cardEl).getAllByRole("textbox")[0];
  return input as HTMLInputElement;
}

beforeEach(() => {
  ownerOf = { orders: OWNER, drivers: OWNER, disputes: OWNER, vault: OWNER, settlement: OWNER };
  readsFail = false;
  sent.length = 0;
});
afterEach(cleanup);

describe("the cleared-field regression, at the DOM", () => {
  it("disables Save when a numeric field is blanked", async () => {
    // TEST-FINDINGS #13. `Number("")` is 0 and 0 is a legal feeBps, so before
    // the fix this path set the protocol fee to zero and reported success.
    // `toInt` returning NaN is only half the fix; this is the other half.
    render(<GovernanceConsole {...props(OWNER)} />);
    const econ = await waitFor(() => card(/Order economics/));

    const save = within(econ).getByRole("button", { name: /Save order params/ });
    expect((save as HTMLButtonElement).disabled, "Save was disabled before anything was edited").to.equal(false);

    fireEvent.change(field(econ, /feeBps/), { target: { value: "" } });

    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled, "a blank fee field left Save enabled").to.equal(true)
    );
    fireEvent.click(save);
    expect(sent, "a blank field was submitted").to.have.length(0);
  });

  it("still allows a deliberately typed zero", async () => {
    // The fix must not make a legitimate zero unreachable: setting the fee to
    // zero should take typing a zero, not become impossible.
    render(<GovernanceConsole {...props(OWNER)} />);
    const econ = await waitFor(() => card(/Order economics/));
    const save = within(econ).getByRole("button", { name: /Save order params/ });

    fireEvent.change(field(econ, /feeBps/), { target: { value: "0" } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).to.equal(false));

    fireEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].fn).to.equal("setParams");
    expect(sent[0].args[0], "typed zero did not reach the call").to.equal(0);
  });

  it("disables Save for a value past the contract's cap", async () => {
    // FEE_BPS_MAX is 1000. The console refuses rather than letting the operator
    // broadcast a transaction the contract will revert.
    render(<GovernanceConsole {...props(OWNER)} />);
    const econ = await waitFor(() => card(/Order economics/));
    const save = within(econ).getByRole("button", { name: /Save order params/ });

    fireEvent.change(field(econ, /feeBps/), { target: { value: "1001" } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).to.equal(true));
    expect(within(econ).getByText(/integer 0–1000/)).toBeTruthy();

    fireEvent.change(field(econ, /feeBps/), { target: { value: "1000" } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).to.equal(false));
  });

  it("refuses a non-numeric field", async () => {
    // `toInt` rejects hex and exponent forms deliberately — `Number("0x10")` is
    // 16 and `Number("1e3")` is 1000, neither of which is what someone typing
    // into a decimal box means.
    render(<GovernanceConsole {...props(OWNER)} />);
    const econ = await waitFor(() => card(/Order economics/));
    const save = within(econ).getByRole("button", { name: /Save order params/ });

    for (const junk of ["abc", "-1", " ", "0x10", "1e3"]) {
      fireEvent.change(field(econ, /feeBps/), { target: { value: junk } });
      await waitFor(() =>
        expect((save as HTMLButtonElement).disabled, `"${junk}" left Save enabled`).to.equal(true)
      );
    }
  });

  it("accepts a decimal by TRUNCATING it — recorded, not endorsed", async () => {
    // `toInt`'s regex admits `\d+(\.\d+)?` and then truncates, so "1.5"
    // submits 1. That is deliberate in the source, and it is worth pinning
    // because it sits awkwardly beside #13's own rule: if setting the fee to
    // zero should take typing a zero, setting it to 1 should arguably take
    // typing 1. Flagged in the plan; the behaviour is the contract for now, so
    // a change to it should break this test and be a decision.
    render(<GovernanceConsole {...props(OWNER)} />);
    const econ = await waitFor(() => card(/Order economics/));
    const save = within(econ).getByRole("button", { name: /Save order params/ });

    fireEvent.change(field(econ, /feeBps/), { target: { value: "1.5" } });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).to.equal(false));

    fireEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].args[0], "a decimal was not truncated the way toInt says").to.equal(1);
  });
});

describe("per-domain authority", () => {
  it("locks a card whose contract this wallet does not own", async () => {
    // Each domain is its own Ownable2Step. Owning `orders` must not unlock the
    // vault — a single global `isOwner` would be an easy, invisible mistake,
    // and the operator would only discover it from a revert.
    ownerOf = { orders: OWNER, drivers: OTHER, disputes: OTHER, vault: OTHER, settlement: OTHER };
    render(<GovernanceConsole {...props(OWNER)} />);

    const econ = await waitFor(() => card(/Order economics/));
    expect(
      (within(econ).getByRole("button", { name: /Save order params/ }) as HTMLButtonElement).disabled,
      "the owned card was locked"
    ).to.equal(false);

    const geo = card(/Geofencing/);
    const geoSave = within(geo).getAllByRole("button").find((b) => /Save/.test(b.textContent ?? ""))!;
    expect((geoSave as HTMLButtonElement).disabled, "an unowned card was left editable").to.equal(true);
  });

  it("locks everything when no wallet is connected", async () => {
    render(<GovernanceConsole {...props(null)} />);
    await waitFor(() => expect(card(/Order economics/)).toBeTruthy());
    for (const b of screen.getAllByRole("button")) {
      if (/Save/.test(b.textContent ?? "")) {
        expect((b as HTMLButtonElement).disabled, `${b.textContent} was live with no session`).to.equal(true);
      }
    }
  });

  it("locks everything while a transaction is in flight", async () => {
    render(<GovernanceConsole {...{ ...props(OWNER), busy: true }} />);
    await waitFor(() => expect(card(/Order economics/)).toBeTruthy());
    for (const b of screen.getAllByRole("button")) {
      if (/Save/.test(b.textContent ?? "")) {
        expect((b as HTMLButtonElement).disabled, `${b.textContent} was live while busy`).to.equal(true);
      }
    }
  });
});

describe("what the operator reads", () => {
  it("shows the live on-chain values, not placeholders", async () => {
    // The console's purpose is to show what IS set before changing it. A stale
    // or defaulted display invites retuning something that was already correct.
    render(<GovernanceConsole {...props(OWNER)} />);
    await waitFor(() => expect(card(/Order economics/)).toBeTruthy());
    // feeBps 250 renders as its percentage too, so the operator reads a unit
    // rather than a raw bps number.
    expect(screen.getAllByText(/2\.50%/).length).to.be.greaterThan(0);
  });

  it("says so when the load failed rather than rendering an empty console", async () => {
    readsFail = true;
    const p = props(OWNER);
    render(<GovernanceConsole {...p} />);
    await waitFor(() => expect(p.say).toHaveBeenCalled());
    expect((p.say as any).mock.calls[0][0]).to.match(/Load failed/);
    expect((p.say as any).mock.calls[0][1]).to.equal(true);
  });
});
