// App-side wiring for disclosure capsules (docs/PRIVACY-TIERS.md §7).
// Crypto lives in capsule.ts; this is the part that knows about the chain, the
// arbiter's identity, and the order thread.
import { Contract } from "ethers";
import { ADDRESSES, readProvider } from "./chain";
import { DISPUTES_ABI } from "./abi";
import { pubKeyOf, recoverPubKey } from "./msg";
import { OrderThread } from "./channel";
import { sealCapsule, arbiterKeyMatches } from "./capsule";

export { evidenceURI, evidenceMatches, openCapsule, capsuleDigest, type Capsule } from "./capsule";

/// The arbiter's public key, configured out of band. An ADDRESS can't be
/// encrypted to — only a public key can — and the chain stores the address, so
/// this is supplied by config and then checked against the chain below.
function configuredArbiterKey(): string | undefined {
  return ((import.meta as any).env?.VITE_ARBITER_PUBKEY as string | undefined)?.trim() || undefined;
}

/// The arbiter key to seal to, or null if there isn't a trustworthy one.
///
/// Config alone is not enough: a wrong or hostile key would hand the order
/// thread to whoever supplied it. The key is only used once it derives to the
/// address `FareDisputes.arbiter()` actually names, which makes a bad config a
/// no-op rather than a silent leak.
export async function verifiedArbiterKey(): Promise<string | null> {
  const pub = configuredArbiterKey();
  if (!pub) return null;
  try {
    const disputes = new Contract(ADDRESSES.disputes, DISPUTES_ABI, readProvider as any);
    const onChain: string = await disputes.arbiter();
    return arbiterKeyMatches(pub, onChain) ? pub : null;
  } catch {
    return null; // can't verify → don't encrypt
  }
}

/// Escrow this party's capsule on the order thread. Called when the thread
/// opens, so the capsule exists BEFORE anyone knows whether there will be a
/// dispute — a party who could decide afterwards would simply decline.
///
/// Needs the counterparty's public key, which the thread learns from their
/// `hello`. Returns false when there's nothing trustworthy to seal to or the
/// peer hasn't announced yet; the caller retries on a later poll.
export async function escrowCapsule(
  orderId: bigint | string, myPrivateKey: string, myAddress: string, peerAddress: string
): Promise<boolean> {
  const arbiterPub = await verifiedArbiterKey();
  if (!arbiterPub) return false;

  const peerPub = await peerPubKey(orderId, peerAddress);
  if (!peerPub) return false;

  const capsule = await sealCapsule(arbiterPub, myPrivateKey, peerPub, orderId);
  // `from` must be our real address: the arbiter applies fail-closed per party,
  // so an unattributable capsule is the same as no capsule.
  const thread = new OrderThread(orderId, myPrivateKey, myAddress, peerAddress);
  return thread.sendCapsule(capsule);
}

/// The counterparty's public key as announced on the thread, accepted only if it
/// derives to their on-chain address — the same authentication `OrderThread.poll`
/// applies, so a capsule can't be sealed against an impersonator's key.
async function peerPubKey(orderId: bigint | string, peerAddress: string): Promise<string | null> {
  const { fetchThread, topicOf } = await import("./channel");
  const { computeAddress } = await import("ethers");
  try {
    for (const e of await fetchThread(topicOf(orderId))) {
      if (e.kind !== "hello" || !e.pub) continue;
      try {
        if (computeAddress(e.pub).toLowerCase() === peerAddress.toLowerCase()) return e.pub;
      } catch { /* malformed pub */ }
    }
  } catch { /* transport down */ }
  return null;
}

export { pubKeyOf, recoverPubKey };
