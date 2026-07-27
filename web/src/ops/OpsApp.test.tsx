// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import OpsApp from "./OpsApp";

// The ops shell (TEST-PLAN D1).
//
// The four console tests each assert that controls go dead while `busy` — but
// every one of them PASSES `busy` in as a prop. This is the file that decides
// what `busy` actually is, and if it never became true those four assertions
// would be describing a flag nobody sets.
//
// `run` is the shared transaction wrapper: it is the only place that waits for
// a receipt, reports the outcome, and runs the console's reload. Its contract
// is small and every clause of it matters:
//
//   · busy is true for the whole flight and false again afterwards — including
//     after a FAILURE, or the console stays locked until a reload;
//   · a receipt is awaited before the reload, or the refresh reads pre-tx state
//     and the operator sees their change vanish;
//   · a failure is reported as an error rather than swallowed;
//   · with no wallet it refuses instead of throwing somewhere less legible.

const connectMock = vi.fn();

vi.mock("../chain", () => ({
  short: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"),
  connect: (...a: any[]) => connectMock(...a),
  Session: {},
}));

// The consoles are covered by their own files; here they are replaced by a
// probe that renders the shell's props so `run` can be driven directly.
let captured: any = null;
function Probe(props: any) {
  captured = props;
  return (
    <div>
      <span data-testid="busy">{String(props.busy)}</span>
      <span data-testid="session">{props.session?.address ?? "none"}</span>
    </div>
  );
}
vi.mock("./DisputesConsole", () => ({ default: (p: any) => <Probe {...p} /> }));
vi.mock("./GovernanceConsole", () => ({ default: (p: any) => <Probe {...p} /> }));
vi.mock("./PauseConsole", () => ({ default: (p: any) => <Probe {...p} /> }));
vi.mock("./UpgradeConsole", () => ({ default: (p: any) => <Probe {...p} /> }));

const ADDRESS = "0x1111111111111111111111111111111111111111";
const busyNow = () => screen.getByTestId("busy").textContent;

/// Connect a wallet through the real chip, so `run`'s session guard is
/// satisfied the way the app satisfies it.
async function connectWallet() {
  connectMock.mockResolvedValue({ address: ADDRESS, signer: {} });
  // The chip opens a dropdown first; the mode is chosen inside it.
  fireEvent.click(screen.getByRole("button", { name: /connect/i }));
  fireEvent.click(await screen.findByRole("button", { name: /Injected wallet/ }));
  await waitFor(() => expect(screen.getByTestId("session").textContent).to.equal(ADDRESS));
}

beforeEach(() => {
  captured = null;
  connectMock.mockReset();
});
afterEach(cleanup);

describe("the shared transaction wrapper", () => {
  it("refuses to submit with no wallet connected", async () => {
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));

    const fn = vi.fn();
    await captured.run("Pause orders", fn);

    expect(fn, "submitted without a session").not.toHaveBeenCalled();
    expect(await screen.findByText(/Connect a wallet first/)).toBeTruthy();
    expect(busyNow(), "left the console locked after refusing").to.equal("false");
  });

  it("holds busy for the whole flight and releases it after", async () => {
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();

    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });

    const p = captured.run("Set fee", async () => {
      await inFlight;
      return { wait: async () => ({}) };
    });

    // This is the assertion the four console tests depend on: busy really does
    // become true while a transaction is outstanding.
    await waitFor(() => expect(busyNow()).to.equal("true"));
    release();
    await p;
    await waitFor(() => expect(busyNow()).to.equal("false"));
  });

  it("releases busy after a FAILURE too", async () => {
    // Without the `finally`, one reverted transaction locks every control in
    // the console until the operator reloads the page — during an incident.
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();

    await captured.run("Freeze orders", async () => { throw new Error("execution reverted: not-owner"); });

    expect(busyNow(), "a failed transaction left the console locked").to.equal("false");
    expect(await screen.findByText(/Freeze orders failed/)).toBeTruthy();
    expect(screen.getByText(/not-owner/)).toBeTruthy();
  });

  it("awaits the receipt BEFORE the console reloads", async () => {
    // Order matters. Refreshing on submission reads pre-transaction state, so
    // the operator watches their change appear and then vanish.
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();

    const order: string[] = [];
    await captured.run(
      "Promote orders",
      async () => ({ wait: async () => { order.push("wait"); return {}; } }),
      async () => { order.push("after"); }
    );

    expect(order).to.deep.equal(["wait", "after"]);
  });

  it("still reports success for a call that returns no receipt", async () => {
    // Not every path returns something with `.wait` — a view-ish call or a
    // stubbed signer does not. That must not be read as a failure.
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();

    const after = vi.fn();
    await captured.run("Set guardian", async () => undefined, after);

    expect(after).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Set guardian ✓/)).toBeTruthy();
  });

  it("does not run the reload when the transaction failed", async () => {
    // A refresh after a failure is wasted work at best; at worst it overwrites
    // the error toast with a clean-looking render.
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();

    const after = vi.fn();
    await captured.run("Resolve #1", async () => { throw new Error("boom"); }, after);
    expect(after).not.toHaveBeenCalled();
  });
});

describe("session handling", () => {
  it("surfaces a connection failure instead of silently staying disconnected", async () => {
    connectMock.mockRejectedValue(new Error("user rejected"));
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));

    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Injected wallet/ }));

    await waitFor(() => expect(screen.getByText(/user rejected/)).toBeTruthy());
    expect(screen.getByTestId("session").textContent).to.equal("none");
  });

  it("hands the same session down to the console", async () => {
    render(<OpsApp />);
    await waitFor(() => expect(captured).to.not.equal(null));
    await connectWallet();
    expect(captured.session.address).to.equal(ADDRESS);
  });
});
