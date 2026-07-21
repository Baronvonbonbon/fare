// Client for the venue gasless relay (venue-node/relay.mjs).
//
// If VITE_RELAY_URL is set, the app prefers the venue relay for (a) gas
// sponsorship and (b) submitting settlement calls — which become gasless because
// the relay pays the gas. With no relay configured it falls back transparently to
// the central faucet + direct submission, so nothing breaks without a relay.

import { requestDrip, sendProvider, type DripResult } from "./chain";

const RELAY_URL = ((import.meta as any).env?.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, "");

export function relayConfigured(): boolean {
  return !!RELAY_URL;
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
