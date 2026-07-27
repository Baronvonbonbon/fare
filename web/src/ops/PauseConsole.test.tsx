// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import PauseConsole from "./PauseConsole";
import type { ConsoleProps } from "./OpsApp";

// The pause console, rendered (TEST-PLAN D1).
//
// C5 proved the authority MODEL matches `FarePauseRegistry`: guardians pause but
// cannot unpause, the owner can do both, the four categories are the four the
// registry accepts. This asks the next question, which no logic test can: does
// the operator actually SEE that model?
//
// The gap is real and it is one-directional. Every control here is disabled by a
// boolean computed in the component — `isOwner`, `canPause` — and a wrong one
// fails safe in the annoying direction (a guardian who cannot click Pause) or
// the dangerous one (an enabled Unpause that reverts on chain after the operator
// has already believed the bleeding stopped). Neither shows up in `ruling.ts`
// or `govparams.ts`, because neither lives there.
//
// This is also the file that decides the jsdom dependency was worth adding —
// the decision C5 deliberately deferred. It is per-file (`@vitest-environment`
// above), so the other 195 tests keep running in plain node.

const OWNER = "0x1111111111111111111111111111111111111111";
const GUARDIAN = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

/// Chain state the console reads. Mutated per test before rendering.
let pausedState = [false, false, false, false];
let guardians = new Set<string>();
/// Simulates an unreachable node at the READ level, which is what actually
/// happens. Throwing from `contracts()` instead would break the render body —
/// it is called there too — and would test React, not the console.
let readsFail = false;
const sent: { fn: string; args: any[] }[] = [];

vi.mock("../chain", () => ({
  short: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"),
  nodeLabel: () => "hosted",
  syncAddressesFromRouter: async () => true,
  contracts: () => ({
    pauseRegistry: {
      owner: async () => {
        if (readsFail) throw new Error("node unreachable");
        return OWNER;
      },
      paused: async (id: number) => pausedState[id],
      isGuardian: async (a: string) => guardians.has(a.toLowerCase()),
      pause: async (id: number) => { sent.push({ fn: "pause", args: [id] }); return { wait: async () => ({}) }; },
      unpause: async (id: number) => { sent.push({ fn: "unpause", args: [id] }); return { wait: async () => ({}) }; },
      setGuardian: async (a: string, on: boolean) => {
        sent.push({ fn: "setGuardian", args: [a, on] });
        return { wait: async () => ({}) };
      },
    },
  }),
}));

/// The shell's props. `run` is the shared submit wrapper — recording what it was
/// asked to do is how a click is observed without a chain.
function props(address: string | null): ConsoleProps {
  return {
    session: address ? ({ address, signer: {} } as any) : null,
    busy: false,
    run: async (_label: string, fn: () => Promise<any>, after?: () => Promise<any> | void) => {
      await fn();
      await after?.();
    },
    say: vi.fn(),
  };
}

/// The console's own card, found by its heading — the page has several.
const categoriesCard = () => screen.getByRole("heading", { name: /Categories/ }).closest(".card")!;

/// The Pause/Resume button for one category row.
function rowButton(label: string, name: RegExp) {
  const row = within(categoriesCard() as HTMLElement)
    .getByText(new RegExp(`· ${label}$`))
    .closest(".order")!;
  return within(row as HTMLElement).getByRole("button", { name });
}

beforeEach(() => {
  pausedState = [false, false, false, false];
  guardians = new Set([GUARDIAN.toLowerCase()]);
  readsFail = false;
  sent.length = 0;
});
afterEach(cleanup);

describe("what the operator is shown", () => {
  it("names the role the connected wallet actually holds", async () => {
    render(<PauseConsole {...props(GUARDIAN)} />);
    await waitFor(() => expect(screen.getByText(/Guardian —/)).toBeTruthy());
    expect(screen.getByText(/Unpause is owner-only/)).toBeTruthy();
  });

  it("warns a wallet that is neither owner nor guardian BEFORE it clicks", async () => {
    // The alternative is finding out from a reverted transaction, having
    // believed for a moment that the brakes were on.
    render(<PauseConsole {...props(STRANGER)} />);
    await waitFor(() => expect(screen.getByText(/neither owner nor guardian/)).toBeTruthy());
    expect(screen.getByText(/will revert on-chain/)).toBeTruthy();
  });

  it("renders each category's live state", async () => {
    pausedState = [true, false, false, true];
    render(<PauseConsole {...props(OWNER)} />);

    await waitFor(() => expect(screen.getAllByText("PAUSED")).toHaveLength(2));
    expect(screen.getAllByText("live")).toHaveLength(2);
    // The count in the heading has to agree with the badges, or the operator
    // reads one number and sees another.
    expect(within(categoriesCard() as HTMLElement).getByText("2 paused")).toBeTruthy();
  });

  it("shows all four registry categories, no more and no fewer", async () => {
    render(<PauseConsole {...props(OWNER)} />);
    await waitFor(() => expect(screen.getAllByText(/^\d · /)).toHaveLength(4));
    for (const label of ["orders", "settlement", "disputes", "registry"]) {
      expect(screen.getByText(new RegExp(`· ${label}$`)), `missing ${label}`).toBeTruthy();
    }
  });
});

describe("the fast-brake / slow-release split, as rendered", () => {
  it("lets a guardian pause", async () => {
    render(<PauseConsole {...props(GUARDIAN)} />);
    const btn = await waitFor(() => rowButton("orders", /Pause/));
    expect((btn as HTMLButtonElement).disabled).to.equal(false);

    fireEvent.click(btn);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).to.deep.equal({ fn: "pause", args: [0] });
  });

  it("does NOT let a guardian unpause", async () => {
    // The half of the split that matters. `unpause` is owner-only on chain, so
    // an enabled button here promises a guardian something the registry will
    // refuse — during an incident, which is the worst possible moment.
    pausedState = [true, false, false, false];
    render(<PauseConsole {...props(GUARDIAN)} />);

    const btn = await waitFor(() => rowButton("orders", /Resume/));
    expect((btn as HTMLButtonElement).disabled, "a guardian was offered Resume").to.equal(true);
    expect(btn.getAttribute("title")).to.match(/owner-only/);

    fireEvent.click(btn);
    expect(sent, "a disabled Resume still submitted").to.have.length(0);
  });

  it("lets the owner do both", async () => {
    pausedState = [true, false, false, false];
    render(<PauseConsole {...props(OWNER)} />);

    const resume = await waitFor(() => rowButton("orders", /Resume/));
    expect((resume as HTMLButtonElement).disabled).to.equal(false);
    fireEvent.click(resume);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).to.deep.equal({ fn: "unpause", args: [0] });

    expect((rowButton("settlement", /Pause/) as HTMLButtonElement).disabled).to.equal(false);
  });

  it("disables the brakes for a stranger, and for nobody at all", async () => {
    render(<PauseConsole {...props(STRANGER)} />);
    await waitFor(() => expect(screen.getByText(/neither owner nor guardian/)).toBeTruthy());
    expect((rowButton("orders", /Pause/) as HTMLButtonElement).disabled).to.equal(true);

    cleanup();
    render(<PauseConsole {...props(null)} />);
    await waitFor(() => expect(screen.getByText(/Connect a guardian or owner/)).toBeTruthy());
    expect((rowButton("orders", /Pause/) as HTMLButtonElement).disabled).to.equal(true);
  });

  it("disables every control while a transaction is in flight", async () => {
    // `busy` is the shell's single-flight guard. Without it honoured here, an
    // impatient operator double-submits a pause and pays for two.
    render(<PauseConsole {...{ ...props(OWNER), busy: true }} />);
    await waitFor(() => expect(screen.getByText(/Owner —/)).toBeTruthy());
    expect((rowButton("orders", /Pause/) as HTMLButtonElement).disabled).to.equal(true);
  });
});

describe("guardian management", () => {
  it("is not offered to a guardian at all", async () => {
    // Owner-only on chain; showing the card to a guardian invites a revert.
    render(<PauseConsole {...props(GUARDIAN)} />);
    await waitFor(() => expect(screen.getByText(/Guardian —/)).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Guardians" })).to.equal(null);
  });

  it("refuses to submit a malformed address", async () => {
    // The address is free text. An invalid one must not reach the chain — the
    // transaction would revert, and the operator would have learned nothing.
    render(<PauseConsole {...props(OWNER)} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Guardians" })).toBeTruthy());

    const add = screen.getByRole("button", { name: "Add guardian" });
    expect((add as HTMLButtonElement).disabled, "enabled with an empty field").to.equal(true);

    fireEvent.change(screen.getByPlaceholderText(/guardian address/), { target: { value: "0xnope" } });
    expect((add as HTMLButtonElement).disabled, "enabled for a malformed address").to.equal(true);

    fireEvent.change(screen.getByPlaceholderText(/guardian address/), { target: { value: STRANGER } });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).to.equal(false));

    fireEvent.click(add);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).to.deep.equal({ fn: "setGuardian", args: [STRANGER, true] });
  });

  it("removes with the same address it added, and clears the field after", async () => {
    render(<PauseConsole {...props(OWNER)} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Guardians" })).toBeTruthy());

    const input = screen.getByPlaceholderText(/guardian address/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: GUARDIAN } });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // `false` is the whole difference between granting and revoking, and both
    // buttons sit side by side wired to the same call.
    expect(sent[0]).to.deep.equal({ fn: "setGuardian", args: [GUARDIAN, false] });
    await waitFor(() => expect(input.value).to.equal(""));
  });
});

describe("failure surfacing", () => {
  it("tells the operator when the load failed instead of showing a healthy page", async () => {
    // Silence here reads as "nothing is paused", which is the most dangerous
    // possible misreading of an unreachable node.
    readsFail = true;
    const p = props(OWNER);
    render(<PauseConsole {...p} />);

    await waitFor(() => expect(p.say).toHaveBeenCalled());
    expect((p.say as any).mock.calls[0][0]).to.match(/Load failed/);
    expect((p.say as any).mock.calls[0][1], "reported as a non-error").to.equal(true);

    // And it must not fall back to showing everything as live — that reads as
    // "nothing is paused", the most dangerous misreading of an outage.
    expect(screen.queryByText(/Owner —/), "claimed a role it could not verify").to.equal(null);
  });
});
