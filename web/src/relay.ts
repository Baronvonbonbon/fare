// Client for the venue gasless relay (venue-node/relay.mjs).
//
// If VITE_RELAY_URL is set, the app prefers the venue relay for (a) gas
// sponsorship and (b) submitting settlement calls — which become gasless because
// the relay pays the gas. With no relay configured it falls back transparently to
// the central faucet + direct submission, so nothing breaks without a relay.

import { ethers } from "ethers";
import { requestDrip, sendProvider, readProvider, nativeBalance, CHAIN_ID, ADDRESSES, type DripResult } from "./chain";

const RELAY_URL = ((import.meta as any).env?.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, "");

export function relayConfigured(): boolean {
  return !!RELAY_URL;
}

/// Gasless meta-txs (F8) are possible only when a relay is configured AND the
/// deployment has an EIP-2771 forwarder in the address book. Pre-forwarder
/// deployments (or no relay) simply fall back to direct, gas-paying calls.
export function forwarderAvailable(): boolean {
  return !!RELAY_URL && !!ADDRESSES.forwarder;
}

/// Ask the venue relay to sponsor gas for `address`.
async function relayFund(address: string): Promise<DripResult> {
  const res = await fetch(`${RELAY_URL}/fund`, {
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

/// Sponsor gas for `address`: venue relay first, central faucet as fallback.
/// Returns the same shape as requestDrip so existing call sites are unchanged.
export async function sponsorGas(address: string): Promise<DripResult> {
  if (RELAY_URL) {
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

/// Submit a relayable settlement call. Only confirmPickup / confirmDropoffZK are
/// relayable (the relay enforces this too). Returns the tx hash.
async function relaySubmit(method: "confirmPickup" | "confirmDropoffZK", args: any[]): Promise<string> {
  const res = await fetch(`${RELAY_URL}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // BigInt (e.g. ZK pubSignals) isn't JSON-serializable — stringify them.
    body: JSON.stringify({ method, args }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  const j = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
  if (!res.ok || !j.txHash) throw new Error(j.error ?? "relay submit failed");
  return j.txHash;
}

/// Submit a settlement call through the relay (gasless) when configured, else
/// directly from the user's wallet. Returns a tx-like object with .wait() so it
/// drops into the existing act() flow unchanged.
export async function relaySettle(
  runner: any,
  method: "confirmPickup" | "confirmDropoffZK",
  args: any[]
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  if (relayConfigured()) {
    const hash = await relaySubmit(method, args);
    return { hash, wait: () => sendProvider.waitForTransaction(hash) };
  }
  return runner.settlement[method](...args);
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

async function relayForwardSubmit(request: any): Promise<string> {
  const res = await fetch(`${RELAY_URL}/forward`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request }),
  });
  const j = (await res.json().catch(() => ({}))) as { txHash?: string; error?: string };
  if (!res.ok || !j.txHash) throw new Error(j.error ?? "relay forward failed");
  return j.txHash;
}

/// Submit a non-value user action gaslessly through the forwarder when available,
/// else directly from the bound wallet. `contract` is the signer-bound handle
/// (its runner both signs the request and is the direct-call fallback); `target`
/// selects the on-chain address the relay is allowed to forward to. Returns a
/// tx-like object with .wait() so it drops into act() unchanged.
export async function relayForward(
  target: "orders" | "ratings",
  contract: any,
  method: string,
  args: any[]
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  if (forwarderAvailable()) {
    const data = contract.interface.encodeFunctionData(method, args);
    const request = await buildForwardRequest(contract.runner, ADDRESSES[target], data);
    const hash = await relayForwardSubmit(request);
    return { hash, wait: () => sendProvider.waitForTransaction(hash) };
  }
  return contract[method](...args); // direct funded-burner path
}
