# FARE — Product Integration & Process-Flow Plan

Living planning + tracking doc. Two questions it answers:

1. **Which on-chain entry points does the PWA already expose, and which are
   built on-chain but not yet tied into the app?** (Part 1)
2. **What does a complete, DoorDash-shaped product need, where does each piece
   logically live, and what's the build order?** (Parts 2–3)

Keep the checkboxes current as work lands. Source of truth for the contract
surface is `contracts/`; for the app surface, `web/src/{abi,chain,App}.tsx`.

**Legend**
| Mark | Meaning |
|---|---|
| ✅ | Wired to the PWA (UI + call site) |
| 🟡 | Partially wired (callable, but incomplete UX) |
| ⛔ | Exists on-chain, **no PWA UI** — a tie-in gap |
| ⚙️ | Admin / infra — belongs in an ops console or scripts, not the consumer app |
| 🆕 | Net-new, mostly **off-chain** — no contract primitive yet |

---

## Part 1 — Contract entry-point audit

### FareOrders (order book + auction + escrow)
| Entry point | In PWA? | Notes |
|---|---|---|
| `createOrder` | ✅ | Per-order burner wallet; no cart/items param (see 🆕 catalog) |
| `placeBid` | ✅ | Driver bids in the job card |
| `acceptBid` | ✅ | Customer picks a bid |
| `increaseTip` | ✅ | Customer top-up |
| `cancelOpen` / `cancelAssigned` / `abandonOrder` | ✅ | Cancel paths wired |
| `withdrawBid` | ⛔ | Driver can't **retract** a bid in-app |
| `statusOf` / `partiesOf` / `biddersOf` / `bidOf` / `dropCommitOf` / `deadlinesOf` / `orders(struct)` | ✅ | Read in discovery/order cards |
| `onPickupConfirmed` / `onDropoffConfirmed` / `markDisputed` / `resolveDisputed` | ⚙️ | Internal callbacks (settlement/disputes only) |
| `setParams` / `configure` / `setRouter` | ⚙️ | Governance / deploy wiring |

### FareSettlement (attestation + ZK dropoff)
| Entry point | In PWA? | Notes |
|---|---|---|
| `confirmPickup` | ✅ | Driver+venue dual-sig, QR handoff |
| `confirmDropoffZK` | ✅ | ZK proof, customer submits |
| `dropoffRadiusMeters` / `pickupRadiusMeters` (views) | 🟡 | dropoff read; pickup radius not surfaced |
| `setGeoParams` | ⚙️ | Radii/freshness tuning — ops console |
| `setLocationVerifier` / `configure` / `setRouter` / `domainSeparator` | ⚙️ | Infra |

### FareDisputes (arbitrated escape hatch)
| Entry point | In PWA? | Notes |
|---|---|---|
| `openDispute` | 🟡 | Wired, but **evidence is always `""`** — no evidence flow |
| `resolve` (arbiter ruling) | ⛔ | **No arbiter UI at all** — needs an ops/arbiter console |
| (no dispute list / detail / status view) | ⛔ | Can't see open disputes, evidence, or outcome in-app |
| `setArbiter` / `setDisputeBond` / `configure` / `setRouter` | ⚙️ | Admin |

### FareDrivers (registry, stake, reputation)
| Entry point | In PWA? | Notes |
|---|---|---|
| `register` | ✅ | Optional stake at signup |
| `isEligible` / `drivers(struct)` | ✅ | Read for eligibility + own stats |
| `addStake` / `requestUnstake` / `withdrawStake` | ⛔ | **No stake-lifecycle UI** after signup |
| `setMetadata` | ⛔ | Can't edit driver profile |
| `reputationOf` (delivered/failed) | 🟡 | Shown in the driver's own view; **not in bid cards** for customers |
| `slash` / `recordDelivered` / `recordFailed` / `importRecords` | ⚙️ | Internal / admin |
| `setBanned` / `setMinStake` / `setUnbondingSeconds` / `setAuthorized` / `setRouter` | ⚙️ | Governance |

### FareVenues (venue registry)
| Entry point | In PWA? | Notes |
|---|---|---|
| `registerVenue` | ✅ | Operator onboarding |
| `isActive` / `locationOf` / `signerOf` / `payoutOf` / `operatorOf` / `venues(struct)` | ✅ | Read for discovery/order cards |
| `setActive` | ⛔ | Can't pause/resume a venue in-app |
| `setLocation` / `setPayout` / `setSigner` / `setMetadata` | ⛔ | **No venue editing** (pin, payout addr, hot signer, profile) |
| `recordPickup` / `importVenues` / `setAuthorized` / `setRouter` | ⚙️ | Internal / infra |

### FareVault (pull-payment vault)
| Entry point | In PWA? | Notes |
|---|---|---|
| `withdraw` | ✅ | Wallet-chip withdraw |
| `balanceOf` (view) | ✅ | Shown |
| `withdrawTo` | ⛔ | Withdraw to a **cold wallet** not exposed |
| `claimPaseoDust` / `pendingPaseoDust` | ⛔ | Queued dust never surfaced or claimable in-app |
| `credit` | ⚙️ | Authorized protocol contracts only |

### FarePauseRegistry / FareGovernanceRouter / FareLocationVerifier
| Entry point | In PWA? | Notes |
|---|---|---|
| `isPaused` | ✅ | Read (gates actions) |
| Router `currentAddrOf` / `versionOf` / `historyOf` | ✅ | Router-following client |
| `pause` / `unpause` / `setGuardian` | ⚙️ | Guardian/owner — ops console |
| Router `register` / `upgradeContract` / `setContractFrozen` | ⚙️ | Upgrade admin |
| Verifier `setVerifyingKey` / `getVK` | ⚙️ | Trusted-setup / deploy |

**Audit summary — the tie-in gaps (⛔) worth wiring:**
1. Bids: `withdrawBid`
2. Driver stake lifecycle: `addStake`, `requestUnstake`, `withdrawStake`, `setMetadata`
3. Disputes: evidence flow on `openDispute`, an **arbiter console** for `resolve`, and a dispute detail/list view
4. Venue management: `setActive`, `setLocation`, `setPayout`, `setSigner`, `setMetadata`
5. Vault: `withdrawTo`, `claimPaseoDust` (+ show `pendingPaseoDust`)
6. Reputation surfaced in **bid cards** (`reputationOf`)

Everything ⚙️ is deliberately out of the consumer PWA — it belongs in an **ops/governance console** (Part 3, group D).

---

## Part 2 — Journeys, mirrored on DoorDash

Each stage: what DoorDash does → the FARE primitive → status → what's missing.
DoorDash has three apps (Consumer, Dasher, Merchant); FARE's PWA has the three
role views. The mapping below is the target shape.

### 2.1 Customer (Consumer app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Browse restaurants (list, map, cuisine, search) | `FareVenues` discovery + region index | 🟡 | Venue list/map exists; no search/cuisine/filter, no rich venue page |
| Restaurant page + **menu**, add to **cart** | venue `metadataURI` (IPFS) | 🆕 | No catalog/menu/cart — `orderValue` is an opaque number today |
| Checkout: address, tip, schedule | `createOrder(venueId, dropCommit, orderValue, tip, maxFare, windows)` | ✅ | Address = ZK drop commit; tip + windows supported |
| Pay | native PAS escrow | 🟡 | Works on testnet; needs fiat pricing + gasless + stablecoin (group C) |
| Order confirmation | `OrderCreated` event | ✅ | — |
| **Live tracking** (status, driver on map, ETA) | order `status` + E2E channel (`kind:loc`) | ✅ | Driver opt-in shares live location; customer sees driver+trace+ETA on TrackMap (off-chain, E2E) |
| Pick a Dasher (FARE-specific: reverse auction) | `biddersOf` / `acceptBid` | ✅ | Bid cards — but **no driver rating shown** (⛔ `reputationOf`) |
| Chat with Dasher / support | E2E crypto (`msg.ts`) + relay channel (`channel.ts`) | ✅ | ChatPanel in order cards; per-order topic, KV/venue-node relay (MESSAGING.md) |
| Handoff / proof of delivery | `confirmDropoffZK` (ZK) | ✅ | No delivery photo / "leave at door" option |
| Rate order + driver + restaurant | `FareRatings` (verified-delivery) | ✅ | On-chain stars, gated to a Delivered order's customer; shown in bid cards |
| Reorder, history, receipts | per-order wallet registry (local) | 🟡 | History is device-local; no receipts/reorder |
| Refunds / problems | `openDispute` | 🟡 | Opens with empty evidence; no status/outcome view |

### 2.2 Driver (Dasher app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Sign up + (stake) | `register` | ✅ | Stake optional |
| **Go online / availability + location** | region discovery + radius filter | 🟡 | Radius filter exists; no explicit online/offline toggle or presence |
| Receive offers (pay, distance) | open-order discovery | ✅ | Sorted by distance |
| Bid / accept offer (reverse auction) | `placeBid` / `withdrawBid` | 🟡 | Bid ✅; **can't retract** (⛔ `withdrawBid`) |
| Navigate to restaurant | venue pin | 🟡 | Pin shown; no in-app nav/route |
| Confirm pickup | `confirmPickup` | ✅ | Dual-sig + QR |
| Navigate to customer | ZK — driver gets coords at handoff | 🟡 | By design coords are late-bound; needs a nav bridge at handoff |
| Confirm delivery | `confirmDropoffZK` (driver signs commitment) | ✅ | — |
| **Earnings dashboard + cash out** | `FareVault.withdraw` | 🟡 | Withdraw exists; no earnings history, no `withdrawTo` cold wallet, no dust claim |
| Manage stake | `addStake`/`requestUnstake`/`withdrawStake` | ⛔ | Not wired |
| Ratings / acceptance rate | `reputationOf` | 🟡 | Own stats shown; no acceptance metrics |
| Edit profile | `setMetadata` | ⛔ | Not wired |

### 2.3 Merchant (Venue / Merchant app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Onboard (location, hours, payout) | `registerVenue` | ✅ | Location + payout + hot signer set at register |
| Build **menu** | `metadataURI` | 🆕 | No menu editor / catalog |
| Receive + accept orders | order discovery for the venue | 🟡 | Venue sees its orders; no accept/prep-status step (pickup cosign is the "accept") |
| Mark ready / hand off to Dasher | `confirmPickup` (venue cosign) | ✅ | Venue hot-signer cosigns pickup |
| **Manage venue** (pause, edit pin/payout/signer, hours) | `setActive`/`setLocation`/`setPayout`/`setSigner`/`setMetadata` | ⛔ | None wired |
| Payouts + analytics | vault credit + `pickups` count | 🟡 | Payout via vault; no analytics dashboard |

### 2.4 Cross-cutting
| Concern | FARE today | Status | Gap / needed |
|---|---|---|---|
| Identity / wallet | per-order burners (customer), device key (driver/venue) | ✅ | — (mainnet: shielded funding) |
| Gas | faucet drip | 🟡 | Testnet only; needs gasless meta-tx (group C) |
| Notifications | none | 🆕 | Push/webPush for status, offers, bids |
| Messaging | none | 🆕 | Driver↔customer, order-scoped |
| Ratings/reputation | delivered/failed counts | 🟡 | Surface in bid cards; add star ratings |
| Disputes / support | `openDispute` only | 🟡 | Evidence flow + arbiter console + status view |
| Admin / governance | none in-app | ⚙️ | Ops console (group D) |

---

## Part 3 — Integration backlog (grouped by where it lives)

Ordered roughly by leverage. Check off as landed.

### Group A — On-chain tie-ins (fast wins: primitive already exists) ✅ DONE
*Pure PWA wiring — no new contracts.*
- [x] `withdrawBid` — driver retract-bid button (`DriverBid`)
- [x] Driver stake lifecycle: `addStake` / `requestUnstake` / `withdrawStake` (+ unbonding countdown) (`DriverAccount`)
- [x] Driver + venue profile edit: `setMetadata` (`DriverAccount` / `VenueManage`)
- [x] Venue management: `setActive` (pause/resume), `setLocation`, `setPayout`, `setSigner` (`VenueManage`)
- [x] Vault: `withdrawTo` (cold wallet) + `claimPaseoDust` (+ show `pendingPaseoDust`) (`VaultStrip`)
- [x] Surface driver **reputation** (delivered/failed + success %) in bid cards (`CustomerOrder`)
- [x] Dispute **evidence** input on `openDispute` + a dispute status/detail view (`DisputeControl`)

### Group B — Off-chain product services (net-new)
*Menu/cart, tracking, comms — the DoorDash "app" layer over the settlement rail.*
- [x] **Catalog / menu / cart** behind venue `metadataURI` (IPFS); `orderValue`
      from a real cart — `web/src/menu.ts` (model + publish/fetch, graceful local
      fallback), `web/functions/api/menu.ts` (server-side IPFS proxy key),
      `MenuEditor` (venue publishes), `MenuCart` + cart-driven `CreateOrder`
      (customer). Needs the DATUM IPFS node stood up + `IPFS_ADD_URL`/`IPFS_API_KEY`
      set; untested in-browser.
- 🟡 **Live order tracking**: status stepper + live ETA countdown done (`OrderTracker`,
      derived from on-chain status + deadlines). Remaining: driver-location relay +
      map trace (needs the off-chain location channel — see NETWORK-ARCHITECTURE.md)
- 🟡 **Messaging**: E2E crypto layer done (`web/src/msg.ts` — secp256k1 ECDH → AES-GCM,
      per-order scoped, 5 tests). Relay/transport deferred — see [MESSAGING.md](MESSAGING.md)
- [ ] **Notifications**: web-push for status changes, new offers, new bids
- [x] **Ratings**: on-chain verified-delivery stars (`FareRatings`) — gated to the Delivered order's customer, one per order; rate widget in history + driver rating in bid cards
- 🟡 Proof-of-delivery photo — ephemeral sealing layer done (`web/src/photo.ts` —
      crypto-shred: random-key AES-GCM, key wrapped over msg.ts; 4 tests). Storage
      (Bulletin Chain ~2wk TTL / IPFS) + capture UI + submitter deferred — see [PHOTOS.md](PHOTOS.md)
- [x] Order history / receipts / reorder — `OrderReceipt` (local cart snapshot +
      on-chain amounts), active/past split with a collapsible history section,
      one-tap `HistoryCard` reorder (fresh wallet, same venue/cart/drop). Receipts
      are device-local (survive-device-loss needs a backup/export — see identity note).

### Group C — Payments & economics (mainnet blockers)
- 🟡 **Gasless** relay — venue-node relay shipped (`venue-node/`): gas sponsorship +
  settlement relay (confirmPickup/confirmDropoffZK), no contract change. EIP-2771
  forwarder for full meta-tx (createOrder/placeBid/…) is the next step.
- [ ] **Fiat-denominated pricing** via oracle rate captured at acceptance
- [ ] **Stablecoin escrow** (Asset Hub USDC/USDT via ERC-20 precompile; vault ERC-20 variant)
- [ ] Shielded **funding path** for per-order burner wallets (privacy mainnet gate)

### Group D — Ops / governance / trust (⚙️ console, not consumer app)
- [ ] **Arbiter console**: dispute queue + `resolve` (customerShareBps, openerWins, slash)
- [ ] Governance console: `setParams`, `setGeoParams`, `setMinStake`, `setDisputeBond`, `setArbiter`
- [ ] Guardian pause console: `pause` / `unpause` / `setGuardian`
- [ ] Upgrade console: router `register` / `upgradeContract` / `setContractFrozen`
- [ ] MPC trusted-setup ceremony before mainnet `setVerifyingKey` (lock-once)

### Group E — Trust & release (from ROADMAP R1/R2)
- [ ] Filmed end-to-end field test (two phones, one real handoff)
- [~] Slither static-analysis pass + CI gate (docs/SECURITY-REVIEW.md); Mythril on-demand
- [ ] External audit before mainnet value
- [ ] Device-attestation assurance tier (Play Integrity / App Attest)

---

## Part 4 — Tracking board

| # | Item | Group | Home | Status |
|---|---|---|---|---|
| A1 | Retract bid (`withdrawBid`) | A | Driver view | ✅ done |
| A2 | Driver stake lifecycle | A | Driver view | ✅ done |
| A3 | Profile edit (`setMetadata`) | A | Driver/Venue | ✅ done |
| A4 | Venue management (active/pin/payout/signer) | A | Venue view | ✅ done |
| A5 | Vault: withdrawTo + dust claim | A | Wallet chip | ✅ done |
| A6 | Reputation in bid cards | A | Customer view | ✅ done |
| A7 | Dispute evidence + status view | A | Customer/Driver | ✅ done |
| B1 | Catalog / menu / cart | B | New service + all views | ✅ done |
| B2 | Live tracking + ETA | B | Customer/Driver | ✅ done (E2E driver location + TrackMap) |
| B3 | Order-scoped messaging | B | Customer/Driver | ✅ done (channel + chat) |
| B4 | Push notifications | B | Cross-cutting | ☐ todo |
| B5 | Ratings (stars) | B | Post-delivery | ✅ done |
| B6 | Proof-of-delivery photo | B | Driver view | 🟡 partial |
| B7 | History / receipts / reorder | B | Customer view | ✅ done |
| C1 | Gasless meta-tx relay | C | Infra + all views | 🟡 partial |
| C2 | Fiat pricing (oracle) | C | Checkout | ☐ todo |
| C3 | Stablecoin escrow | C | Vault + checkout | ☐ todo |
| C4 | Shielded burner funding | C | Infra | ☐ todo |
| D1 | Arbiter console (`resolve`) | D | Ops app | ☐ todo |
| D2 | Governance console | D | Ops app | ☐ todo |
| D3 | Guardian pause console | D | Ops app | ☐ todo |
| D4 | Upgrade console | D | Ops app | ☐ todo |
| D5 | MPC ceremony | D | Ops / offline | ☐ todo |
| E1 | Filmed field test | E | — | ☐ todo |
| E2 | Slither/Mythril | E | CI | 🟡 Slither+CI done; Mythril on-demand |
| E3 | External audit | E | — | ☐ todo |
| E4 | Device attestation | E | Driver view | ☐ todo |
| F1 | VenueMetadataUpdated event | F | Contracts | ✅ done |
| F2 | Venue appliance (Kubo+RPC+agent) | F | venue-node/ | ✅ done |
| F3 | Replication agent (region pinning + manifest) | F | venue-node/ | ✅ done |
| F4 | Client gateway/RPC fallback pool | F | web/src/pool.ts,rpcpool.ts | ✅ done |
| F5 | DA scoring (challenge-response) | F | venue-node/scorer.mjs | ✅ done |
| F6 | On-chain rewards | F | FareOrders (rebate) | ✅ Tier 1 live; Tier 2 deferred |
| F7 | Hosted super-node mode | F | venue-node/agent.mjs | ✅ done |
| F8 | Venue-operated gasless relay | F | venue-node/ + FareForwarder | ✅ done + live on Paseo (+ profitability guard) |

### Group F — Network / infra (venues as infrastructure)
*Turn venues into network nodes — geo-replicated menus, chain access, gas relay.
Full design in [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md).*
- [x] F1 `VenueMetadataUpdated` event (event-driven menu-update replication)
- [x] F2 Venue appliance — Docker Compose (Kubo + agent + relay + Caddy; pine-rpc container deferred to F4)
- [x] F3 Replication agent — chain-indexed region pinning + manifest publish
- [x] F4 Client gateway/RPC fallback pool from venue manifests (light-client-first) — gateway pool (`web/src/pool.ts`) + RPC-provider pool (`web/src/rpcpool.ts`)
- [x] F5 Data-availability scoring (challenge-response + client reports) — `venue-node/scorer.mjs` + leaderboard
- [~] F6 On-chain rewards — Tier 1 shipped: trustless relay gas-rebate (`relayRebateBps` in FareOrders, carved from the fee → the settling relay). Tier 2 (DA-score reward via `FareDataAvailability` + attester) deferred
- [x] F7 Hosted super-node mode (for non-technical venues) — one appliance serves many venues via `HOME_COORDS` (union of regions)
- [x] F8 Venue-operated gasless relay (region meta-tx) — relay + EIP-2771 `FareForwarder`; non-value user actions gasless via `_msgSender()`

## See also
- [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) — consolidated what's-left list (ops · follow-ons · not-started · mainnet gates)
- [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) — venues-as-infrastructure design
- [ROADMAP.md](ROADMAP.md) — R1/R2/R3 release framing (this doc is the app-integration cut of it)
- [ARCHITECTURE.md](ARCHITECTURE.md) — contract topology + EIP-712 surface
- [PRIVACY.md](PRIVACY.md) / [GPS.md](GPS.md) — the privacy + settlement trust model
