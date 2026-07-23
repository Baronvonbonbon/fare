// Venue-node RPC pool (F4) — resilient, optionally trust-minimized chain reads.
//
// The public Paseo eth-rpc is load-balanced and inconsistent (it dropped the
// dropoff receipt in the C4 e2e; getLogs misses events). This builds a failover
// pool from a comma-separated URL list so one flaky endpoint doesn't break the
// node, and lets a venue put its OWN light client (pine-rpc / smoldot) first for
// Merkle-proof-verified reads.
//
// Priority order (highest first): PINE_RPC (local light client) → the URLs in the
// passed list. quorum=1 → first healthy response wins (fast failover, not
// consensus). Use for READS (indexing, balances, roots); a single-signer relay
// keeps a dedicated send provider for nonce safety.
import { JsonRpcProvider, FallbackProvider } from "ethers";

const CHAIN_ID = Number(process.env.CHAIN_ID || 420420417); // Paseo Asset Hub

/// Build a read provider from a CSV of RPC URLs, prepending PINE_RPC if set.
/// Returns a plain JsonRpcProvider when only one endpoint resolves, else a
/// FallbackProvider (live failover). `label` just tags startup logging.
export function buildReadPool(csv, label = "rpc") {
  const urls = [];
  if (process.env.PINE_RPC) urls.push(process.env.PINE_RPC.trim()); // local light client, highest priority
  for (const u of (csv || "").split(",").map((s) => s.trim()).filter(Boolean)) if (!urls.includes(u)) urls.push(u);
  if (urls.length === 0) throw new Error(`[${label}] no RPC URL configured`);

  if (urls.length === 1) {
    console.log(`[${label}] read RPC: ${urls[0]}`);
    return new JsonRpcProvider(urls[0], CHAIN_ID, { staticNetwork: true });
  }
  const configs = urls.map((url, i) => ({
    provider: new JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }),
    priority: i + 1, // lower = tried first; PINE_RPC (i=0) wins
    stallTimeout: Number(process.env.RPC_STALL_MS || 3000),
    weight: 1,
  }));
  console.log(`[${label}] read RPC pool (failover, quorum 1): ${urls.join("  →  ")}`);
  return new FallbackProvider(configs, CHAIN_ID, { quorum: 1 });
}
