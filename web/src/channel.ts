// Order-scoped relay channel — the shared off-chain transport for B3 messaging
// (and, by `kind`, B2 driver-location + B6 photo-key delivery). Content is E2E
// sealed by msg.ts; this file only moves opaque envelopes over the relay, so the
// relay is trusted for availability, never confidentiality (docs/MESSAGING.md).
//
// Transport chain: the shared Cloudflare KV relay (/api/msg, P1) first, then any
// discovered venue-node relays (P2, from the F8 relay pool). Threads are keyed by
// an opaque per-order `topic` = H(orderId), so a relay can't group a user's
// threads. Key bootstrap: each side posts a cleartext `hello` carrying its pubkey
// (public anyway); the peer's pubkey is AUTHENTICATED by checking it derives to
// the expected on-chain counterparty address before any message is opened.

import { ethers } from "ethers";
import { sealMessage, openMessage, pubKeyOf } from "./msg";
import { relayPool } from "./pool";

const MSG_PATH = "/api/msg"; // P1: same-origin Cloudflare Function + KV

/// Opaque per-order mailbox id. Both participants derive the same value; the
/// relay sees only the hash, never the orderId.
export function topicOf(orderId: string | bigint): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`fare-msg:v1:${orderId}`));
}

export interface Envelope {
  from: string;
  seq: number;
  kind: "hello" | "chat" | "loc" | "photo" | "profile" | "capsule";
  ts: number;
  pub?: string;
  iv?: string;
  ct?: string;
  data?: unknown;
}

/// Endpoints to try, in order: the shared KV relay, then discovered venue relays.
function endpoints(): string[] {
  return [MSG_PATH, ...relayPool().map((b) => `${b}/msg`)];
}

async function post(topic: string, msg: Envelope): Promise<boolean> {
  for (const url of endpoints()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic, msg }),
      });
      if (res.ok) return true; // 503 (unconfigured) → try the next endpoint
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function fetchThread(topic: string): Promise<Envelope[]> {
  for (const base of endpoints()) {
    try {
      const url = `${base}${base.includes("?") ? "&" : "?"}topic=${topic}&since=0`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = (await res.json()) as { messages?: Envelope[] };
      if (Array.isArray(j.messages)) return j.messages;
    } catch {
      /* try next */
    }
  }
  return [];
}

export interface ChatMsg {
  from: string;
  text: string;
  ts: number;
  mine: boolean;
}

/// A driver location update (microdegrees), delivered E2E over the channel — the
/// live-tracking payload (B2). NEVER goes on-chain; only the order's customer can
/// decrypt it.
export interface LocUpdate {
  lat: number;
  lon: number;
  ts: number;
}

/// Proof-of-delivery photo pointer (B6): the crypto-shred key + the storage id of
/// the sealed blob, wrapped E2E to the customer. The photo bytes live in blob
/// storage (/api/photo); only this key — delivered here — can decrypt them.
export interface PhotoRef {
  key: string;
  id: string;
  ts: number;
}

/// A live, E2E-encrypted thread for one order between two known participants.
/// `myPriv` is the sender's per-order/session private key (needed for ECDH — so
/// chat requires a local-key wallet, not an injected one); `peerAddr` is the
/// on-chain counterparty used to authenticate the peer's pubkey.
/// Every disclosure capsule escrowed on an order's thread, for the arbiter — who
/// holds no account in the thread and only needs what is already encrypted to
/// them. Returns the posting address alongside each capsule so the fail-closed
/// rule can be applied per party.
export async function fetchCapsules(
  orderId: string | bigint
): Promise<{ from: string; capsule: { epk: string; iv: string; ct: string } }[]> {
  const thread = await fetchThread(topicOf(orderId));
  return thread
    .filter((e) => e.kind === "capsule" && e.pub && e.iv && e.ct)
    .map((e) => ({ from: e.from, capsule: { epk: e.pub!, iv: e.iv!, ct: e.ct! } }));
}

/// The sealed chat envelopes on an order's thread, for an arbiter opening a
/// dispute with a capsule key.
export async function fetchSealedChat(
  orderId: string | bigint
): Promise<{ from: string; ts: number; iv: string; ct: string }[]> {
  const thread = await fetchThread(topicOf(orderId));
  return thread
    .filter((e) => e.kind === "chat" && e.iv && e.ct)
    .map((e) => ({ from: e.from, ts: e.ts, iv: e.iv!, ct: e.ct! }))
    .sort((a, b) => a.ts - b.ts);
}

export class OrderThread {
  private topic: string;
  private peerPub: string | null = null;
  private seq = 0;
  private seen = new Set<string>();

  private lastLocTs = 0;
  private lastPhotoTs = 0;
  private lastProfileTs = 0;

  constructor(
    private orderId: string | bigint,
    private myPriv: string,
    private myAddr: string,
    private peerAddr: string,
    private onLoc?: (loc: LocUpdate) => void, // B2: called with each new peer location
    private onPhoto?: (p: PhotoRef) => void, // B6: called with a proof-of-delivery photo pointer
    private onProfile?: (canonicalJson: string) => void // §5: peer's committed profile, revealed at assignment
  ) {
    this.topic = topicOf(orderId);
  }

  /// Announce our pubkey so the peer can derive the shared key.
  async open(): Promise<void> {
    await post(this.topic, { from: this.myAddr, seq: -1, kind: "hello", ts: Date.now(), pub: pubKeyOf(this.myPriv) });
  }

  get ready(): boolean {
    return this.peerPub !== null;
  }

  /// Seal + send a chat line. Requires the peer to have announced (re-announces
  /// ourselves and throws a friendly wait if not yet).
  async send(text: string): Promise<ChatMsg> {
    if (!this.peerPub) {
      await this.open();
      throw new Error("waiting for the other party to open the chat…");
    }
    const sealed = await sealMessage(this.myPriv, this.peerPub, this.orderId, text);
    const seq = this.seq++;
    const ts = Date.now();
    await post(this.topic, { from: this.myAddr, seq, kind: "chat", ts, iv: sealed.iv, ct: sealed.ct });
    return { from: this.myAddr, text, ts, mine: true };
  }

  /// Publish our current location to the peer (B2), sealed to their key. Uses a
  /// fixed seq so each update REPLACES the last — the thread holds only the
  /// latest position per sender, not a growing history. No-op until the peer has
  /// announced (we can't seal without their key yet).
  async sendLoc(lat: number, lon: number): Promise<boolean> {
    if (!this.peerPub) {
      await this.open();
      return false;
    }
    const sealed = await sealMessage(this.myPriv, this.peerPub, this.orderId, JSON.stringify({ lat, lon }));
    await post(this.topic, { from: this.myAddr, seq: 0, kind: "loc", ts: Date.now(), iv: sealed.iv, ct: sealed.ct });
    return true;
  }

  /// Wrap + send a proof-of-delivery photo pointer to the peer (B6). The sealed
  /// blob is stored separately (photoflow.ts); only its key + id travel here,
  /// E2E to the customer. No-op until the peer has announced.
  async sendPhoto(photoKey: string, id: string): Promise<boolean> {
    if (!this.peerPub) {
      await this.open();
      return false;
    }
    const sealed = await sealMessage(this.myPriv, this.peerPub, this.orderId, JSON.stringify({ key: photoKey, id }));
    await post(this.topic, { from: this.myAddr, seq: 0, kind: "photo", ts: Date.now(), iv: sealed.iv, ct: sealed.ct });
    return true;
  }

  /// Escrow a disclosure capsule for this order (PRIVACY-TIERS §7). Posted in
  /// the clear as far as the transport is concerned — it is already encrypted to
  /// the arbiter, and only the arbiter can open it. Idempotent by design: posting
  /// again simply supersedes, since the arbiter reads every capsule on the thread.
  async sendCapsule(capsule: { epk: string; iv: string; ct: string }): Promise<boolean> {
    await post(this.topic, {
      from: this.myAddr, seq: 0, kind: "capsule", ts: Date.now(),
      pub: capsule.epk, iv: capsule.iv, ct: capsule.ct,
    });
    return true;
  }

  /// Reveal our registration profile to the order counterparty (PRIVACY-TIERS
  /// §5). The registry holds only a commitment, so this is how the other side
  /// learns the name/vehicle/contact — and it is order-scoped, so revealing on
  /// two orders produces unrelatable ciphertexts. The RECEIVER checks the
  /// plaintext against the on-chain commitment; sending it proves nothing alone.
  async sendProfile(canonicalJson: string): Promise<boolean> {
    if (!this.peerPub) {
      await this.open();
      return false;
    }
    const sealed = await sealMessage(this.myPriv, this.peerPub, this.orderId, canonicalJson);
    await post(this.topic, { from: this.myAddr, seq: 0, kind: "profile", ts: Date.now(), iv: sealed.iv, ct: sealed.ct });
    return true;
  }

  /// Fetch the thread, learn/authenticate the peer's pubkey, and return any NEW
  /// decrypted messages from the peer (own messages are shown optimistically by
  /// send(), so they're skipped here). Also surfaces the peer's latest location
  /// (onLoc, B2) and any proof-of-delivery photo (onPhoto, B6).
  async poll(): Promise<ChatMsg[]> {
    const thread = await fetchThread(this.topic);

    // Pass 1: adopt the peer's pubkey, but only if it derives to their on-chain
    // address — this authenticates the key exchange and blocks impersonation.
    if (!this.peerPub) {
      for (const e of thread) {
        if (e.kind !== "hello" || !e.pub) continue;
        try {
          if (ethers.computeAddress(e.pub).toLowerCase() === this.peerAddr.toLowerCase()) {
            this.peerPub = e.pub;
            break;
          }
        } catch {
          /* malformed pub */
        }
      }
    }

    // Pass 2: open new chat lines from the authenticated peer.
    const out: ChatMsg[] = [];
    for (const e of thread) {
      if (e.kind !== "chat") continue;
      const id = `${e.from}:${e.seq}`;
      if (this.seen.has(id)) continue;
      if (e.from.toLowerCase() !== this.peerAddr.toLowerCase()) {
        this.seen.add(id); // own echo or a stranger — ignore
        continue;
      }
      if (!this.peerPub || !e.iv || !e.ct) continue; // can't open yet — retry next poll
      try {
        const text = await openMessage(this.myPriv, this.peerPub, this.orderId, { iv: e.iv, ct: e.ct });
        out.push({ from: e.from, text, ts: e.ts, mine: false });
      } catch {
        /* tampered / wrong key — drop */
      }
      this.seen.add(id);
    }

    // Pass 3 (B2): the peer's latest location, if newer than the last we surfaced.
    if (this.onLoc && this.peerPub) {
      let newest: Envelope | null = null;
      for (const e of thread) {
        if (e.kind === "loc" && e.from.toLowerCase() === this.peerAddr.toLowerCase() && e.iv && e.ct) {
          if (!newest || e.ts > newest.ts) newest = e;
        }
      }
      if (newest && newest.ts > this.lastLocTs) {
        this.lastLocTs = newest.ts;
        try {
          const { lat, lon } = JSON.parse(await openMessage(this.myPriv, this.peerPub, this.orderId, { iv: newest.iv!, ct: newest.ct! }));
          if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLoc({ lat, lon, ts: newest.ts });
        } catch {
          /* tampered / wrong key — drop */
        }
      }
    }

    // Pass 4 (B6): the peer's latest proof-of-delivery photo pointer.
    if (this.onPhoto && this.peerPub) {
      let newest: Envelope | null = null;
      for (const e of thread) {
        if (e.kind === "photo" && e.from.toLowerCase() === this.peerAddr.toLowerCase() && e.iv && e.ct) {
          if (!newest || e.ts > newest.ts) newest = e;
        }
      }
      if (newest && newest.ts > this.lastPhotoTs) {
        this.lastPhotoTs = newest.ts;
        try {
          const { key, id } = JSON.parse(await openMessage(this.myPriv, this.peerPub, this.orderId, { iv: newest.iv!, ct: newest.ct! }));
          if (typeof key === "string" && typeof id === "string") this.onPhoto({ key, id, ts: newest.ts });
        } catch {
          /* tampered / wrong key — drop */
        }
      }
    }
    // Pass 5 (§5): the peer's revealed registration profile. Handed up as raw
    // canonical JSON — verifying it against their on-chain commitment is the
    // caller's job (regmeta.openProfile), since only the caller knows which
    // registry entry to check.
    if (this.onProfile && this.peerPub) {
      let newest: Envelope | null = null;
      for (const e of thread) {
        if (e.kind === "profile" && e.from.toLowerCase() === this.peerAddr.toLowerCase() && e.iv && e.ct) {
          if (!newest || e.ts > newest.ts) newest = e;
        }
      }
      if (newest && newest.ts > this.lastProfileTs) {
        this.lastProfileTs = newest.ts;
        try {
          this.onProfile(await openMessage(this.myPriv, this.peerPub, this.orderId, { iv: newest.iv!, ct: newest.ct! }));
        } catch {
          /* tampered / wrong key — drop */
        }
      }
    }
    return out;
  }
}
