// Driver reputation for the customer's bid cards (A6r).
//
// A6 originally rendered delivered/failed per bidder, back when bid cards were
// built from the on-chain `biddersOf`/`bidOf`. Sealed bids arrive from the
// relay's bid box instead (`sealedbid.ts`), and the reputation lookup did not
// come with them — so the customer was choosing a stranger to come to their
// house on price alone. This is that lookup, rebuilt against the registry.
//
// It reads the `drivers(address)` struct rather than `reputationOf`, because the
// struct is one call for the counts AND the ban flag, and the client already
// holds its ABI.
//
// Privacy: these are public registry reads, and the customer already knows the
// bidder addresses — they are inside the terms sealed to them. So this adds no
// on-chain edge and tells the RPC nothing it could not infer from the same
// customer reading its own order. It deliberately reads only what the card
// shows.
import { Contract, type Provider } from "ethers";
import { ADDRESSES, readProvider } from "./chain";
import { DRIVERS_ABI } from "./abi";

export interface Reputation {
  delivered: number;
  failed: number;
  /// Completed jobs — the denominator the percentage is over.
  total: number;
  /// Share of completed jobs delivered, 0–100, or **null for a driver with no
  /// history at all**. Not zero and not 100: both are claims about a record that
  /// does not exist, and a new driver should read as unknown rather than as
  /// perfect or as terrible.
  successPct: number | null;
  banned: boolean;
}

export const NO_HISTORY: Reputation = {
  delivered: 0, failed: 0, total: 0, successPct: null, banned: false,
};

export function summarize(delivered: number, failed: number, banned = false): Reputation {
  const d = Math.max(0, Math.trunc(delivered));
  const f = Math.max(0, Math.trunc(failed));
  const total = d + f;
  return {
    delivered: d,
    failed: f,
    total,
    // Rounded, but never rounded UP to 100 — a driver with a failure on record
    // must not display as flawless.
    successPct: total === 0 ? null : d === total ? 100 : Math.min(99, Math.round((d / total) * 100)),
    banned,
  };
}

/// How the card renders it. Short enough to sit next to a price.
export function fmtReputation(r: Reputation): string {
  if (r.banned) return "banned";
  if (r.total === 0) return "new driver";
  return `✓${r.delivered} · ✗${r.failed} · ${r.successPct}%`;
}

/// Reputations for a set of bidders, keyed by lowercased address.
///
/// Deduped, because two bids from one driver are one driver, and a card list is
/// re-rendered on every poll. A driver whose read fails is simply absent from
/// the map — the caller shows nothing rather than a fabricated zero, since "we
/// could not reach the registry" and "this driver has never delivered" must not
/// look the same.
export async function fetchReputations(
  addresses: string[], provider: Provider = readProvider as any
): Promise<Map<string, Reputation>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const out = new Map<string, Reputation>();
  if (unique.length === 0) return out;

  const drivers = new Contract(ADDRESSES.drivers, DRIVERS_ABI, provider as any);
  await Promise.all(
    unique.map(async (addr) => {
      try {
        const d = await drivers.drivers(addr);
        out.set(addr, summarize(Number(d.delivered), Number(d.failed), Boolean(d.banned)));
      } catch {
        /* registry unreachable for this one — leave it out */
      }
    })
  );
  return out;
}
