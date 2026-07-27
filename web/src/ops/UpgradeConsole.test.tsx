// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { ethers } from "ethers";
import UpgradeConsole from "./UpgradeConsole";
import type { ConsoleProps } from "./OpsApp";

// The upgrade console, rendered (TEST-PLAN D1).
//
// C5 pinned the addressing: the console's router keys resolve to the entries
// `scripts/deploy.ts` registers, and its `upgradable` flag matches which of
// them the router accepts `upgradeContract` for. Drift there would not error —
// it would silently address a different registry slot.
//
// What that does not cover is which BUTTON the operator gets. `pauseRegistry`
// is not `FareUpgradable`, so it must be re-pointed with `register()` and never
// promoted with `upgradeContract()`; the flag decides that at render time, and
// calling the wrong one is precisely the mistake the flag exists to prevent.
//
// The other half is `checkPromotion`'s refusal to re-register the live address.
// That is blocked rather than warned about, because a no-op promotion burns a
// version bump and — with `freezeOld` ticked — freezes the contract it just
// promoted. An outage caused by doing nothing.

const OWNER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const LIVE_ORDERS = "0x3333333333333333333333333333333333333333";
const NEW_ADDR = "0x4444444444444444444444444444444444444444";

let frozenState = false;
let readsFail = false;
const sent: { fn: string; args: any[] }[] = [];

vi.mock("../chain", () => ({
  short: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"),
  nodeLabel: () => "hosted",
  syncAddressesFromRouter: async () => true,
  readProvider: {},
  ADDRESSES: { router: "0x" + "a0".repeat(20) },
}));

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeContract {
    constructor(public address: string, _abi: any, runner: any) {
      // A signer-bound handle is how the console submits; a provider-bound one
      // is how it reads. Both land here.
      (this as any).__signed = !!runner && runner !== undefined && !!(runner as any).__isSigner;
    }
    async owner() {
      if (readsFail) throw new Error("node unreachable");
      return OWNER;
    }
    async currentAddrOf(_k: string) { return LIVE_ORDERS; }
    async versionOf(_k: string) { return 3n; }
    async historyOf(_k: string) { return [LIVE_ORDERS]; }
    async frozen() { return frozenState; }
    async upgradeContract(...args: any[]) { sent.push({ fn: "upgradeContract", args }); return { wait: async () => ({}) }; }
    async register(...args: any[]) { sent.push({ fn: "register", args }); return { wait: async () => ({}) }; }
    async setContractFrozen(...args: any[]) { sent.push({ fn: "setContractFrozen", args }); return { wait: async () => ({}) }; }
  }
  // The console does `import { ethers } from "ethers"` and then
  // `new ethers.Contract(...)`, so replacing only the NAMED export leaves the
  // namespace object pointing at the real class — the mock silently does
  // nothing and every row renders empty. Both have to be overridden.
  return {
    ...actual,
    Contract: FakeContract,
    ethers: { ...actual.ethers, Contract: FakeContract },
  };
});

function props(address: string | null): ConsoleProps {
  return {
    session: address ? ({ address, signer: { __isSigner: true } } as any) : null,
    busy: false,
    run: async (_l: string, fn: () => Promise<any>, after?: () => Promise<any> | void) => { await fn(); await after?.(); },
    say: vi.fn(),
  };
}

/// The row for one registry entry, found by its name.
function row(name: string): HTMLElement {
  const head = screen.getByText(new RegExp(`^${name}(\\b| ·)`));
  return head.closest(".order") as HTMLElement;
}
const addrInput = (r: HTMLElement) => within(r).getByPlaceholderText(/new implementation address/) as HTMLInputElement;

beforeEach(() => {
  frozenState = false;
  readsFail = false;
  sent.length = 0;
});
afterEach(cleanup);

describe("upgradable vs discovery-only", () => {
  it("offers promotion for an upgradable entry", async () => {
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));

    expect(within(r).getByText(/Promote successor/)).toBeTruthy();
    expect(within(r).getByRole("button", { name: /Promote to v4/ })).toBeTruthy();
  });

  it("offers only a re-point for pauseRegistry, and labels it as such", async () => {
    // `pauseRegistry` is not FareUpgradable — it has no freeze state, and
    // `upgradeContract` on it would revert. The console must not offer it.
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("pauseRegistry"));

    expect(within(r).getByText(/discovery-only/)).toBeTruthy();
    expect(within(r).getByText(/Re-point \(discovery\)/)).toBeTruthy();
    expect(within(r).queryByRole("button", { name: /Promote/ }), "offered a promotion for a non-upgradable entry")
      .to.equal(null);
    expect(within(r).queryByRole("button", { name: /Freeze/ }), "offered a freeze for a contract with no freeze state")
      .to.equal(null);
  });

  it("calls register(), not upgradeContract(), for the discovery-only entry", async () => {
    // The flag deciding the label is not enough — it has to decide the CALL.
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("pauseRegistry"));

    fireEvent.change(addrInput(r), { target: { value: NEW_ADDR } });
    const btn = within(r).getAllByRole("button").find((b) => /Re-point/.test(b.textContent ?? ""))!;
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).to.equal(false));
    fireEvent.click(btn);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].fn, "used the upgrade path on a non-upgradable entry").to.equal("register");
  });

  it("calls upgradeContract() for an upgradable entry, carrying the freeze choice", async () => {
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));

    fireEvent.change(addrInput(r), { target: { value: NEW_ADDR } });
    const freeze = within(r).getByRole("checkbox");
    fireEvent.click(freeze); // toggle from its default

    const promote = within(r).getByRole("button", { name: /Promote to v4/ });
    await waitFor(() => expect((promote as HTMLButtonElement).disabled).to.equal(false));
    fireEvent.click(promote);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].fn).to.equal("upgradeContract");
    expect(sent[0].args[1]).to.equal(NEW_ADDR);
    expect(typeof sent[0].args[2], "the freeze flag did not reach the call").to.equal("boolean");
  });
});

describe("refusing a no-op promotion", () => {
  it("blocks re-registering the address that is already live", async () => {
    // Not a warning — blocked. A no-op promotion burns a version bump, and with
    // freezeOld ticked it freezes the contract it just promoted: an outage
    // produced by changing nothing.
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));

    fireEvent.change(addrInput(r), { target: { value: LIVE_ORDERS } });
    const promote = within(r).getByRole("button", { name: /Promote to v4/ });

    await waitFor(() => expect((promote as HTMLButtonElement).disabled).to.equal(true));
    expect(within(r).getByText(/already the current address/)).toBeTruthy();

    fireEvent.click(promote);
    expect(sent, "a no-op promotion was submitted").to.have.length(0);
  });

  it("blocks a malformed address, and accepts a well-formed one", async () => {
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));
    const promote = within(r).getByRole("button", { name: /Promote to v4/ });

    expect((promote as HTMLButtonElement).disabled, "submittable with an empty field").to.equal(true);

    fireEvent.change(addrInput(r), { target: { value: "0xnot-an-address" } });
    await waitFor(() => expect((promote as HTMLButtonElement).disabled).to.equal(true));

    fireEvent.change(addrInput(r), { target: { value: NEW_ADDR } });
    await waitFor(() => expect((promote as HTMLButtonElement).disabled).to.equal(false));
  });

  it("is case-insensitive about 'already current'", async () => {
    // Addresses arrive checksummed from a wallet and lowercased from the
    // router. A case-sensitive compare would let the no-op through.
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));

    fireEvent.change(addrInput(r), { target: { value: ethers.getAddress(LIVE_ORDERS) } });
    await waitFor(() =>
      expect((within(r).getByRole("button", { name: /Promote to v4/ }) as HTMLButtonElement).disabled).to.equal(true)
    );
  });
});

describe("router-owner authority", () => {
  it("locks every control for a non-owner", async () => {
    render(<UpgradeConsole {...props(STRANGER)} />);
    const r = await waitFor(() => row("orders"));

    fireEvent.change(addrInput(r), { target: { value: NEW_ADDR } });
    await waitFor(() =>
      expect((within(r).getByRole("button", { name: /Promote to v4/ }) as HTMLButtonElement).disabled).to.equal(true)
    );
    expect((within(r).getByRole("button", { name: /Freeze current/ }) as HTMLButtonElement).disabled).to.equal(true);
  });

  it("labels the freeze control by the contract's live state", async () => {
    // Offering "Freeze" for something already frozen would be a confusing
    // no-op at the worst time; the label follows `frozen()`.
    frozenState = true;
    render(<UpgradeConsole {...props(OWNER)} />);
    const r = await waitFor(() => row("orders"));
    expect(within(r).getByRole("button", { name: /Unfreeze current/ })).toBeTruthy();

    fireEvent.click(within(r).getByRole("button", { name: /Unfreeze current/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].fn).to.equal("setContractFrozen");
    expect(sent[0].args[2], "unfreeze sent the wrong flag").to.equal(false);
  });

  it("reports a failed load rather than an empty registry", async () => {
    readsFail = true;
    const p = props(OWNER);
    render(<UpgradeConsole {...p} />);
    await waitFor(() => expect(p.say).toHaveBeenCalled());
    expect((p.say as any).mock.calls[0][1]).to.equal(true);
  });
});
