// Shielded payout DENOMINATIONS — the sizing half of the shielded-payout flow.
// Design: docs/PRIVACY-TIERS.md §4/§7. Contract: FareVault.
//
// This module used to hold the KEEPER path as well (queue → the keeper batches →
// claim). That path is gone: it named accounts at seal time, so its anonymity
// set was only the seal size, and the keeper held the account↔commitment pairing
// and could substitute its own commitments. Earnings now shield exclusively
// through the ZK note path in shieldnote.ts, which needs no keeper and hides a
// note among every unspent note in the tree.
//
// What survives here is the part both paths always shared: which denominations
// the vault accepts, and how to split a balance across them. Fixed sizes are
// load-bearing — variable amounts re-identify entries no matter what carries them.
import { Contract } from "ethers";
import { ADDRESSES, CHAIN_ID, readProvider } from "./chain";
import { VAULT_ABI } from "./abi";
import { decompose } from "./denominations";

/// Denominations the vault accepts for native payouts. Fixed sizes are what make
/// a batch worth anything — variable amounts would re-identify each entry.
export async function shieldBuckets(): Promise<bigint[]> {
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, readProvider as any);
  const n = Number(await vault.shieldBucketCount());
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(await vault.shieldBuckets(i));
  return out;
}

/// The same, for an ERC-20 payout. The vault keeps a separate ladder per asset:
/// a 1 PAS rung and a 1 USDC rung are different magnitudes in different
/// decimals, and one shared list would be nonsense.
export async function shieldBucketsToken(token: string): Promise<bigint[]> {
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, readProvider as any);
  const n = Number(await vault.shieldBucketCountToken(token));
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(await vault.shieldBucketsToken(token, i));
  return out;
}

/// The largest combination of buckets `balanceWei` covers, biggest first. The
/// remainder stays an ordinary balance — shielding it would need a denomination
/// nobody else is using, which is a fingerprint, not privacy.
export function planShielding(balanceWei: bigint, buckets: bigint[]): bigint[] {
  return decompose(balanceWei, buckets).rungs;
}
