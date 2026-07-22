// RPC fallback-pool logic — the provider-layer half of F4 (see pool.ts for the
// discovery half and docs/NETWORK-ARCHITECTURE.md §4/§5). Pure, browser-global-
// free helpers so they unit-test without the rest of chain.ts.
//
// Trust model (§4/§5): the in-app light client (smoldot / local pine daemon) is
// the trustless primary. A discovered *venue* RPC is NOT finality-verified
// client-side, so it must never become a sole trusted read path. Therefore:
//
//   - Light-client modes keep venue RPCs OUT of reads entirely.
//   - Hosted mode (weak devices that can't run smoldot) already trusts a
//     third-party RPC; there we add venue RPCs only as *lower-priority
//     fallbacks* behind the hosted anchor — liveness / censorship-resistance,
//     never displacing the non-venue anchor.
//   - Broadcasts fan out to several RPCs so one can't silently drop a tx.

export type NodeMode = "hosted" | "pine-daemon" | "pine-embedded";

export interface ReadEndpoint {
  url: string;
  priority: number; // lower = tried first (ethers FallbackProvider semantics)
}

/// Ordered read endpoints for a FallbackProvider. Only hosted mode folds in the
/// venue pool (as priority-2 fallbacks behind the hosted anchor). Light-client
/// modes return just their own endpoint — the caller uses smoldot/daemon and
/// must not downgrade reads to an unverified venue RPC. The hosted anchor is
/// always present and always first, so a venue RPC is never the sole read path.
export function readEndpoints(mode: NodeMode, hosted: string, venue: string[]): ReadEndpoint[] {
  if (mode !== "hosted") return [{ url: hosted, priority: 1 }];
  const seen = new Set<string>([hosted]);
  const eps: ReadEndpoint[] = [{ url: hosted, priority: 1 }];
  for (const u of venue) {
    if (!seen.has(u)) {
      seen.add(u);
      eps.push({ url: u, priority: 2 });
    }
  }
  return eps;
}

/// Broadcast targets: the hosted anchor plus every distinct venue RPC. Used to
/// submit a signed tx to several endpoints so a single censoring RPC can't drop
/// it (§4 "submit to several"). Hosted is always first and always included.
export function broadcastTargets(hosted: string, venue: string[]): string[] {
  return [...new Set([hosted, ...venue])];
}

/// Resolve with the first fulfilled promise; reject only if every one rejects.
/// (Like Promise.any, but hand-rolled to avoid an ES2021 lib bump and to give an
/// empty set an explicit error.) Used to fall a broadcast over to a venue RPC
/// when the hosted submission fails.
export function firstSuccess<T>(promises: Promise<T>[]): Promise<T> {
  if (promises.length === 0) return Promise.reject(new Error("no submitters"));
  return new Promise<T>((resolve, reject) => {
    let remaining = promises.length;
    for (const p of promises) {
      p.then(resolve, () => {
        if (--remaining === 0) reject(new Error("all submitters failed"));
      });
    }
  });
}
