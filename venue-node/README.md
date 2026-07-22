# FARE Venue Node

The venue appliance (see [../docs/NETWORK-ARCHITECTURE.md](../docs/NETWORK-ARCHITECTURE.md)):
a one-command bundle that turns a venue into a network node — hosting its own
menu, replicating its region's, providing chain access, and relaying gas.

| Component | File | Group | Role |
|---|---|---|---|
| **Gasless relay** | `relay.mjs` | F8/C1 | Sponsor gas + relay settlement calls (no contract change). |
| **Replication agent** | `agent.mjs` | F3 | Chain-indexed region pinning + region-manifest publish. |
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
| `GET /health` | Relay address + gas balance + wired settlement address. |

**Deliberately not relayed:** `createOrder` / `acceptBid` / `placeBid` / `rate` /
`register`. They check `msg.sender` and/or move the user's own value. Full gasless
for those needs an **EIP-2771 forwarder** (a contract change) — the relay would
then `execute()` a user-signed request through the forwarder. That's the next
step toward end-to-end zero-friction; note the *order value itself* is always the
user's money (gasless removes the "buy PAS for gas" friction, not the payment).

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
