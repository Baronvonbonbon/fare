# FARE — Proof-of-Delivery Photos (ephemeral)

Design note for delivery photos / "leave at door" evidence (integration plan
**B6**). The requirement that shaped it: **photos must not be permanent — they
expire when no longer useful** (delivery + the dispute window).

The **sealing layer is built and tested** (`web/src/photo.ts`,
`web/src/photo.test.ts`); the **upload/submitter + capture UI + expiry job are
deferred** and specified here.

Related: [MESSAGING.md](MESSAGING.md) (the key travels over the E2E channel),
[PRIVACY.md](PRIVACY.md), [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md).

---

## 1. What's built — sealing (`web/src/photo.ts`)

A photo is encrypted under a **fresh random AES-256-GCM key** (`newPhotoKey`),
producing `{ iv, ct }`. The ciphertext goes to storage; the key travels
separately over the E2E message channel (`msg.ts`). API: `newPhotoKey`,
`sealPhoto(key, bytes)`, `openPhoto(key, sealed)`. Tested (round-trip, wrong-key
rejection, tamper rejection, and the full driver→customer wrap-the-key flow).

**Two independent expiry mechanisms** (defence in depth):
1. **Storage TTL** — Bulletin Chain auto-prunes after ~2 weeks unless renewed (§2).
2. **Crypto-shred** — because the key is fresh + random (not derived from
   long-lived account keys), discarding every copy after the order + dispute
   window makes the ciphertext **unrecoverable even if some copy lingers**. This
   is what makes expiry *guaranteed* rather than best-effort.

And it's **E2E-private meanwhile**: the key is wrapped to the customer (and, for a
dispute, the arbiter) via `msg.ts`, so a delivery photo — which may show a home,
a door, or a person — is never viewable by storage operators or the public.

---

## 2. Storage — Bulletin Chain (primary), IPFS-with-TTL (fallback)

### Polkadot Bulletin Chain — recommended
Production in 2026, purpose-built for transient content-addressed data:
- **`TransactionStorage.store({ data })`** — up to ~8 MiB/tx (chunk larger; a
  compressed delivery photo is ~50–500 KB, so one tx).
- **~2-week retention, `renew`able** — auto-prunes otherwise. This *is* the
  expiry we want; we simply **don't renew** past the dispute window.
- **Content-addressed (CID)** — reads are plain IPFS-gateway `fetch()`
  (`https://…/ipfs/<CID>`), i.e. the same read path as menus.
- **Writes are permissioned** (`authorize_account`, Root origin — a byte/tx
  quota). A driver's browser can't write directly.

**The write path** therefore mirrors `/api/menu`: an **authorized submitter**
holds a Bulletin account (quota-granted) and submits `store` on the user's behalf
— either a FARE Cloudflare Function (`/api/photo`) or, better, the **venue node**
(already an authorized, region-local infra node — see NETWORK-ARCHITECTURE.md).
The browser sends only the *ciphertext* (already E2E-sealed), so the submitter
learns nothing.

### IPFS-with-TTL — fallback
If Bulletin isn't wired: pin the ciphertext on the venue/relay node, **unpin
after the order + grace window** so the node stops serving it. Weaker (soft
expiry — no guarantee if it propagated to the DHT), but crypto-shred still makes
the *content* unrecoverable regardless.

---

## 3. Flow

1. **Capture** — driver takes the photo at dropoff (`getUserMedia` / file input);
   downscale + compress client-side (keep it well under 8 MiB and low-PII —
   frame the package, not the person).
2. **Seal** — `key = newPhotoKey()`; `sealed = sealPhoto(key, bytes)`.
3. **Store** — POST the ciphertext to the authorized submitter → Bulletin `store`
   → CID (or IPFS pin → CID).
4. **Share the key** — wrap `key` to the customer over `msg.ts`
   (`sealMessage`); attach the CID to the order's local record.
5. **View** — customer unwraps the key, fetches the CID from the gateway, decrypts.
6. **Dispute** — also wrap the key to the arbiter so evidence is viewable *during*
   the dispute; the photo still expires after resolution.
7. **Expire** — stop renewing the Bulletin storage (auto-prune ~2 wks) **and**
   both parties discard the key after the order terminates + a grace window.

---

## 4. Privacy & resiliency notes

- **Content is safe by construction** (E2E); storage/submitter see only ciphertext.
- **Minimise at capture** — downscale, strip EXIF/GPS, frame the parcel not faces;
  the best-protected pixel is the one never captured.
- **Metadata** — the CID + timing are visible to the submitter; key threads by
  `orderId`, not a persistent account (as with messaging).
- **Retention** — default TTL short (don't renew past the dispute window); expiry
  is TTL ∧ key-shred, so no single actor's retention keeps it alive.
- **Resiliency** — the sealed photo can also ride the QR/handoff channel if
  storage is unreachable; small size keeps it within one Bulletin tx / one QR set.

---

## 5. Build order (B6)

| Step | Status |
|---|---|
| Photo sealing + crypto-shred (`photo.ts`) + tests | ✅ done |
| Capture + downscale/strip-EXIF in the driver dropoff flow | ✅ done (`photoflow.ts` `compressImage`; `TrackPublisher` "📷 Delivery photo") |
| Authorized submitter → transient storage | ✅ done (`/api/photo` KV, content-addressed + ~2-wk TTL; venue-node `/photo` P2) |
| Key wrap over the channel + attach the storage id | ✅ done (`OrderThread.sendPhoto` → `kind:"photo"`; customer `TrackPanel` decrypts + views) |
| Expiry — don't-renew + key-shred | 🟡 TTL-driven (KV/venue TTL ~2 wk = "don't renew"); crypto-shred is inherent (fresh key, never persisted server-side). A proactive local key-purge after terminal + grace is the remaining nicety. |
| Bulletin Chain `store` submitter (vs the KV/IPFS demo store) | ☐ (swap `/api/photo` for the Bulletin path when it's live — §2) |

**Shipped.** Driver captures at dropoff → `compressImage` (downscale + EXIF-strip)
→ `newPhotoKey` + `sealPhoto` → `storeSealed` (content-addressed `/api/photo`,
venue `/photo` fallback) → `OrderThread.sendPhoto` wraps the key+id E2E to the
customer, whose `TrackPanel` fetches, `openPhoto`s, and renders it — expiring by
storage TTL ∧ crypto-shred. Round-trip tested (`channel.test.ts`).
