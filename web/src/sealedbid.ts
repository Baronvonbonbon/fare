// Sealed bids — the client half of privacy phase 4 (docs/PRIVACY-TIERS.md §6).
// Contract: FareOrders `commitBid` / `acceptSealedBid`.
//
// `BidPlaced` publishes every bid including the losing ones, and drivers are
// persistent identities, so an indexer assembles a standing record of where each
// driver was willing to work and for how much — about people who never won the
// job. The customer needs the bid; nobody else does.
//
// Three things have to hold at once, and each rules out an easier design:
//
//   • The CHAIN must not name the bidder → only a hash is committed, and a relay
//     submits it, because a driver-signed transaction names them as sender.
//   • The RELAY must not learn who bid → the terms are sealed to the customer
//     under an ephemeral key (msg.ts `sealAnon`), so the box holds ciphertext
//     with no sender.
//   • The CUSTOMER must be able to trust what they open → the revealed terms are
//     checked against the on-chain commitment before they are ever shown, so a
//     forged bid in the box cannot be accepted.
import { AbiCoder, Contract, keccak256, randomBytes, hexlify, computeAddress, type Provider, type Signer } from "ethers";
import { ADDRESSES, readProvider } from "./chain";
import { ORDERS_ABI } from "./abi";
import { sealAnon, openAnon, type AnonSealed } from "./msg";
import { fetchThread, topicOf } from "./channel";
import { postPadded } from "./relaypick";

const abi = AbiCoder.defaultAbiCoder();
const SECRETS_KEY = "fare.bids.sealed"; // this device's outstanding bids (SECRETS)

export interface SealedBidTerms {
  driver: string;
  amount: string; // wei
  salt: string; // 0x32 bytes
}

/// A bid this device made, kept so it can be revoked and so the driver can see
/// what they offered. The chain holds only `hash`.
export interface MyBid extends SealedBidTerms {
  orderId: string;
  hash: string;
  revokeSecret: string;
  createdAt: number;
}

/// Must match `FareOrders.bidHashOf` exactly — it binds the driver AND the
/// amount, so a customer cannot accept at a price nobody offered.
export const bidHashOf = (orderId: bigint, driver: string, amount: bigint, salt: string): string =>
  keccak256(abi.encode(["uint256", "address", "uint96", "bytes32"], [orderId, driver, amount, salt]));

export const revokeHashOf = (secret: string): string => keccak256(abi.encode(["bytes32"], [secret]));

const bidContext = (orderId: bigint | string) => `fare-bid:v1:${orderId}`;

// ── device-local bid store ──────────────────────────────────────────────────
const load = (): MyBid[] => {
  try { return JSON.parse(localStorage.getItem(SECRETS_KEY) || "[]"); } catch { return []; }
};
const save = (b: MyBid[]) => localStorage.setItem(SECRETS_KEY, JSON.stringify(b));
export const myBids = (orderId?: bigint): MyBid[] =>
  load().filter((b) => orderId === undefined || b.orderId === orderId.toString());

/// The customer's public key, taken from the `hello` they posted on the order
/// thread and accepted only if it derives to the order's customer address —
/// the same authentication `OrderThread.poll` applies. Without this a relay
/// could hand out its own key and read every bid.
export async function customerPubKey(orderId: bigint, customer: string): Promise<string | null> {
  try {
    for (const e of await fetchThread(topicOf(orderId))) {
      if (e.kind !== "hello" || !e.pub) continue;
      try {
        if (computeAddress(e.pub).toLowerCase() === customer.toLowerCase()) return e.pub;
      } catch { /* malformed */ }
    }
  } catch { /* transport down */ }
  return null;
}

/// Place a sealed bid: commit the hash on-chain through the relay (so the chain
/// never sees the driver), and drop the terms in the relay's bid box sealed to
/// the customer (so the relay never sees them either).
export async function placeSealedBid(
  signer: Signer, relayUrl: string, orderId: bigint, customer: string, amountWei: bigint
): Promise<MyBid> {
  const driver = await signer.getAddress();
  const custPub = await customerPubKey(orderId, customer);
  if (!custPub) throw new Error("customer hasn't published a key for this order yet — try again shortly");

  const salt = hexlify(randomBytes(32));
  const revokeSecret = hexlify(randomBytes(32));
  const hash = bidHashOf(orderId, driver, amountWei, salt);
  const terms: SealedBidTerms = { driver, amount: amountWei.toString(), salt };

  const bid: MyBid = { orderId: orderId.toString(), hash, salt, revokeSecret, driver, amount: terms.amount, createdAt: Date.now() };
  save([...load(), bid]); // before submitting: losing the salt makes the bid unacceptable

  const sealed = await sealAnon(custPub, bidContext(orderId), JSON.stringify(terms));
  const res = await postPadded(`${relayUrl}/commit-bid`, {
    orderId: orderId.toString(), bidHash: hash, revokeHash: revokeHashOf(revokeSecret), sealed,
  });
  const j = await res.json();
  if (!res.ok || !j.txHash) {
    save(load().filter((b) => b.hash !== hash));
    throw new Error(`sealed bid failed: ${JSON.stringify(j)}`);
  }
  return bid;
}

export interface OpenedBid extends SealedBidTerms {
  hash: string;
  amountWei: bigint;
}

/// Customer side: open the bid box and keep only bids that match a live on-chain
/// commitment. Anything else is noise — the box is unauthenticated by design,
/// so this check is what makes it safe to show.
export async function fetchSealedBids(
  orderId: bigint, relayUrl: string, myPrivateKey: string, provider: Provider = readProvider as any
): Promise<OpenedBid[]> {
  const res = await fetch(`${relayUrl}/bidbox?orderId=${orderId}`);
  if (!res.ok) return [];
  const { bids = [] } = await res.json();
  const orders = new Contract(ADDRESSES.orders, ORDERS_ABI, provider as any);

  const out: OpenedBid[] = [];
  for (const sealed of bids as AnonSealed[]) {
    let terms: SealedBidTerms;
    try {
      terms = JSON.parse(await openAnon(myPrivateKey, bidContext(orderId), sealed));
    } catch {
      continue; // not sealed to us, or tampered
    }
    try {
      const amountWei = BigInt(terms.amount);
      const hash = bidHashOf(orderId, terms.driver, amountWei, terms.salt);
      const onChain = await orders.sealedBid(orderId, hash);
      // Unmatched or revoked → never shown. A bid the chain doesn't hold cannot
      // be accepted, so displaying it would only invite a confusing failure.
      if (!onChain.exists || onChain.revoked) continue;
      if (out.some((b) => b.hash === hash)) continue;
      out.push({ ...terms, amountWei, hash });
    } catch { /* malformed terms */ }
  }
  return out.sort((a, b) => (a.amountWei < b.amountWei ? -1 : 1));
}

/// Retract a bid. Authorized by the secret, not a signature — a signature would
/// put the bidder's address on-chain and undo the point.
export async function revokeSealedBid(relayUrl: string, bid: MyBid): Promise<string> {
  const res = await postPadded(`${relayUrl}/revoke-bid`, {
    orderId: bid.orderId, bidHash: bid.hash, revokeSecret: bid.revokeSecret,
  });
  const j = await res.json();
  if (!res.ok || !j.txHash) throw new Error(`revoke failed: ${JSON.stringify(j)}`);
  save(load().filter((b) => b.hash !== bid.hash));
  return j.txHash;
}

/// Is the sealed path usable? The contract must expose it (an older deployment
/// won't) — callers fall back to open bids when it doesn't.
export async function sealedBidsAvailable(provider: Provider = readProvider as any): Promise<boolean> {
  try {
    const orders = new Contract(ADDRESSES.orders, ORDERS_ABI, provider as any);
    await orders.MAX_SEALED_BIDS();
    return true;
  } catch {
    return false;
  }
}
