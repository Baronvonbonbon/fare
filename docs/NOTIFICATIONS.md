# FARE — Notifications (B4)

Design note for order notifications. The **foreground layer (P1) is built**
(`web/src/notify.ts` + the order-diff hook in `App.tsx`); the **background push
layer (P2) is specified here**. Research finding up front: there is **no Parity/
Polkadot native push infrastructure** and **no "AVIDITY"** service — the Polkadot
notification projects that exist ([Web3alert](https://medium.com/polkadot-news/web3alert-notification-service-for-web-3-f1cb87d8730d),
[polkadot-basic-notification](https://github.com/kianenigma/polkadot-basic-notification),
Lunie) are on-chain **wallet/validator monitors** (staking, governance) that
deliver over email/Telegram, not consumer app push. [Push Protocol](https://comms.push.org/)
is the leading Web3 push protocol but it's Ethereum/Polygon/BNB **and ties
notifications to a persistent wallet address** — which would re-link FARE's
per-order burners, so it's a non-starter here.

Conclusion: notifications are an **app-layer** concern. The *trigger* is on-chain
events FARE already surfaces; the *push service* can be the **venue node**; only
the *transport that wakes a closed PWA* (VAPID/Web Push) is unavoidably standard.

Related: [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) (the venue node is the
push host), [PRIVACY.md](PRIVACY.md), [MESSAGING.md](MESSAGING.md).

---

## 1. What's built — P1, foreground/local (`web/src/notify.ts`)

The app already polls order state (role-scoped: customer=own, driver=in-region +
own jobs, venue=own venues). The diff hook fires a **local `Notification`** on the
transitions that matter:

- **Customer** — driver assigned (→Assigned), picked up (→PickedUp), delivered.
- **Driver** — your bid was accepted (you became the order's driver); a new order
  appeared nearby.
- **Venue** — a new order came in.

`notify(title, body, tag)` no-ops unless permission is granted; `tag` dedupes per
order+kind. A 🔔 bell in the masthead requests permission (a user gesture). **No
server, no keys, no persistent identity registered anywhere** — foreground-only,
purely local, so burners stay unlinkable.

**Limitation:** the Web `Notification` API only fires while the app/its service
worker is alive (open or backgrounded). Waking a **fully-closed** PWA requires the
Push API (P2).

---

## 2. P2 — true background push (VAPID + venue-node push service)

Only the **Web Push API (VAPID)** can wake a closed PWA — the OS/browser push
service is the mechanism; nothing on-chain replaces it. But FARE keeps the trigger
and the server:

```
on-chain event  ──►  venue-node relay (watches chain, per region)
 (OrderAssigned,        │  holds device push subscriptions
  OrderPickedUp, …)     ▼
                   Web Push (VAPID)  ──►  browser push service  ──►  service worker
                                                                       │ push handler
                                                                       ▼  Notification
```

- **Trigger** — the venue-node agent already reads chain events (F3). It maps a
  relevant event (e.g. `OrderAssigned`) to the subscriptions that should hear it.
- **Push service = the venue node** — stores subscriptions, signs + sends VAPID
  Web Push. Region-local, incentive-aligned (venues want their orders to
  complete), and it folds notifications into venues-as-infrastructure instead of
  a central server. A FARE Cloudflare Function (`/api/push`) is the P1.5 fallback.
- **Transport** — standard Web Push with a VAPID keypair (public key shipped in
  the client; private key on the push service).
- **Client** — a service worker with `push` + `notificationclick` handlers; a
  `PushManager.subscribe({ applicationServerKey })` on opt-in.

### Privacy — per-device, region-filtered (decided)

Notifications must **not** re-link the per-order burners:

- **Subscribe the *device*, not an identity.** A Web Push subscription is an
  opaque endpoint (browser push service URL + keys). The push service stores the
  endpoint, never a wallet↔endpoint mapping.
- **Notify by *region*, not address.** The client tells the venue relay only its
  coarse region(s) (the same `GeoLib.regionOf` cells used for discovery). The
  relay pushes region-relevant events; the **client filters locally** for its own
  orders (it holds the per-order burner list; the relay does not). So the push
  service learns a device is "somewhere in region X interested in orders," never
  which burner/order is theirs.
- **Encrypt the payload minimally.** Push payloads should carry only a coarse
  hint (e.g. "an order in your region updated") or an opaque order-topic — never
  plaintext order details tied to an identity. The client fetches specifics over
  the existing channel/RPC after being woken.
- This is exactly why the wallet-address-linked model (Push Protocol) is rejected.

Residual metadata the push service sees: a device endpoint + its region + timing.
Bounded and non-identifying, mirroring the messaging-relay stance.

---

## 3. Build order (B4)

| Step | Status |
|---|---|
| P1 foreground/local notifications + permission bell (`notify.ts`) | ✅ done |
| Service worker `push` + `notificationclick` handlers | ☐ |
| VAPID keypair + client `PushManager.subscribe` (opt-in) | ☐ |
| Venue-node push service: store subscriptions (by region), watch chain, send Web Push | ☐ |
| Region-filter + local-order filtering (privacy) | ☐ |
| `/api/push` Cloudflare fallback (P1.5) | ☐ (optional) |

**Sources on the landscape:** [Push Protocol](https://comms.push.org/) ·
[Web3alert](https://medium.com/polkadot-news/web3alert-notification-service-for-web-3-f1cb87d8730d) ·
[polkadot-basic-notification](https://github.com/kianenigma/polkadot-basic-notification).
