# FARE — Network Architecture: Venues as Infrastructure

Strategy + architecture note. The thesis: **venues run the network.** Each venue
operates a node that hosts its own menu, replicates its neighbours', provides
chain access, and (later) relays gas for its region. Every new venue strengthens
local resilience and discovery — a flywheel, not just another user.

Decisions captured here (from the design Q&A):
- Replication is **protocol-incentivized** (end state), phased in from a
  reciprocal default.
- Chain access is **in-app light client first, venue RPC as a fallback pool.**
- Support **both** self-hosted appliances **and** a hosted-node fallback for
  non-technical venues.

Related: [PRODUCT-INTEGRATION-PLAN.md](PRODUCT-INTEGRATION-PLAN.md) (Group F
tracks this), [ROADMAP.md](ROADMAP.md) (federations, gasless), [PRIVACY.md](PRIVACY.md).

---

## 1. The venue appliance

A one-command Docker Compose bundle (`venue-node/`), running on a venue PC or a
small VPS:

| Component | Role |
|---|---|
| **Kubo (IPFS)** | Pins the venue's own menu + replicates region peers' menus; serves a local gateway |
| **pine-rpc light client** | Smoldot light client for the venue's own chain reads/writes; optionally exposed as a fallback RPC |
| **Venue agent** | Orchestrator: watches the chain, drives pinning, holds the pickup **hot signer**, serves a local API, publishes the venue manifest |
| **Reverse proxy** (Caddy) | Rate-limited public exposure via a Cloudflare tunnel — never raw-exposes Kubo/RPC |

Two deployment modes, same protocol:
- **Self-host** — the venue runs the compose bundle.
- **Hosted** — a "super-node" operator (FARE, or a community operator) runs the
  appliance on the venue's behalf; the venue just manages its menu in the PWA.
  The hosted publish path already exists (`/api/menu` → IPFS proxy). Non-technical
  venues are first-class; the network isn't gated on merchant sysadmin skill.

---

## 2. Data layer — geo-replicated menus

**The chain is already the replication index.** `VenueRegistered(id, operator,
lat, lon, metadataURI)` gives an agent every venue's coordinates *and* menu CID;
`GeoLib.regionOf` groups them by ~55 km cell (the same index used for order
discovery). So each node:

1. Reads `VenueRegistered` (via its light client) → the full venue set.
2. Pins **its whole region(s) generously** + a small global sample. Menus are
   <64 KB JSON, so this is cheap — a node can pin *thousands* of menus in
   <100 MB. "Small number" is the wrong frame; pin the region liberally.
3. Serves those CIDs to the DHT, so a menu resolves via **any public gateway**
   even when the origin venue is offline. **Availability never depends on one
   node being up.**

**Fix required:** `FareVenues.setMetadata` is the *only* venue mutator that emits
no event, so menu *updates* can't be watched — replicators would have to poll.
Add `VenueMetadataUpdated(uint64 indexed venueId, string metadataURI)` so re-pin
on menu change is event-driven. (Small, self-contained; do it first — Group F1.)

**The venue manifest.** The JSON behind `metadataURI` is a superset of the menu —
it's the venue's *service manifest*:

```jsonc
{
  "name": "Golden Gate Grill",
  "items": [ /* menu */ ],
  "hours": "…",
  "services": {                     // optional, forward-compatible
    "ipfsGateway": "https://…/ipfs/",
    "rpcUrl": "https://…/rpc"        // this venue's fallback RPC (§4)
  }
}
```

The **chain carries identity + the pointer; the manifest carries services.**
Clients already fetch manifests for menus, so they get the region's gateway/RPC
fallback pool for free — no extra registry contract needed.

---

## 3. Incentive model — protocol-incentivized, phased

End state: reward venues for **verified data-availability + uptime**. You can't
reward what you can't measure, so the honest path phases into it:

- **P1 — Reciprocal default (day one, no protocol change).** The agent defaults
  to "pin your region, and your neighbours pin you." Mutual benefit (local
  availability helps every venue in the region) carries it initially.
- **P2 — DA scoring, off-chain.** Random **challenge-response**: a peer node or a
  monitor fetches a random byte-range of a random *claimed* CID and checks it
  against the known content within a latency bound; combine with client
  availability reports → a per-venue **data-availability score**. Published
  leaderboard. No cryptographic proof-of-replication (Filecoin-grade) — that's
  out of scope; challenge-response + reputation is the pragmatic tier.
- **P3 — On-chain rewards.** Once scoring is trusted, reward high-DA venues via a
  **protocol-fee discount** (lower `feeBps` for the venue) and/or **token
  emission** (the DATUM token plane), gated by epoch DA scores. Avoid harsh
  slashing early — griefing risk. Likely a `FareDataAvailability` contract
  recording epoch scores + reward claims.

---

## 4. Chain access — light client first, venue RPC as a fallback pool

- **Primary: in-app smoldot light client** (`pine-embedded`, already supported).
  Trustless (state verified against finality proofs) and private (no third party
  sees the queries). This is the default for capable devices.
- **Fallback: a pool of venue RPCs** (discovered from manifests, §2) for weak
  devices (phones that can't run smoldot). Rate-limited, **multiplexed across
  several**, submit-to-multiple for censorship-resistance.

**Why venue RPC is safe — and where it isn't:**
| Property | Verdict |
|---|---|
| Custody | **Zero risk** — a light-client RPC holds no keys, touches no funds; signing is client-side |
| Read integrity | **Cannot forge** — smoldot verifies responses against consensus/finality |
| Censorship | Possible (drop a tx) → **use a pool, submit to several** |
| Privacy | Operator sees query patterns → **multiplex; keep a non-venue option** (partially erodes the burner/ZK work if used as a sole path) |

**Never make venue RPC the sole path.** It's a fallback that widens device
support, not a replacement for the client's own light client.

---

## 5. Security / threat model

- **Venue RPC**: can't steal (no custody), can't forge reads (finality proofs),
  *can* censor (→ pool) and observe queries (→ multiplex). Net: safer than a
  centralized gateway, but not a trust anchor.
- **Hot signer on the appliance**: the pickup-cosign key lives on the box. This
  is bounded — it can only release `orderValue` the customer already escrowed
  *for that venue* (see [GPS.md](GPS.md)'s adverse-interest model), and it's
  rotatable via `setSigner` (wired in Group A). Keep **only** that key hot; no
  operator/payout keys on the appliance.
- **Menu integrity**: immutable CIDs; the on-chain pointer is the trust root. An
  optional cart/menu **hash anchor** (deferred from catalog B1) would make
  "what I ordered against" provable at dispute time without changing storage.
- **Availability**: DHT + public gateway + region replication — never a single
  point.

---

## 6. On-chain changes needed

| Change | Why | Size |
|---|---|---|
| `VenueMetadataUpdated(venueId, metadataURI)` event | Cheap, event-driven menu-update replication | Small — do first |
| (optional) region as an indexed topic on venue events | Server-side region queries for replicas, mirroring `OrderRegion` | Small |
| `FareDataAvailability` (epoch DA scores + reward claims) | P3 protocol-incentivized replication | Larger — later |

No contract change is needed for menu storage, manifests, or RPC discovery — the
existing `metadataURI` pointer + off-chain manifest cover them.

---

## 7. Network-effect levers (beyond replication)

Ranked by leverage:
1. **Venue-operated gasless relays** (strongest) — region-scoped meta-tx
   (roadmap's DatumRelay pattern). Venues *subsidize gas to win orders* — perfect
   incentive alignment, and it removes the #1 UX blocker (nobody buys PAS to buy
   pad thai).
2. **Regional indexer / cache** — venue nodes serve region order+menu discovery
   (chain stays source of truth; this is caching). Faster discovery, less
   public-RPC load.
3. **Federations** (roadmap) — shared discovery, driver pools, cross-promotion;
   the replication swarm is the substrate.
4. **Offline-first discovery** — customers query nearby venue nodes on poor
   connectivity.

---

## 8. Build plan (tracking — Group F)

| # | Item | Depends on | Size |
|---|---|---|---|
| F1 | `VenueMetadataUpdated` event (+ test) | — | S (on-chain) |
| F2 | Venue appliance (`venue-node/` compose: Kubo + pine-rpc + agent) | — | M |
| F3 | Replication agent: chain-indexed region pinning + manifest publish | F1, F2 | M |
| F4 | Client: build gateway/RPC fallback pool from manifests; light-client-primary | F3 | M |
| F5 | DA scoring (challenge-response + client reports), off-chain leaderboard | F3 | M |
| F6 | On-chain DA rewards (`FareDataAvailability`: fee discount / token) | F5 | L |
| F7 | Hosted super-node mode (multi-venue appliance) | F2 | M |
| F8 | Venue-operated gasless relay (region meta-tx) | — | L |

Phasing: **F1 → F2/F3 (replication substrate) → F4 → F5 → F6**, with F7 alongside
F2 and F8 as the independent big network-effect bet.
