# FARE — P2P Delivery Network on Polkadot Hub

FARE connects **customers**, **drivers**, and **venues** (restaurants / stores)
directly, with no dispatch intermediary. A customer opens a pickup order, drivers
compete in an on-chain **reverse auction** for the delivery fare, and the
delivery itself settles through **dual-signed GPS attestations** — two parties
with adverse interests co-sign their coordinates, and the contract verifies the
signatures and the geometry.

Built on the Polkadot tech stack: EVM contracts (solc 0.8.24 / cancun) running
on pallet-revive, deployed to the **Paseo** testnet. Toolchain, deploy
workarounds, and safety patterns are carried over from the
[DATUM](../datum) alpha-core line.

## How a delivery works

```
CUSTOMER                    DRIVERS                    VENUE
   │ createOrder                │                        │
   │  escrow: orderValue+tip    │                        │
   │  dropCommit = H(lat,lon,s) │                        │
   │◄──────── placeBid(fare) ───┤  (reverse auction)     │
   │ acceptBid ──► escrow fare  │                        │
   │                            │── drive to venue ─────►│
   │                            │   both sign GPS        │ sign GPS
   │                            │   confirmPickup ═══════╪══► orderValue → venue
   │                            │── drive to customer    │
   │ sign handoff (reveal drop) │                        │
   │   confirmDropoff ══════════╪══► fare + tip → driver │
   ▼                            ▼                        ▼
 done                     paid (pull)               paid (pull)
```

- **Fare is the only required flow.** `orderValue`, `tip`, and stakes/bonds all
  accept 0 — a venue with an existing POS can onboard with zero payment-rail
  migration, then adopt full escrow later.
- **Customer picks the winning bid** — any bid, not forced-lowest, so driver
  reputation and stake can outweigh a marginally cheaper bid.
- **Drop location privacy:** only `keccak256(lat, lon, salt)` goes on-chain at
  creation. Coordinates are revealed at the dropoff moment (see
  [docs/GPS.md](docs/GPS.md) for the trust model and the ZK upgrade path).
- **All payouts are pull-payments** through `FareVault` — no push-payment
  griefing, one auditable money-out path.

## Contracts (8)

| Contract | Role |
|---|---|
| `FareGovernanceRouter` | Upgrade authority + on-chain address registry (clients auto-follow upgrades) |
| `FareOrders` | Order book: escrow, reverse auction, lifecycle, cancellation economics |
| `FareSettlement` | EIP-712 dual-sig GPS attestation verification (pickup + dropoff) |
| `FareVault` | Pull-payment vault for every payout (venue, driver, refunds, fees) |
| `FareDrivers` | Driver registry, optional stake, reputation, slash hook |
| `FareVenues` | Venue registry: public location pin, hot signer key, payout address |
| `FareDisputes` | Bonded, arbitrated escape hatch for stuck orders |
| `FarePauseRegistry` | Per-category emergency pause (guardian fast-pause, owner unpause) |

Plus `lib/GeoLib` (fixed-point equirectangular proximity math, Bhaskara cosine),
`lib/PaseoSafeSender` (defeats the Paseo eth-rpc denomination bug), and
`lib/FareUpgradable` (freeze-and-drain upgrade base — entry mutators freeze,
exits always drain; see docs/ARCHITECTURE.md "Upgradability").

## Quick start

```bash
npm install
npm test                                   # 29 tests

# local end-to-end
npx hardhat node                           # terminal 1
npm run deploy:local && npm run seed:local # terminal 2
cd web && npm install && npm run dev       # terminal 3 → http://localhost:5180

# Paseo
cp .env.example .env                       # add DEPLOYER_PRIVATE_KEY
npm run deploy:paseo
```

The web app (`web/`) is a mobile-first PWA with three role views — Customer,
Driver, Venue. The driver view is the primary surface: it signs EIP-712
location attestations from the device GPS via the browser Geolocation API.
Counterparty signatures travel as copy-paste codes (QR in the roadmap), so the
whole demo runs peer-to-peer with no backend.

## Node options — the trust gradient

Every interface surface can choose how it reaches the chain, from convenient
to trust-minimized. Pine is [pine-rpc](../pine-rpc): a standalone eth-rpc
node backed by a **smoldot light client** that verifies Merkle proofs over
P2P instead of trusting a gateway.

| Surface | Hosted gateway | Pine daemon (local light client) | In-browser light client |
|---|---|---|---|
| Web PWA (customer/driver/venue) | default | node picker → "Pine daemon" | node picker → "In-browser light client" (experimental, Paseo only) |
| Deploy / seed / ops scripts | `--network polkadotTestnet` | `--network pine` (or `TESTNET_RPC=http://127.0.0.1:8545`) | — |
| Local dev | `--network localhost` | — | — |

```bash
# run the local light-client node (from ~/Documents/pine-rpc or npx)
pine --chain paseo-asset-hub          # eth-rpc on http://127.0.0.1:8545

npm run deploy:paseo -- --network pine   # deploy through the light client
```

The web app's node picker (chip next to the wallet) persists per device and
reloads on switch. The in-browser mode runs smoldot inside the tab via
pine-rpc's EIP-1193 `PineProvider` — first sync takes ~10–60 s; the WASM is
code-split so the default bundle stays light.

Known limits (see pine-rpc `CAPABILITIES.md`, the source of truth):
`eth_getCode` currently hangs on Asset Hub (deploy.ts skips code
verification on the `pine` network and relies on nonce confirmation), WS
subscriptions don't push (the app polls, so unaffected), and receipts are
session-scoped to transactions submitted through Pine.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — contract-by-contract design, flows, wiring
- [docs/GPS.md](docs/GPS.md) — what "GPS proof" really proves; threat model; ZK path
- [docs/ROADMAP.md](docs/ROADMAP.md) — path from MVP to a formal, complete product
- [docs/DEMO-LAUNCH.md](docs/DEMO-LAUNCH.md) — demo-launch plan: pilot next steps, mobile client path, merchant readiness, Parity/W3F infra

## Provenance

Patterns inherited from the DATUM alpha-core deployment on Paseo:
`PaseoSafeSender` (denomination bug), nonce-polling deploys (null-receipt bug),
pull-payment vaults, dual-EIP-712-cosig settlement, optional-stake registries
with governance-raisable floors, per-category pause registry.

License: GPL-3.0-or-later
