# FARE Venue Node

The venue appliance (see [../docs/NETWORK-ARCHITECTURE.md](../docs/NETWORK-ARCHITECTURE.md)):
a one-command bundle that turns a venue into a network node — hosting its own
menu, replicating its region's, providing chain access, and relaying gas.

| Component | File | Group | Role |
|---|---|---|---|
| **Gasless relay** | `relay.mjs` | F8/C1 | Sponsor gas + relay settlement calls (no contract change). |
| **Replication agent** | `agent.mjs` | F3 | Chain-indexed region pinning + region-manifest publish. |
| **DA scorer** | `scorer.mjs` | F5 | Challenge-response + client reports → per-node availability score + leaderboard. |
| **Appliance** | `docker-compose.yml` | F2 | Kubo (IPFS) + agent + relay behind a Caddy reverse proxy. |

> The in-app **smoldot light client** is the primary chain-access path (F4); the
> appliance's agent reads over RPC for now, and an optional `pine-rpc` light-client
> container as a fallback pool is deferred to F4.

## Quick start — the whole appliance (F2)

```bash
cd venue-node
cp .env.example .env             # set HOME_LAT/HOME_LON (microdegrees)
                                 # + RELAY_PRIVATE_KEY (funded) for the relay
docker compose up -d             # Kubo + agent + relay + Caddy
```

Only Caddy (`:8080`) is public: `/ipfs/*` (read-only gateway), `/agent/*`
(replication status), `/relay/*` (`/fund`, `/submit`, `/health`). Kubo's API and
the agent/relay bind the internal compose network only — never raw-exposed. Front
`:8080` with a Cloudflare tunnel (TLS + edge rate limiting) in production.

## Gasless relay (`relay.mjs`)

Removes gas friction for users in the venue's region, **with no contract changes**,
by doing the two things that are safe to relay:

| Endpoint | Does |
|---|---|
| `POST /fund { address }` | **Sponsor gas** — top up a burner below `FUND_MIN_PAS` up to `FUND_AMOUNT_PAS` (a region-local, decentralized `/api/drip`). |
| `POST /submit { method, args }` | **Relay a settlement call.** Only `confirmPickup` / `confirmDropoffZK` are allowlisted — they carry their own signatures / ZK proof and don't check `msg.sender`, so the relay submits them paying gas → those steps are fully gasless. |
| `POST /forward { request }` | **Relay a gasless user action (F8).** Submits a user-signed EIP-2771 `ForwardRequest` through `FareForwarder`. Guarded: `value` must be 0 and `to` must be `FareOrders`/`FareRatings`, so the relay pays gas but never fronts a customer's escrow. |
| `POST /withdraw { account, recipient, deadline, signature }` | **Relay a gasless withdrawal (F8).** Submits a driver-signed `FareVault.withdrawFor`; the relay is `msg.sender`, so a configured `withdrawFeeBps` reimburses its gas. Lets a driver pull earnings with zero gas held. |
| `GET /health` | Relay address + gas balance + wired settlement + forwarder + vault. |

### Relay discovery (DATUM `relayUrl` pattern)

A relay doesn't have to be hardcoded in the app at build time. Set `PUBLIC_RELAY`
on the replication agent (`agent.mjs`) and it advertises `services.relayUrl` in
the region manifest; clients learn it into a relay pool (`web/src/pool.ts`) and
prefer the discovered region relay over the build-time `VITE_RELAY_URL`. So relay
location is discoverable and region-scoped — a venue that runs a relay serves its
region's customers automatically, mirroring DATUM's `manifest.relayUrl`.

**Gasless user actions via the forwarder (F8).** `FareOrders`/`FareRatings` are
EIP-2771-aware, so the **non-value** actions — `placeBid`, `withdrawBid`,
`cancelOpen`, `cancelAssigned`, `abandonOrder`, `rate` — read `_msgSender()` and
can be meta-forwarded: the user signs a `ForwardRequest`, the relay `execute()`s
it and pays gas, and the contract still sees the *user* as the sender (the
forwarder verifies the signature). Drivers can bid fully gasless.

**Still direct (not forwarded):** the **value-bearing** actions `createOrder` /
`acceptBid` / `increaseTip`. They move the user's *own* money, so meta-forwarding
would make the relay front the escrow — instead these stay on the gas-sponsored
funded-burner path (`/fund` tops the burner up so it can pay its own value). The
order value is always the user's money; gasless removes the "buy PAS for gas"
friction, not the payment.

### Trust
The relay holds a **funded venue account and pays gas only** — it can never move a
user's funds. Worst case an abuser drains the relay's gas budget; it's
balance-gated + rate-limited, and the operator refills. Run it behind a
rate-limited reverse proxy / Cloudflare tunnel; never raw-expose it.

### Run

```bash
cd venue-node
cp .env.example .env            # set RELAY_PRIVATE_KEY (funded) + RPC
npm install
npm run relay                   # node --env-file=.env relay.mjs  (Node 22+)
```

### Point the app at it
Build the web app with `VITE_RELAY_URL=https://<your-relay-host>`. The PWA then
prefers this relay for gas sponsorship and settlement submission, falling back to
the central faucet + direct submission when it's unset or unreachable — so nothing
breaks without a relay.

## Replication agent (`agent.mjs` / F3)

Turns the chain into the replication index. `VenueRegistered(id, operator, lat,
lon, metadataURI)` gives every venue's coordinates *and* menu CID; `VenueMetadataUpdated`
(F1) makes menu *changes* watchable. The agent:

1. **Backfills + streams** venue events over RPC (paged `getLogs`, then polls).
2. **Pins its home region generously** + a small global sample to local Kubo.
   Menus are <64 KB JSON, so a node pins thousands in <100 MB — pin the region
   liberally. Home region = every ~0.5° `GeoLib` cell within `REGION_RADIUS_KM`
   of `HOME_LAT`/`HOME_LON`.
3. **Re-pins on menu change**, event-driven off `VenueMetadataUpdated`.
4. **Publishes a region manifest** (served CIDs + this node's gateway/RPC),
   pinned to Kubo — the discovery surface F4 clients build a fallback pool from.

Pinned CIDs resolve via the DHT through **any** public gateway even when the
origin venue is offline — availability never depends on one node.

Read-only against the chain; holds no keys, moves no funds; talks only to a local
Kubo RPC.

### Run standalone (without Docker)

```bash
cd venue-node
cp .env.example .env              # set HOME_LAT/HOME_LON; point KUBO_API_URL at a local Kubo
npm install
npm run agent                     # node --env-file=.env agent.mjs  (Node 22+)
curl localhost:8789 | jq          # status: pinned CIDs, region set, manifest CID
```

Key env (full list in `.env.example`): `HOME_LAT`/`HOME_LON` (microdegrees,
**required**), `REGION_RADIUS_KM`, `GLOBAL_SAMPLE`, `KUBO_API_URL`, `AGENT_RPC_URL`,
`START_BLOCK`, and `PUBLIC_GATEWAY`/`PUBLIC_RPC` (echoed into the manifest).

### Hosted super-node mode (F7)

Non-technical venues shouldn't need to run a box. A **super-node** operator (FARE,
or a community operator) runs one appliance on behalf of many venues; each venue
just manages its menu in the PWA (the hosted publish path `/api/menu → IPFS`
already exists). One instance serves many venues by setting **`HOME_COORDS`** to a
semicolon-separated list of `lat,lon` centers instead of a single `HOME_LAT`/
`HOME_LON` — the agent pins the **union** of all their regions:

```bash
HOME_COORDS="37774900,-122419400;40712800,-74006000" npm run agent
# → homes: 2 center(s)  regions=60   (both regions served from one node)
```

The relay is already region-agnostic (it funds any burner and relays any
settlement), so it serves every hosted venue's customers without extra config.
Same protocol as a self-hosted node — just more centers.

## DA scorer (`scorer.mjs` / F5)

The off-chain, measurable tier of the incentive model — you can't reward data
availability (F6) before you can measure it. Run it on a **monitor** (not
necessarily every venue); it scores the nodes it watches:

- **Challenge-response.** Each round it reads a node's region manifest (agent
  status → `manifestCid` → `servedCids`), samples random claimed CIDs, fetches a
  random **byte-range** from the node, and checks it byte-for-byte against
  canonical content from a trusted reference gateway, within a latency bound. A
  dropped pin or garbage response fails. Content is CID-addressed, so the
  reference bytes are themselves trustworthy — this proves the node holds the
  *real* content, not just *a* response.
- **Client reports.** `POST /report { node, ok }` folds in real user
  availability experience, decayed on a half-life.
- **Blend + leaderboard.** `score = W·challenge + (1−W)·clientReports`, published
  at `GET /leaderboard` (sorted, unscored nodes last).

This is deliberately **not** Filecoin-grade proof-of-replication —
challenge-response + reputation is the pragmatic tier (see NETWORK-ARCHITECTURE
§3, P2). It feeds F6 (on-chain DA rewards) once the scores are trusted.

```bash
cd venue-node
cp .env.example .env               # set SCORER_NODES=https://venueA/,https://venueB/
npm install
npm run scorer                     # node --env-file=.env scorer.mjs
curl localhost:8790/leaderboard | jq
npm test                           # node --test — scoring/blend/decay unit tests
```
