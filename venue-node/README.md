# FARE Venue Node

The venue appliance (see [../docs/NETWORK-ARCHITECTURE.md](../docs/NETWORK-ARCHITECTURE.md)).
First component: a **gasless relay**. More (IPFS pinning, light client, menu
replication) will land alongside it.

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
