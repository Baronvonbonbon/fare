// Client for the venue gasless relay (venue-node/relay.mjs).
//
// If VITE_RELAY_URL is set, the app prefers the venue relay for (a) gas
// sponsorship and (b) submitting settlement calls — which become gasless because
// the relay pays the gas. With no relay configured it falls back transparently to
// the central faucet + direct submission, so nothing breaks without a relay.

import { ethers } from "ethers";
import { requestDrip, sendProvider, readProvider, nativeBalance, CHAIN_ID, ADDRESSES, type DripResult } from "./chain";
import { relayPool } from "./pool";
import { shieldedFundingAvailable, fundViaShield } from "./shield";

const ENV_RELAY_URL = ((import.meta as any).env?.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, "");

/// The relay to use: a region relay discovered from a venue manifest (the DATUM
/// `manifest.relayUrl` pattern) takes precedence, with the build-time
/// VITE_RELAY_URL as the anchor/fallback. So relay location is discoverable and
/// region-scoped, not hardcoded — a venue advertising `services.relayUrl` serves
/// its region's customers automatically.
export function activeRelayUrl(): string | undefined {
  return relayPool()[0] ?? ENV_RELAY_URL;
}

export function relayConfigured(): boolean {
  return !!activeRelayUrl();
}

/// Gasless meta-txs (F8) are possible only when a relay is available AND the
/// deployment has an EIP-2771 forwarder in the address book. Pre-forwarder
/// deployments (or no relay) simply fall back to direct, gas-paying calls.
export function forwarderAvailable(): boolean {
  return !!activeRelayUrl() && !!ADDRESSES.forwarder;
}

// ── relay POST + decline handling ────────────────────────────────────────────
// The relay runs a profitability guard (venue-node/economics.mjs): it returns
// HTTP 402 when a fare's fee reward can't cover the gas it would sponsor. On a
// decline we ask the user whether to submit the tx paying their own gas.

/// Thrown when the relay declines (402) — carries its reason detail for the prompt.
class RelayDeclined extends Error {
  detail: any;
  constructor(reason: string, detail: any) { super(reason); this.detail = detail; }
}

/// POST to the relay; returns the JSON, throws RelayDeclined on 402, else Error.
/// BigInts (e.g. ZK pubSignals) are stringified.
async function postRelay(path: string, body: any): Promise<any> {
  const res = await fetch(`${activeRelayUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const j = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string; declined?: boolean };
  if (res.status === 402 || j.declined) throw new RelayDeclined(j.error ?? "relay declined", j);
  if (!res.ok || !j.txHash) throw new Error(j.error ?? `relay ${path} failed`);
  return j;
}

/// Run `relayFn`; if the relay declines, ask whether to pay own gas and, if so,
/// run the direct `directFn`. A declined-and-refused action throws "cancelled".
async function withDecline<T>(label: string, directFn: () => Promise<T>, relayFn: () => Promise<T>): Promise<T> {
  try {
    return await relayFn();
  } catch (e) {
    if (e instanceof RelayDeclined) {
      const d = e.detail ?? {};
      const why = d.rebate !== undefined ? `\n\nFee reward ${d.rebate} PAS < gas cost ${d.cost} PAS.`
        : d.action ? `\n\n(${e.message})` : "";
      const ok = typeof window !== "undefined" &&
        window.confirm(`The relay won't sponsor gas for "${label}" right now — ${e.message}.${why}\n\nSubmit paying your own gas instead?`);
      if (ok) return directFn();
      throw new Error("cancelled — nothing submitted");
    }
    throw e;
  }
}

/// Ask the venue relay to sponsor gas for `address`.
async function relayFund(address: string): Promise<DripResult> {
  const res = await fetch(`${activeRelayUrl()}/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return (await res.json().catch(() => ({}))) as DripResult;
}

/// Ensure `address` holds gas before a VALUE action (createOrder / acceptBid),
/// which must be submitted directly (the relay can't front escrow) and so needs
/// the burner to pay its own gas. Gasless non-value actions never call this, so
/// bidding/canceling/rating trigger no drip. No-op if already funded; otherwise
/// sponsors gas and waits (best-effort) for it to land. Returns true if funded.
export async function ensureGas(address: string, minWei: bigint): Promise<boolean> {
  const before = await nativeBalance(address).catch(() => 0n);
  if (before >= minWei) return true;
  const r = await sponsorGas(address);
  if (!r.funded) return r.reason === "sufficient";
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    if ((await nativeBalance(address).catch(() => before)) > before) return true;
  }
  return false; // submitted but not yet observed; caller may still proceed/retry
}

/// Fund a fresh per-order burner with `amountWei` (escrow + gas) for a value
/// action. Prefers the shielded path (C4) when a funder is installed — no
/// `main → burner` on-chain link — and falls back to the sponsored faucet/relay
/// drip otherwise. Today no shielded funder is registered (see shield.ts +
/// docs/SHIELDED-FUNDING.md), so this is exactly `ensureGas`; the C4 backend
/// makes it un-linkable by dropping in behind this one seam.
export async function fundBurner(address: string, amountWei: bigint): Promise<boolean> {
  if (shieldedFundingAvailable()) {
    try {
      const r = await fundViaShield(address, amountWei);
      if (r.funded) return true;
    } catch {
      /* shielded funder unusable → fall back to the sponsored drip */
    }
  }
  return ensureGas(address, amountWei);
}

/// Sponsor gas for `address`: venue relay first, central faucet as fallback.
/// Returns the same shape as requestDrip so existing call sites are unchanged.
export async function sponsorGas(address: string): Promise<DripResult> {
  if (activeRelayUrl()) {
    try {
      const r = await relayFund(address);
      // A definitive answer (funded / already-sufficient) short-circuits the faucet.
      if (r.funded || r.reason === "sufficient") return r;
    } catch {
      /* relay unreachable → fall back */
    }
  }
  return requestDrip(address);
}

/// Sponsored onboarding (Route A): ask the region relay to SEED a fresh
/// driver/venue wallet (existential deposit + register gas) so a new participant
/// can register and immediately begin earning — no "buy PAS first". Best-effort:
/// if no relay, onboarding is disabled, or it declines, the caller's normal
/// gas-ensure path still runs. Polls until the seed lands so the subsequent
/// register can pay its own gas. Returns true if the wallet ended up funded.
export async function sponsorOnboarding(
  address: string,
  role: "driver" | "venue",
  coords?: { lat: number; lon: number }
): Promise<boolean> {
  const url = activeRelayUrl();
  if (!url) return false;
  try {
    const res = await fetch(`${url}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, role, ...(coords ?? {}) }),
    });
    if (!res.ok) return false; // disabled (503) / out-of-region (403) / dup (429) → caller falls back
    const j = await res.json();
    if (!j.seeded && j.reason !== "already funded") return false;
  } catch {
    return false;
  }
  // Confirm by effect: wait for the seed to reflect on-chain (~24s).
  const before = 0n;
  for (let i = 0; i < 12; i++) {
    if ((await nativeBalance(address).catch(() => before)) > before) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return true; // submitted; balance not yet observed
}

/// Submit a settlement call through the relay (gasless) when configured, else
/// directly from the user's wallet. Only confirmPickup / confirmDropoffZK are
/// relayable. Returns a tx-like object with .wait() so it drops into act(). On a
/// relay decline (unprofitable) it prompts to submit paying own gas.
export async function relaySettle(
  runner: any,
  method: "confirmPickup" | "confirmDropoffZK",
  args: any[]
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  const direct = () => runner.settlement[method](...args);
  if (!relayConfigured()) return direct();
  return withDecline(method, direct, async () => {
    const j = await postRelay("/submit", { method, args });
    return { hash: j.txHash, wait: () => sendProvider.waitForTransaction(j.txHash) };
  });
}

// ── gasless user actions via EIP-2771 forwarder (F8) ─────────────────────────
// Only the NON-VALUE actions (placeBid / withdrawBid / cancelOpen /
// cancelAssigned / abandonOrder / rate) are forwardable — the contracts read
// _msgSender() for those. Value actions (createOrder / acceptBid / increaseTip)
// stay on the direct funded-burner path so the relay never fronts escrow.

const FORWARDER_ABI = ["function nonces(address owner) view returns (uint256)"];

const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

/// Build + sign the user's ForwardRequest. `signer` is the bound wallet/session
/// signer (the order burner for customer actions, the driver session otherwise).
async function buildForwardRequest(signer: any, to: string, data: string) {
  const forwarder = ADDRESSES.forwarder;
  const from = await signer.getAddress();
  const fwd = new ethers.Contract(forwarder, FORWARDER_ABI, readProvider);
  const nonce: bigint = await fwd.nonces(from);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const gas = 500_000n; // inner call cap; the relay bounds the outer execute()
  const domain = { name: "FareForwarder", version: "1", chainId: CHAIN_ID, verifyingContract: forwarder };
  const message = { from, to, value: 0n, gas, nonce, deadline: BigInt(deadline), data };
  const signature = await signer.signTypedData(domain, FORWARD_REQUEST_TYPES, message);
  // execute() takes ForwardRequestData (no nonce field); JSON-safe (no bigints).
  return { from, to, value: "0", gas: gas.toString(), deadline, data, signature };
}

/// Submit a non-value user action gaslessly through the forwarder when available,
/// else directly from the bound wallet. `contract` is the signer-bound handle
/// (its runner both signs the request and is the direct-call fallback); `target`
/// selects the on-chain address the relay is allowed to forward to. Returns a
/// tx-like object with .wait(). On a relay decline it prompts to pay own gas.
export async function relayForward(
  target: "orders" | "ratings",
  contract: any,
  method: string,
  args: any[]
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  const direct = () => contract[method](...args); // direct funded-burner path
  if (!forwarderAvailable()) return direct();
  return withDecline(method, direct, async () => {
    const data = contract.interface.encodeFunctionData(method, args);
    const request = await buildForwardRequest(contract.runner, ADDRESSES[target], data);
    const j = await postRelay("/forward", { request });
    return { hash: j.txHash, wait: () => sendProvider.waitForTransaction(j.txHash) };
  });
}

// ── gasless withdraw (F8) ────────────────────────────────────────────────────
// A driver signs a FareVault Withdraw authorization; the relay submits
// withdrawFor() and keeps withdrawFeeBps as gas reimbursement — earnings out
// with zero gas held (DATUM settleClaimsFor shape). Gated on forwarderAvailable()
// as the F8-deployment signal (the withdrawFor vault ships with the forwarder);
// pre-F8 deployments fall back to a direct, gas-paying withdraw.

const WITHDRAW_TYPES = {
  Withdraw: [
    { name: "account", type: "address" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/// Withdraw the caller's full vault balance to `recipient` (defaults to self).
/// `vaultContract` is the signer-bound FareVault handle (its runner signs +
/// reads the nonce, and is the direct-call fallback).
export async function relayWithdraw(
  vaultContract: any,
  recipient?: string
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  const signer = vaultContract.runner;
  const account: string = await signer.getAddress();
  const to = recipient ?? account;
  const direct = () => (recipient ? vaultContract.withdrawTo(recipient) : vaultContract.withdraw());
  if (!forwarderAvailable()) return direct();
  return withDecline("withdraw", direct, async () => {
    const nonce: bigint = await vaultContract.withdrawNonce(account);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const signature = await signer.signTypedData(
      { name: "FareVault", version: "1", chainId: CHAIN_ID, verifyingContract: ADDRESSES.vault },
      WITHDRAW_TYPES,
      { account, recipient: to, nonce, deadline }
    );
    const j = await postRelay("/withdraw", { account, recipient: to, deadline, signature });
    return { hash: j.txHash, wait: () => sendProvider.waitForTransaction(j.txHash) };
  });
}
