# FARE — Order-Scoped Messaging

Design note for driver↔customer messaging (integration plan **B3**). The
**crypto layer is built and tested** (`web/src/msg.ts`, `web/src/msg.test.ts`);
the **transport/relay is deferred** and specified here with privacy + resiliency
recommendations.

Related: [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) (the venue node is the
natural relay host), [PRIVACY.md](PRIVACY.md).

---

## 1. What's built — the crypto layer (`web/src/msg.ts`)

Reuses the Polkadot **account-key encryption pattern** (derive an encryption key
from the account key → E2E-encrypt content → carry ciphertext over a separate
transport). Parity ships no messaging app to copy, but the pattern — used by
polkadot-js as sr25519→x25519→NaCl-box — maps cleanly onto FARE's secp256k1/EVM
keys:

```
secp256k1 ECDH (ethers SigningKey.computeSharedSecret)
  → HKDF-SHA256 (salt = "fare-msg:v1:<orderId>")
  → AES-256-GCM (authenticated)
```

Properties (all covered by tests):
- **E2E** — only the two order participants hold the key; the relay never sees plaintext.
- **No key-exchange step** — each side recovers the counterparty's pubkey from a
  signature they already produced at handoff (`recoverPubKey`); the EIP-712
  `DriverCommitAttestation` / `LocationAttestation` are perfect for this.
- **Per-order scoped** — the orderId is the HKDF salt, so threads never cross or
  cross-decrypt; with per-order burner keys, threads don't link across orders.
- **Tamper-evident** — GCM authentication; a mangled ciphertext fails to open.

API: `pubKeyOf`, `recoverPubKey`, `sealMessage(myPriv, theirPub, orderId, text)`,
`openMessage(...) → text`. Transport-agnostic — it moves `{ iv, ct }` strings; it
does not care how they travel.

**Threat model / caveats:**
- **No forward secrecy.** Static ECDH → a fixed key per (pair, order). Fine for an
  ephemeral, short-lived delivery chat; a Signal-style double-ratchet is overkill.
  If a burner key later leaks, that order's thread is readable — bounded because
  keys are per-order burners and orders are short-lived.
- **Metadata isn't hidden by the cipher.** Who-talks-to-whom / when is a transport
  concern (below), not a content concern.

---

## 2. Deferred — the transport/relay

Messaging always needs *somewhere to put the ciphertext* so an offline peer can
fetch it later. Content is already E2E-encrypted, so the relay is trusted only
for **availability + delivery**, never for **confidentiality** — the same trust
split as venue-hosted RPC.

### Recommended path (phased)
1. **P1 — Simple relay (bootstrap).** A tiny store-and-forward keyed by
   `(orderId, seq)`: `POST /api/msg` to append a sealed blob, `GET /api/msg?order=`
   to fetch the thread. A Cloudflare Function + KV (mirrors `/api/drip`,
   `/api/menu`). Poll or SSE for delivery. Ships messaging in days.
2. **P2 — Venue-node relay (decentralized).** Fold the relay into the venue
   appliance ([NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md)): region-scoped,
   incentive-aligned (venues want their orders to complete), and it removes the
   central point. Clients use a **pool** of venue relays.
3. **P3 — Durable / censorship-resistant.** Pin threads to IPFS (reuse the menu
   path) for durability, and/or adopt a P2P substrate (libp2p pubsub / XMTP) so
   there's no single relay to censor.

### Privacy recommendations (transport)
- **Content is safe by construction** (E2E). The exposure is **metadata**:
  relays see `orderId`, sender IP, and timing.
  - **Per-order burners already blunt this** — an `orderId`↔burner mapping doesn't
    reveal a persistent identity. Keep threads keyed by `orderId`, not by a
    stable account.
  - **Don't index by persistent address.** Address the mailbox by a value derived
    from the order (e.g. `H(orderId, sharedContext)`) so a relay can't group a
    user's threads.
  - **Multiplex across relays** (P2) and prefer the participant's own light
    client / P2P where possible, so no single operator sees the whole graph.
  - **IP metadata**: route via the existing Cloudflare edge (P1) or onion/mixnet
    for P3; document that a relay can see IPs.
  - **Padding / fixed cadence** (optional hardening): pad ciphertext to buckets and
    send heartbeat blanks so message sizes/timing leak less.
- **Retention**: expire threads after the order terminates (Delivered/Cancelled +
  a grace window). No reason to keep a doorstep chat forever; short TTL shrinks
  the metadata trove.

### Resiliency recommendations (transport)
- **Store-and-forward, not just live** — the recipient may be offline (driver
  mid-ride, customer backgrounded). Persist sealed blobs so they fetch on
  reconnect; don't rely on a live socket alone.
- **Relay pool + client failover** — clients write/read to *several* relays
  (P2) and treat any one as unreliable; submit-to-many, read-first-success. No
  single relay outage drops messages.
- **Idempotent, ordered append** — key by `(orderId, seq)` with client-side
  sequence + dedupe, so retries across relays don't duplicate or reorder.
- **Offline compose** — let a user seal a message offline (crypto is local) and
  queue it; flush on reconnect.
- **Degrade to the QR channel** — the app already exchanges QR payloads at
  handoff face-to-face; if all relays are unreachable, fall back to showing a QR
  of the sealed blob (works with zero connectivity, the ultimate resiliency floor).
- **Bound resource use** — cap thread length / blob size (the menu proxy already
  caps at 64 KB); rate-limit per order to stop a relay being spammed.

---

## 3. Build order (B3)

| Step | Status |
|---|---|
| Crypto layer (`msg.ts`) + tests | ✅ done |
| Handoff pubkey bootstrap wiring (recover from the attestation both sides sign) | ☐ |
| P1 relay (`/api/msg` + KV) + a chat UI on the order card | ☐ |
| P2 venue-node relay + client relay pool | ☐ (with the appliance) |
| P3 IPFS/P2P durability + metadata hardening | ☐ |
