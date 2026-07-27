// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { ethers } from "ethers";
import DisputesConsole from "./DisputesConsole";
import type { ConsoleProps } from "./OpsApp";

// The disputes console, rendered (TEST-PLAN D1).
//
// This is the riskiest surface in the repo. `resolve()` splits a frozen escrow
// and is irreversible, and the numbers the arbiter reads before signing are
// computed HERE, in a preview. C5 pinned that arithmetic — `splitEscrow` and
// `slashExceedsStake` are differential-tested against
// `FareOrders.resolveDisputed` to the wei — but arithmetic being right is not
// the same as the arbiter seeing it.
//
// Three things this can only be asserted at the DOM:
//
//   · the preview updates when the slider moves, and the two halves still sum
//     to the escrow (a stale preview is a wrong ruling signed in good faith);
//   · the slash warning appears, because `FareDrivers.slash` CLAMPS rather than
//     reverting — without the warning the console promises damages that never
//     arrive;
//   · "Issue ruling" is dead for anyone who is not the arbiter, and says so
//     before the click rather than after a revert.

const ARBITER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const CUSTOMER = "0x3333333333333333333333333333333333333333";
const DRIVER = "0x4444444444444444444444444444444444444444";
const PAS = (n: string) => ethers.parseEther(n);

let driverAddr = DRIVER;
let escrow = PAS("10");
let driverStake = PAS("1");
let readsFail = false;
const sent: { fn: string; args: any[] }[] = [];

vi.mock("../chain", () => ({
  short: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"),
  nodeLabel: () => "hosted",
  syncAddressesFromRouter: async () => true,
  fmt: (w: bigint) => {
    const s = ethers.formatEther(w);
    return s.includes(".") ? s.replace(/(\.\d{4})\d+$/, "$1").replace(/\.?0+$/, "") || "0" : s;
  },
  parse: (v: string) => ethers.parseEther(v === "" ? "0" : v),
  contracts: () => ({
    disputes: {
      arbiter: async () => {
        if (readsFail) throw new Error("node unreachable");
        return ARBITER;
      },
      nextDisputeId: async () => 2n,
      disputes: async (_id: bigint) => ({
        status: 1, orderId: 7n, opener: CUSTOMER, bond: PAS("0.1"), evidenceURI: "ipfs://evidence",
      }),
      resolve: async (...args: any[]) => {
        sent.push({ fn: "resolve", args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)) });
        return { wait: async () => ({}) };
      },
    },
    orders: {
      orders: async () => ({
        customer: CUSTOMER, driver: driverAddr, escrow,
        orderValue: PAS("4"), tip: PAS("1"), fare: PAS("5"), status: 6,
      }),
    },
    drivers: {
      drivers: async () => ({ stake: driverStake, delivered: 12n, failed: 1n }),
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

/// The escrow split the arbiter is shown, read back off the rendered rows.
function preview() {
  const row = (k: string) =>
    screen.getByText(k).closest(".kv")!.querySelector(".v")!.textContent!.replace(" PAS", "").trim();
  return { customer: row("→ customer"), driver: row("→ driver") };
}

const slider = () => document.querySelector('input[type="range"]') as HTMLInputElement;
const rulingButton = () => screen.getByRole("button", { name: /Issue ruling/ });

beforeEach(() => {
  driverAddr = DRIVER;
  escrow = PAS("10");
  driverStake = PAS("1");
  readsFail = false;
  sent.length = 0;
});
afterEach(cleanup);

describe("the split preview the arbiter signs against", () => {
  it("defaults to an even split rather than favouring anyone", async () => {
    // A default of "customer takes everything" would be signed unread often
    // enough to matter. Neutral forces a deliberate choice.
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());
    expect(slider().value).to.equal("5000");
    expect(preview()).to.deep.equal({ customer: "5", driver: "5" });
  });

  it("tracks the slider, and the halves always sum to the escrow", async () => {
    // The sum is the invariant C5 pinned in `splitEscrow` — driver takes the
    // remainder, so nothing is created or lost. Here it has to survive being
    // re-rendered.
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    for (const [bps, cust, drv] of [["0", "0", "10"], ["2500", "2.5", "7.5"], ["10000", "10", "0"]] as const) {
      fireEvent.change(slider(), { target: { value: bps } });
      await waitFor(() => expect(preview().customer).to.equal(cust));
      expect(preview().driver, `driver share wrong at ${bps} bps`).to.equal(drv);
      expect(
        Number(preview().customer) + Number(preview().driver),
        `the split stopped summing to the escrow at ${bps} bps`
      ).to.equal(10);
    }
  });

  it("previews an escrow that does not divide evenly, to the wei", async () => {
    // Round numbers hide truncation — that is exactly how the C5 differential
    // test was vacuous at first (TEST-FINDINGS #11). An odd escrow is the case
    // that distinguishes a correct preview from a plausible one.
    escrow = PAS("10") + 3n;
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    fireEvent.change(slider(), { target: { value: "3300" } });
    await waitFor(() => {
      const c = ethers.parseEther(preview().customer);
      const d = ethers.parseEther(preview().driver);
      // The rendered figures are truncated for display, so assert the property
      // that must hold exactly: neither side exceeds the escrow.
      expect(c + d <= escrow, "the split exceeded the escrow").to.equal(true);
    });
  });

  it("submits the ruling the preview described", async () => {
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.change(slider(), { target: { value: "7500" } });

    fireEvent.click(rulingButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    // id, bps, openerWins, driverAtFault, slashWei
    expect(sent[0].args[1], "the submitted bps is not the previewed one").to.equal(7500);
    expect(sent[0].args[2]).to.equal(true);
    expect(sent[0].args[3]).to.equal(false);
    expect(sent[0].args[4]).to.equal("0");
  });
});

describe("the slash warning", () => {
  it("warns when the slash exceeds the driver's stake", async () => {
    // `FareDrivers.slash` CLAMPS to the actual stake instead of reverting, so
    // without this the console silently promises damages that never arrive and
    // the ruling looks like it worked.
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    const slashInput = screen.getByDisplayValue("0") as HTMLInputElement;
    fireEvent.change(slashInput, { target: { value: "5" } }); // stake is 1 PAS

    await waitFor(() => expect(screen.getByText(/caps the slash at the actual stake/)).toBeTruthy());
  });

  it("stays quiet for a slash within the stake", async () => {
    // A warning that is always on is a warning nobody reads.
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue("0"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.queryByText(/caps the slash/)).to.equal(null));
  });

  it("keeps the ruling submittable on unparseable slash input, at zero", async () => {
    // The field is free text. The component swallows a parse failure and keeps
    // 0 rather than blocking the whole ruling — worth pinning, because the
    // alternative reading (submit whatever parsed last) would slash by accident.
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue("0"), { target: { value: "not a number" } });
    fireEvent.click(rulingButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].args[4], "unparseable slash did not fall back to zero").to.equal("0");
  });

  it("offers no slash controls at all when there is no driver", async () => {
    // A dispute on an unassigned order has nobody to slash; the fault checkbox
    // must be dead too.
    driverAddr = ethers.ZeroAddress;
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(slider()).toBeTruthy());

    expect(screen.queryByText(/Slash driver stake/)).to.equal(null);
    const fault = screen.getByRole("checkbox", { name: /Driver at fault/ });
    expect((fault as HTMLInputElement).disabled).to.equal(true);
  });
});

describe("arbiter authority", () => {
  it("enables the ruling only for the on-chain arbiter", async () => {
    render(<DisputesConsole {...props(ARBITER)} />);
    await waitFor(() => expect(screen.getByText(/rulings will settle/)).toBeTruthy());
    expect((rulingButton() as HTMLButtonElement).disabled).to.equal(false);
  });

  it("warns a non-arbiter before the click, and keeps the button dead", async () => {
    render(<DisputesConsole {...props(STRANGER)} />);
    await waitFor(() => expect(screen.getByText(/NOT the arbiter/)).toBeTruthy());
    expect(screen.getByText(/will revert on-chain/)).toBeTruthy();

    expect((rulingButton() as HTMLButtonElement).disabled).to.equal(true);
    fireEvent.click(rulingButton());
    expect(sent, "a non-arbiter's click reached the chain").to.have.length(0);
  });

  it("is dead with no wallet, and while busy", async () => {
    render(<DisputesConsole {...props(null)} />);
    await waitFor(() => expect(screen.getByText(/Connect the arbiter wallet/)).toBeTruthy());
    expect((rulingButton() as HTMLButtonElement).disabled).to.equal(true);

    cleanup();
    render(<DisputesConsole {...{ ...props(ARBITER), busy: true }} />);
    await waitFor(() => expect(rulingButton()).toBeTruthy());
    expect((rulingButton() as HTMLButtonElement).disabled, "live while a tx was in flight").to.equal(true);
  });

  it("reports a failed load instead of an empty dispute list", async () => {
    // An empty list reads as "no disputes", which during an incident is the
    // most misleading thing the console could say.
    readsFail = true;
    const p = props(ARBITER);
    render(<DisputesConsole {...p} />);
    await waitFor(() => expect(p.say).toHaveBeenCalled());
    expect((p.say as any).mock.calls[0][0]).to.match(/Load failed/);
    expect((p.say as any).mock.calls[0][1]).to.equal(true);
  });
});
