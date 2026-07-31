# FARE → Polkadot App Platform: Service Map & Migration Plan

## Context

FARE (`/home/k/Documents/fare`) is a P2P delivery network — a DoorDash clone with the dispatcher
removed. Customers open pickup orders, drivers win them in an on-chain reverse auction, and
delivery settles through dual-signed GPS attestations plus a ZK proximity proof. Ten Solidity
contracts run on `pallet-revive` on Paseo Asset Hub; a React PWA is the only client; a
Dockerised "venue node" appliance supplies the off-chain services (IPFS pinning, gasless relay,
Web Push, DA scoring) and Cloudflare Functions + KV supply the rest (menu proxy, message relay,
photo store).

Every one of those off-chain services was built because Polkadot had no answer for it. That has
changed. The Polkadot App platform (Polkadot Desktop + Polkadot App mobile signer + `product-sdk`)
now ships first-party equivalents for most of FARE's non-differentiating infrastructure: Bulletin
Chain for content-addressed storage, the Statement Store for real-time signalling, DotNS for
naming, `pad` for app delivery, CDM for contract registration, People Chain for identity and
proof-of-personhood, and CASH for user-facing money.

**Decision taken:** FARE becomes a **host-native Polkadot Product** — published with `pad`, named
`fare.dot`, listed in Browse, signing routed through the Polkadot App, and built on `product-sdk`.

**Intended outcome:** retire the infrastructure FARE only owns by accident, keep and sharpen the
three things that are actually FARE's product (adverse-interest GPS settlement, ZK drop-location
privacy, and shielded/unlinkable payment flow), and ship on a distribution channel that already
has users.

---

## Part 1 — What FARE runs today

### 1.1 On-chain (Paseo Asset Hub, `pallet-revive`, chain id `420420417`)

| Contract | Role |
|---|---|
| `FareGovernanceRouter` | Upgrade authority + address registry; clients resolve live addresses |
| `FareOrders` | Escrow, sealed-bid reverse auction, lifecycle, cancellation economics |
| `FareSettlement` | EIP-712 dual-sig GPS attestation (pickup) + Groth16 proximity proof (dropoff) |
| `FareLocationVerifier` / `FareShieldVerifier` | Groth16 BN254 verifiers (precompiles `0x06/07/08`) |
| `FareVault` | Pull-payment sink + shielded-note Merkle tree (16 levels) |
| `FareDrivers` / `FareVenues` | Registries: stake, reputation, hot signer key, `metadataURI` (IPFS CID) |
| `FareRatings` / `FareDisputes` / `FarePauseRegistry` / `FareForwarder` | Ratings, bonded arbitration, per-category pause, EIP-2771 |

Addresses in `deployed-addresses.json`. Libraries: `GeoLib`, `PaseoSafeSender`, `FareUpgradable`.

### 1.2 Client — `web/`

React 18 + Vite + ethers v6 PWA. Three role views + an ops console (`web/src/ops/`).
Notable modules: `chain.ts` (provider/signer, three node modes), `abi.ts` (hand-maintained
fragments), `orderflow.ts`, `wallets.ts` (per-order burners), `msg.ts` (secp256k1 ECDH → HKDF →
AES-GCM), `channel.ts` (order-scoped transport, relay pool), `photo.ts`/`photoflow.ts`,
`zk.ts`/`shield.ts`/`shieldpool.ts`/`shieldnote.ts`, `sealedbid.ts`, `pool.ts`/`rpcpool.ts`,
`map.tsx` (MapLibre + OpenFreeMap), `push.ts`/`notify.ts`.

### 1.3 Off-chain services

| Service | Where | What it does |
|---|---|---|
| Cloudflare Pages | `web/dist` | Static hosting of the PWA |
| `/api/msg` | `web/functions/api/msg.ts` | KV store-and-forward for sealed message envelopes |
| `/api/menu` | `web/functions/api/menu.ts` | IPFS menu proxy (64 KB cap) |
| `/api/photo` | `web/functions/api/photo.ts` | Content-addressed KV blob store, ~2-wk TTL |
| Gasless relay | `venue-node/relay.mjs` | `/fund`, `/onboard`, `/submit`, `/forward` (EIP-2771), `/withdraw`, `/shield-withdraw`, `/msg`, `/photo`; profit guard in `economics.mjs` |
| Replication agent | `venue-node/agent.mjs` | Watches `VenueRegistered`/`VenueMetadataUpdated`, pins menus by geo-region into Kubo, publishes a manifest |
| Push service | `venue-node/push.mjs` | Chain-event watcher → VAPID Web Push, region-scoped |
| DA scorer | `venue-node/scorer.mjs` | Challenge-response availability scoring + leaderboard |
| Kubo | `docker-compose.yml` | IPFS node + gateway |
| Caddy | `Caddyfile` | TLS, rate limit, the only public surface |
| Treasury / swap | `treasury.mjs`, `swap.mjs` | Hydration XCM fee-recovery swaps |
| pine-rpc | optional profile | smoldot light-client eth-rpc (trust-minimised reads) |
| Kusama Shield | external `0x7d5a…e0dC` | Shielded burner funding |

---

## Part 2 — What the Polkadot platform provides

| Primitive | What it is | Hard limits that matter to FARE |
|---|---|---|
| **Polkadot App** (mobile) | Key custody + signing device. Identity on People Chain. | Signs **sr25519**, not secp256k1 |
| **Polkadot Desktop** | Host runtime where a Product executes. Never holds the key. | Products render in sandboxed iframes |
| **`product-sdk`** | `chain-client`, `signer`, `cloud-storage`, `statement-store`, `local-storage` (+ `@polkadot-apps/*`: `contracts`, `address`, `keys`, `crypto`, `tx`, `host-detect`) | — |
| **Bulletin Chain** (para 1010) | Content-addressed store. Blake2b-256 → CIDv1. Permissionless reads. | ~8 MiB/tx; auto-chunks >2 MiB into DAG-PB manifest; **~2-week TTL, must `renew`**; writes need an **authorization quota granted by an authorizer**, not bought; chunked uploads are **non-atomic** |
| **Statement Store** (People Chain pallet) | sr25519-signed gossip pub/sub. Topics + `topic2`, Channels (last-write-wins). | **512-byte payload**, **~30 s default TTL**, best-effort — no retry, no ack, no ordering, no history |
| **People Chain identity** | `people-lite` (attested username) + `proof-of-ink` (personhood). Personhood **precompile on Asset Hub** returns `(level, per-app alias)`. | Alias is stable *within* an app |
| **CASH / Coinage** | User-facing devnet dollar. pUSD asset 1 on People Chain, mirrored on Asset Hub as **50000413** with transfer restrictions. PAS still pays fees. | Restrictions vs. contract escrow are unverified |
| **DotNS** | ERC-721 `.dot` names on Asset Hub. Address, text, and **contenthash** records; reverse resolution; personhood-tiered pricing. | — |
| **`pad` CLI** | Merkleises `dist/` → 2 MiB chunks → Bulletin → writes root CID as DotNS `contenthash` → optional `Publisher.publish` for Browse | Deploying account needs Bulletin authorization |
| **Browse** | Discovery directory | — |
| **CDM** | Build → deploy to Asset Hub → register `@org/name`; ABI metadata on Bulletin, `ContractRegistry` on-chain; `cdm install` emits typed TS | — |
| **dev-dot.li gateway** | Client-side resolver; renders any published Product in a normal browser | No Host API → no host signer |
| **Platform chat/calls** | Statement Store signalling + Bulletin for encrypted media; WebRTC with platform-issued TURN creds | Calls are **mobile-only today** |
| **t3rminal / t3rminal-lite** | Reference Next.js app for wallet connect + tx submission — a pattern to copy, not a service to consume | — |

---

## Part 3 — Service-by-service verdict

**REPLACE** — Polkadot's version is strictly better and removes infra we operate:

| FARE today | Polkadot replacement | Notes |
|---|---|---|
| Cloudflare Pages hosting | `pad` → Bulletin + DotNS `contenthash` | App bundle becomes content-addressed and censorship-resistant |
| No name / raw URL | `fare.dot` via DotNS | Also gives `fare.dev-dot.li` for free |
| No discovery | `pad --publish` → Browse | Distribution FARE currently has none of |
| `web/functions/api/photo.ts` + venue `/photo` + KV TTL | Bulletin `cloudStorage.upload/fetch` | **This is already the documented plan** — `docs/PHOTOS.md` §2 names Bulletin as primary and the KV store as the demo stand-in. TTL-by-not-renewing *is* the expiry semantics that doc wants |
| `web/functions/api/menu.ts` + Kubo + `agent.mjs` pinning | Bulletin CID in `FareVenues.metadataURI` | Same read shape; `menu.ts`/`regmeta.ts` change only their fetch base |
| `scorer.mjs` DA scoring | Bulletin's own availability guarantees | The whole challenge/leaderboard mechanism becomes moot |
| Caddy + Kubo containers | — | Fall out of `docker-compose.yml` with the above |
| `web/src/abi.ts` hand-maintained fragments | `cdm install @fare/*` → generated typed helpers via `@parity/product-sdk-contracts` | Removes a known drift hazard |
| localStorage caches in `App.tsx`/`chain.ts` | `product-sdk` `local-storage` | Per-Product, per-device, host-backed |
| ZK artifact hosting (`web/public/shield/withdraw_v7.zkey.part0/1/2`) | Bulletin CID fetched at runtime | Retires the `scripts/setup-shieldnote.mjs` 25 MiB Cloudflare-Pages split hack outright |
| MetaMask / injected wallet for the *funding* account | `product-sdk` `signer` → Polkadot App | See §4.1 — this replaces the funding/identity account **only** |

**KEEP — no Polkadot equivalent exists:**

- **Gasless relay** (`relay.mjs` `/fund`, `/onboard`, `/forward`, `/submit`, `/withdraw`) + the
  EIP-2771 `FareForwarder` + `economics.mjs` profit guard. The platform has a faucet, not
  programmable third-party gas sponsorship with a profitability guard.
- **Hydration fee-recovery swaps** (`treasury.mjs`, `swap.mjs`).
- **Kusama Shield** shielded burner funding. CASH is not private; nothing on the platform is.
- **The ZK stack** — `circuits/proximity.circom`, `circuits/shieldnote.circom`, snarkjs browser
  proving, the Groth16 verifiers. This is the product.
- **EIP-712 dual-sig GPS attestation.** See §4.1.
- **MapLibre + OpenFreeMap.** No platform mapping primitive.
- **pine-rpc.** Complementary — keep as the trust-minimised node option alongside the host client.
- **`msg.ts` crypto layer.** Only the transport moves; the ECDH→HKDF→AES-GCM sealing stays.

**DUAL-PATH — adopt as default, keep the existing path as fallback:**

| FARE today | Polkadot | Why both |
|---|---|---|
| `channel.ts` over `/api/msg` + venue `/msg` | Statement Store for `hello`/`loc`/presence; Bulletin for durable `chat`/`photo` bodies | 512 B + 30 s TTL + no history cannot carry store-and-forward chat alone (§4.2) |
| `push.mjs` VAPID Web Push | Statement Store channels for foreground/live signals | Statement Store has no background wake-up. Push stays for "a bid landed while the app is closed" |
| Hosted eth-rpc / pine / in-browser smoldot (`chain.ts`, `rpcpool.ts`) | `chain-client` (host-routed) | Host path when running in Desktop; existing node picker everywhere else |
| `deployed-addresses.json` + `FareGovernanceRouter` | CDM `ContractRegistry` | Router remains the *upgrade authority*; CDM adds name→address discovery and published ABIs |

**ADOPT — new capability FARE doesn't have:**

- **Proof-of-personhood** via the Asset Hub precompile — as a Sybil gate on `FareDrivers.register`
  and `FareVenues.registerVenue`. See §4.4.
- **CASH (pUSD)** as the demo settlement asset. `FareOrders` is already token-agnostic (the C3
  ERC-20 path, exercised by `scripts/e2e-stablecoin.mjs`), so this is a config change *if* §4.5
  clears.
- **`.dot` names for venues** — `pizzaplace.fare.dot` subnames instead of opaque `venueId`s.

---

## Part 4 — The conflicts that decide the design

### 4.1 sr25519 host signing vs. `ecrecover` — the load-bearing one

`FareSettlement.confirmPickup` verifies **two** EIP-712 secp256k1 signatures with `ecrecover`, and
`confirmDropoffZK` verifies a driver commit attestation the same way. The Polkadot App holds an
**sr25519** key. `pallet_revive::map_account` maps a 32-byte Substrate account to an H160 for
*origin* purposes — it does **not** let that key produce an `ecrecover`-able signature.

**Recommendation — no contract changes.** The host account becomes the *funding and submission*
identity; attestation signing stays on app-local secp256k1 keys. This is already how FARE works:
the venue hot signer (`FareVenues.setSigner`, rotatable) and the per-order burners in
`web/src/wallets.ts` are app-managed secp256k1 keys by design. The change is that burners get
**funded from and seeded by** the host-signed account instead of an injected wallet.

Consequence to state plainly: **the Polkadot App is not the signer for the GPS cosign step.** The
signing modal appears for funding, registration, and order creation — not for the doorstep handoff.
That is the correct outcome anyway (a driver at a door cannot round-trip to a phone modal per
attestation), but it must be a stated design decision, not an accident.

**Refinement:** derive burners from the product-scoped account rather than raw randomness.
`ProductAccountId = (dotNsIdentifier, derivationIndex)` is deterministic and reproducible across
sessions, so a per-order `derivationIndex` gives recoverable burners without a seed backup — a
straight UX win over today's localStorage-only keys.

### 4.2 Statement Store cannot be the chat transport by itself

512-byte payloads, ~30 s TTL, best-effort delivery, no history. `channel.ts` is store-and-forward
precisely because the counterparty is often offline (driver mid-ride, customer backgrounded).

**Recommendation — mirror what Polkadot App's own Chat does:** Bulletin holds the sealed body,
the Statement Store carries the CID plus live signals. Map onto FARE's existing `kind` tags:

| `kind` | Transport |
|---|---|
| `hello` (pubkey handshake) | Statement Store — small, live, re-sendable |
| `loc` (live tracking ping) | Statement Store **Channel** (last-write-wins is exactly right for a position) |
| `chat` | Bulletin body + Statement Store CID announcement; existing relay as offline backfill |
| `photo` | Bulletin (already the plan) + Statement Store CID announcement |

`web/src/msg.ts` is untouched. `web/src/channel.ts` gains a transport strategy; `channel.test.ts`
already integration-tests the seam.

### 4.3 Statement Store signing re-links orders — a real privacy regression

Statements are sr25519-signed by a People Chain account. FARE's entire unlinkability story
(`docs/PRIVACY.md`, `docs/PRIVACY-TIERS.md`) rests on per-order burners with no persistent
identity. If order threads are signed by the user's People Chain account, **every order links to
one identity at the gossip layer** — undoing Kusama Shield funding, sealed bids, and ZK dropoff in
one step.

**Recommendation:** use the Statement Store only where linkage is already public or harmless —
order-board fanout, venue presence, driver availability. Keep order-scoped threads on the
burner-signed relay path. Then spike whether a **fresh `derivationIndex` per order can hold its
own statement-store allowance**; if yes, per-order statement identities restore unlinkability and
the relay can be retired for chat too. Treat that spike as the gate, not an assumption.

### 4.4 Personhood must not touch the customer side

The personhood precompile returns a per-app alias — unlinkable *across* apps, but **stable within
FARE**. Gating order creation on it would give every order a common identifier.

**Recommendation:** personhood gates `FareDrivers.register` and `FareVenues.registerVenue` only —
parties whose reputation, stake, and ratings are already public on-chain, and where Sybil
resistance is worth real money (it hardens the sealed-bid auction against bid-flooding and makes
`FareDisputes` arbitration meaningful). **Never** on the customer/order path.

### 4.5 CASH transfer restrictions vs. contract escrow — unresolved

pUSD is mirrored on Asset Hub as asset `50000413` **with transfer restrictions**. `FareOrders`
escrow requires a contract to custody the asset and `FareVault` to pay it out. Whether a
`pallet-revive` contract can hold and move restricted pUSD is not documented.

**This is a blocking spike before any CASH work.** Fallback if it fails: keep `MockUSDC`/PAS for
escrow and surface CASH only as a display/top-up rail.

### 4.6 Bulletin's 2-week TTL inverts the venue node's job

IPFS pins are indefinite; Bulletin prunes at ~2 weeks unless renewed, and each renewal returns a
**new** `(blockNumber, extrinsicIndex)` that must be tracked for the next one. Menus need to
persist; photos must not.

**Recommendation:** the venue node stops being a *pinning* node and becomes a **renewal keeper** —
it holds the Bulletin authorization, submits `store` on behalf of venues and drivers (the
"authorized submitter" role `docs/PHOTOS.md` §2 already specifies), renews menu CIDs, and
deliberately does not renew photo CIDs past the dispute window. Less infra, same incentive story,
and the crypto-shred guarantee in `photo.ts` is unaffected.

Operational dependency to flag: **Bulletin write authorization is granted, not purchased**
(`authorize_account`, Root or People Chain via XCM). Self-serve venue onboarding needs an
authorization grant per account or a shared submitter. Plan for the shared submitter.

### 4.7 Where does the driver surface actually run?

Polkadot Desktop is the Product runtime; the docs describe calls as mobile-only and do not
establish that Products run inside the mobile app. A delivery driver is on a phone, on the road,
needing `getUserMedia` and the Geolocation API.

**Recommendation — one build, three runtimes**, gated by `@polkadot-apps/host-detect`:

| Runtime | Signer | Storage / transport |
|---|---|---|
| Polkadot Desktop (Host API present) | `product-sdk` signer → Polkadot App | Host-routed chain-client, cloud-storage, statement-store |
| `fare.dev-dot.li` in mobile Chrome/Safari | App-local burners + relay onboarding (today's path) | Direct Bulletin/Statement Store clients, or relay fallback |
| Standalone PWA (unchanged) | Injected wallet or burners | Existing Cloudflare/venue-node path |

All three are served from the same Bulletin CID under the same `.dot` name. The gateway path is
what makes the driver surface viable regardless of how the mobile runtime question resolves — and
it is worth confirming with Parity early rather than designing around a guess.

---

## Part 5 — Target architecture

```
                      fare.dot  (DotNS, contenthash → Bulletin CID)
                            │
            ┌───────────────┼───────────────────┐
   Polkadot Desktop    fare.dev-dot.li     standalone PWA
   (Host API)          (mobile browser)    (unchanged)
            │               │                   │
            └──────── host-detect ──────────────┘
                            │
   ┌────────────┬───────────┼────────────┬──────────────┐
   │            │           │            │              │
chain-client  signer   cloud-storage  statement-store  local-storage
   │            │           │            │
   │       Polkadot App  Bulletin    People Chain
   │       (sr25519,     • app bundle  • hello / loc
   │        funding +    • menus       • CID announcements
   │        submission)  • photos      • presence
   │                     • ZK zkey
   ▼
Asset Hub / pallet-revive
   • FARE contracts (unchanged) — registered in CDM ContractRegistry
   • personhood precompile → driver/venue Sybil gate
   • Kusama Shield pool
   • Groth16 + Poseidon precompiles
        ▲
        │  KEEP (no platform equivalent)
   venue-node (shrunk): gasless relay + EIP-2771 forwarder + profit guard
                        + Bulletin authorized submitter / renewal keeper
                        + Web Push (background wake-up)
                        + Hydration fee-recovery swaps
   RETIRED: Kubo, Caddy, agent.mjs pinning, scorer.mjs, /api/{msg,menu,photo}
```

**Net effect:** venue-node drops from 6 processes to 2–3; three Cloudflare Functions and the KV
namespace disappear; the 34 MB zkey split hack disappears; FARE gains a name, a listing, a
content-addressed bundle, and an identity layer it did not have.

---

## Part 6 — Execution phases

### Phase 0 — Land the plan and clear the blockers
1. ✅ This document, cross-linked from `README.md` §Docs, `docs/PHOTOS.md` §5 (the Bulletin row),
   `docs/MESSAGING.md` §2 (P3), and `docs/ROADMAP.md`.
2. **Spikes, in this order — each gates real work:**
   - **S1** Bulletin write authorization: can we get an authorized account on Paseo, and what
     quota? (gates everything storage)
   - **S2** Mobile Product runtime: do Products run in the mobile app, or is `dev-dot.li` the
     driver path? (gates §4.7)
   - **S3** Per-order `derivationIndex` statement-store allowance (gates §4.3)
   - **S4** CASH/pUSD custody by a `pallet-revive` contract (gates §4.5)
   - **S5** Host signer + `pallet_revive::map_account` → can the host account submit a FARE tx at
     all? Confirms §4.1's split.

### Phase 1 — Ship as a Product (no behaviour change)
- Add `@parity/product-sdk` + `@polkadot-apps/host-detect`; introduce a `host` capability layer in
  `web/src/chain.ts` alongside the existing three node modes.
- Register `fare.dot` (DotNS), publish with `pad ./web/dist fare.dot --env devnet --publish`.
- Keep every existing service running. Success = the current app, unchanged, loads from Bulletin
  under `fare.dot` in Desktop and at `fare.dev-dot.li`.

### Phase 2 — Storage migration (highest value, lowest risk)
- **Photos first** — `web/src/photoflow.ts` `storeSealed` → `cloudStorage.upload`; customer read
  path → `cloudStorage.fetch` + `computeCid` verification. Retire `web/functions/api/photo.ts` and
  venue `/photo`. Closes the open ☐ in `docs/PHOTOS.md` §5.
- **Menus** — `web/src/menu.ts` / `regmeta.ts` read from Bulletin; venue publish path writes via
  the authorized submitter. Retire `web/functions/api/menu.ts`, `venue-node/agent.mjs`, Kubo,
  `venue-node/scorer.mjs`, Caddy from `docker-compose.yml`.
- **Renewal keeper** — new small `venue-node` job tracking `(blockNumber, extrinsicIndex)` per
  menu CID, renewing menus and *not* renewing photos.
- **ZK artifacts** — upload `withdraw_v7.zkey` to Bulletin, fetch by CID in `web/src/zk.ts`;
  delete the part-splitting in `scripts/setup-shieldnote.mjs`.

### Phase 3 — Contracts through CDM
- `cdm` build/deploy/register the ten contracts as `@fare/*`; publish ABIs to Bulletin.
- Replace `web/src/abi.ts` with generated typed helpers; migrate call sites in `chain.ts`,
  `orderflow.ts`, `relay.ts`, `shield*.ts`, and `web/src/ops/*`.
- `FareGovernanceRouter` stays the upgrade authority; CDM registration is additive.

### Phase 4 — Messaging & signalling
- `web/src/channel.ts` gains a Statement Store transport per the §4.2 table, with the relay as
  offline backfill. `channel.test.ts` extends to cover both transports.
- Statement Store Channels for `loc` and presence; keep `push.mjs` for background wake-up.
- Gate the chat-over-Statement-Store move on **S3**; if S3 fails, chat stays on the burner-signed
  relay and only `hello`/`loc`/presence move.

### Phase 5 — Identity & money
- Personhood precompile gate on `FareDrivers.register` / `FareVenues.registerVenue`
  (contract change — new `FareDrivers`/`FareVenues` version through the freeze-and-drain path in
  `lib/FareUpgradable`).
- `.dot` subnames for venues; reverse resolution in the driver board and order cards.
- CASH as settlement asset **only if S4 clears**; otherwise CASH as a display/top-up rail.

### Phase 6 — Prune
- Delete retired Cloudflare Functions and the KV namespace; slim `docker-compose.yml` and
  `venue-node/.env.example`; update `docs/NETWORK-ARCHITECTURE.md` to the "renewal keeper +
  sponsor" model; refresh `README.md` §Node options.

---

## Part 7 — Verification

- **Per phase:** the existing gates must stay green — `npx hardhat test`, `cd web && npx vitest
  run --coverage` (38% floor in `web/vite.config.ts`), `cd venue-node && node --test`, plus
  `slither.yml` and the `gas-snapshot.json` ±5% CI gate.
- **Phase 1:** `pad` publish succeeds; app loads in Desktop and at `fare.dev-dot.li`; `host-detect`
  correctly reports host-present vs. host-absent in both.
- **Phase 2:** extend `scripts/e2e-combined.mjs` to assert a photo round-trips through Bulletin —
  upload → CID → `computeCid` match → customer decrypt via `openPhoto`. Assert a menu CID resolves
  with Kubo stopped. Assert a non-renewed photo CID is unreachable after TTL (or simulate).
- **Phase 3:** re-run the full live e2e suite (`e2e-gasless`, `e2e-stablecoin`,
  `e2e-fresh-shielded`, `e2e-combined`) against CDM-resolved addresses; diff against the reports in
  `docs/E2E-*.md`.
- **Phase 4:** `channel.test.ts` covers both transports; manual two-device test — send `chat` and
  `loc` with the peer offline, confirm backfill on reconnect.
- **Phase 5:** contract tests for the personhood gate incl. the rejection path; confirm no
  personhood call exists on any customer/order code path (grep gate in CI).
- **End-to-end demo:** a full delivery — create → sealed bid → accept → cosigned pickup → ZK
  dropoff → photo → rate → vault withdraw — run entirely from `fare.dot` in Polkadot Desktop, with
  Kubo and the Cloudflare Functions stopped.

---

## Part 8 — Open questions to put to Parity

1. Do Products run inside the mobile Polkadot App, or is `dev-dot.li` the only mobile path? What
   device APIs (camera, geolocation, background) reach a Product? *(S2 — biggest product risk)*
2. Bulletin authorization on Paseo: how is it obtained, what quota, and can a Product act as a
   shared authorized submitter for its users? *(S1)*
3. Can a per-Product `derivationIndex` account hold its own statement-store allowance? *(S3)*
4. Can a `pallet-revive` contract custody and transfer restricted pUSD (asset 50000413)? *(S4)*
5. Is there any path from a host-signed sr25519 key to an `ecrecover`-verifiable signature, or a
   sr25519-verification precompile on Asset Hub? *(would simplify §4.1 substantially)*
6. Is Bulletin the intended long-term home for the Kusama Shield pool, and does that change the
   integration in `web/src/shieldpool.ts`?
