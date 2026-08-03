# FARE — Product Integration & Process-Flow Plan

Living planning + tracking doc. Two questions it answers:

1. **Which on-chain entry points does the PWA already expose, and which are
   built on-chain but not yet tied into the app?** (Part 1)
2. **What does a complete, DoorDash-shaped product need, where does each piece
   logically live, and what's the build order?** (Parts 2–3)

Keep the checkboxes current as work lands. Source of truth for the contract
surface is `contracts/`; for the app surface, `web/src/{abi,chain,App}.tsx`.

> **Re-verified against the code on 2026-08-03** (commit `99b62d6`). Parts 1–3
> had drifted badly: they still described open bids that had been deleted from
> the contract, a menu/tracking/messaging/photo layer that had since shipped, a
> `MockUSDC` that had been replaced by real Asset Hub USDC, and a shielded
> funding path called "blocked on external infra" that had been proven on-chain.
> The drift ran **in both directions** — understating what was built and
> overstating what still worked — which is why a checkbox board needs reading
> against the code, not trusted. One ticked item turned out to be genuinely
> **undone** (A6r, since fixed); see the Part 1 audit summary, which also records
> a *false* regression this audit reported and had to withdraw.

**Legend**
| Mark | Meaning |
|---|---|
| ✅ | Wired to the PWA (UI + call site) |
| 🟡 | Partially wired (callable, but incomplete UX) |
| ⛔ | Exists on-chain, **no PWA UI** — a tie-in gap |
| ⚠️ | Was ticked, has since come **undone** (usually because a contract path was removed under it) |
| ⚙️ | Admin / infra — belongs in an ops console or scripts, not the consumer app |
| 🆕 | Net-new, mostly **off-chain** — no contract primitive yet |

---

## Part 1 — Contract entry-point audit

### FareOrders (order book + auction + escrow)
| Entry point | In PWA? | Notes |
|---|---|---|
| `createOrder` | ✅ | Per-order burner wallet; the cart is not a contract param — line items reach the venue off-chain via `ticket.ts` (B1), bound to `orderValue` by arithmetic |
| `createOrderERC20` | ✅ | Token escrow path (`token.ts`); approve + direct |
| `createOrderERC20WithPermit` | 🟡 | Wired (`token.ts:139`) but **unusable on Asset Hub USDC** — the ERC-20 precompile is bare IERC20 with no `permit()`. Kept for a token that has one |
| `commitBid` | ✅ | Sealed bid — the only bid path. Terms are sealed to the customer and relayed; the chain sees a hash |
| `revokeBid` | ✅ | "Withdraw sealed" per outstanding bid (`DriverBid`) → `revokeSealedBid` → relay `/revoke-bid` → `ordersW.revokeBid`. **Called through the relay on purpose**, and therefore deliberately absent from `ORDERS_ABI`: a driver-signed retraction would put their address on-chain and undo the point of sealing the bid. Authorized by the `revokeSecret`, not a signature |
| `acceptSealedBid` / `acceptSealedBidERC20` | ✅ | Customer opens the sealed terms and accepts; the ERC-20 variant reads `_msgSender()` so it can be relayed |
| `bidHashOf` / `sealedBid` / `sealedBidCount` | ✅ | Read by `sealedbid.ts` to build and verify bid cards |
| `increaseTip` / `increaseTipERC20` | ✅ | Customer top-up, both assets |
| `cancelOpen` / `cancelAssigned` / `abandonOrder` | ✅ | Cancel paths wired |
| `statusOf` / `partiesOf` / `dropCommitOf` / `deadlinesOf` / `orders(struct)` | ✅ | Read in discovery/order cards |
| `onPickupConfirmed` / `onDropoffConfirmed` / `markDisputed` / `resolveDisputed` | ⚙️ | Internal callbacks (settlement/disputes only) |
| `setParams` / `setRelayServiceFee` / `setRelayRebateBps` / `setAcceptedToken` / `configure` / `setRouter` | ⚙️ | Governance (D2) / deploy wiring |

> **`placeBid` / `withdrawBid` / `acceptBid` / `bidOf` / `biddersOf` no longer
> exist.** Open bids were removed from the contract in PR #15, not merely
> un-offered by the UI, so sealed bids cannot be opted out of. Rows for them used
> to sit in this table marked ✅; they were describing a surface that had been
> deleted.

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
| `resolve` (arbiter ruling) | ⚙️ | **Arbiter console** (D1) — ops app at `/ops`, not the consumer PWA |
| (dispute list / detail / status view) | ⚙️ | Dispute queue + order/driver context in the ops console (D1) |
| `setArbiter` / `setDisputeBond` / `configure` / `setRouter` | ⚙️ | Admin |

### FareDrivers (registry, stake, reputation)
| Entry point | In PWA? | Notes |
|---|---|---|
| `register` | ✅ | Optional stake at signup (`minStake` is currently 0) |
| `isEligible` / `drivers(struct)` | ✅ | Read for eligibility + own stats |
| `addStake` / `requestUnstake` / `withdrawStake` | ✅ | Stake lifecycle + unbonding countdown (`DriverAccount`) |
| `setMetadata` | ✅ | Driver profile edit (`DriverAccount`); commitment-backed via `regmeta.ts` |
| `reputationOf` (delivered/failed) | ✅ | The client reads the `drivers(address)` struct rather than `reputationOf` — one call gets the counts and the ban flag. Rendered in the driver's own view and, since A6r, on the customer's sealed bid cards (`reputation.ts`) |
| `slash` / `recordDelivered` / `recordFailed` / `importRecords` | ⚙️ | Internal / admin |
| `setBanned` / `setMinStake` / `setUnbondingSeconds` / `setAuthorized` / `setRouter` | ⚙️ | Governance |

### FareVenues (venue registry)
| Entry point | In PWA? | Notes |
|---|---|---|
| `registerVenue` | ✅ | Operator onboarding |
| `isActive` / `locationOf` / `signerOf` / `payoutOf` / `operatorOf` / `venues(struct)` | ✅ | Read for discovery/order cards |
| `setActive` | ✅ | Pause/resume (`VenueManage`) |
| `setLocation` / `setPayout` / `setSigner` / `setMetadata` | ✅ | Venue editing — pin, payout addr, hot signer, menu (`VenueManage` / `MenuEditor`). The hot signer is what order tickets are sealed to (`ticket.ts`) |
| `recordPickup` / `importVenues` / `setAuthorized` / `setRouter` | ⚙️ | Internal / infra |

### FareVault (pull-payment vault)
| Entry point | In PWA? | Notes |
|---|---|---|
| `withdraw` | ✅ | Wallet-chip withdraw (gasless via `withdrawFor` + the relay) |
| `balanceOf` / `tokenBalanceOf` (views) | ✅ | Shown per asset |
| `withdrawTo` / `withdrawTokenTo` | ✅ | Withdraw to a cold wallet (`VaultStrip`) |
| `withdrawToken` | ✅ | ERC-20 earnings path (C3) |
| `claimPaseoDust` / `pendingPaseoDust` | ✅ | Surfaced + claimable (`VaultStrip`) |
| `insertShieldNote` | ✅ | ZK shielded payout (`shieldnote.ts`); the keeper/ticket path was removed from the contract |
| `credit` / `creditToken` | ⚙️ | Authorized protocol contracts only |
| `setShieldPool` / `setShieldVerifier` / `setShieldPoseidon` / `setShieldBuckets` | ⚙️ | Shield wiring. `setShieldPoseidon` is deliberately **one-shot** — a tree initialised against one hasher and read with another yields unverifiable roots |

### FarePauseRegistry / FareGovernanceRouter / FareLocationVerifier
| Entry point | In PWA? | Notes |
|---|---|---|
| `isPaused` | ✅ | Read (gates actions) |
| Router `currentAddrOf` / `versionOf` / `historyOf` | ✅ | Router-following client |
| `pause` / `unpause` / `setGuardian` | ⚙️ | Guardian/owner — ops console |
| Router `register` / `upgradeContract` / `setContractFrozen` | ⚙️ | Upgrade admin |
| Verifier `setVerifyingKey` / `getVK` | ⚙️ | Trusted-setup / deploy |

**Audit summary.** The six tie-in gaps this section originally listed (retract
bid, stake lifecycle, dispute evidence + arbiter console, venue management,
vault `withdrawTo`/dust, reputation in bid cards) were wired as Group A and
Group D. All six still hold — but one of them survived the sealed-bid migration
only by being **rebuilt somewhere else**, and one did not survive at all:

1. ✅ **Retract a bid — intact, via a different route.** `withdrawBid` was wired
   (A1) and then deleted from the contract with the rest of the open-bid path.
   The replacement is whole: "Withdraw sealed" in `DriverBid` →
   `revokeSealedBid` (`sealedbid.ts`) → relay `/revoke-bid` →
   `ordersW.revokeBid`. Searching `web/src` for `revokeBid` finds nothing and
   that is **correct, not a gap** — the call is made by the relay, because a
   driver-signed retraction would name them on-chain and undo the sealing. The
   secret authorizes it instead of a signature.
2. ⛔ **Reputation in the bid cards — genuinely lost.** A6 rendered
   delivered/failed per bidder when bid cards were built from the on-chain
   `biddersOf`/`bidOf`. Sealed bids now arrive off-chain from the relay's
   `/bidbox` (`fetchSealedBids`) and the reputation lookup did not come with
   them. `CustomerOrder` does read `drivers.drivers(o.driver)` — but only for
   `metadataURI`, and only once a driver is already **assigned**, which is after
   the choice has been made. So the customer picked among bids blind. Wired back
   in A6r via `reputation.ts`.

Two lessons, and the second one cost more than the first. *Removing* a contract
path can silently un-wire a feature ticked off months earlier, and a board of
checkboxes has no way to notice — that is real, and A6 is the example. But the
first audit of this also reported A1 as broken, on the evidence that `web/src`
contains no `revokeBid` call. It contains no such call **by design**. Grepping
for a contract method name is a test for one implementation, not for the
capability; the capability was there the whole time, one indirection away.

Everything ⚙️ is deliberately out of the consumer PWA — it belongs in an **ops/governance console** (Part 3, group D).

---

## Part 2 — Journeys, mirrored on DoorDash

Each stage: what DoorDash does → the FARE primitive → status → what's missing.
DoorDash has three apps (Consumer, Dasher, Merchant); FARE's PWA has the three
role views. The mapping below is the target shape.

### 2.1 Customer (Consumer app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Browse restaurants (list, map, cuisine, search) | `FareVenues` discovery + region index | ✅ | `VenuePicker` — list + proximity sort, name search, cuisine filter; `VenueHeader` is the rich venue page (logo/banner, hours, cuisine) |
| Restaurant page + **menu**, add to **cart** | venue `metadataURI` (IPFS) | ✅ | Menu v2: item images, categories, modifier groups, weekly hours (`menu.ts`, `MenuCart`, `MenuItemRow`). **Needs IPFS configured** — without it menus are device-local and artwork can't publish at all |
| Checkout: address, tip, schedule | `createOrder(venueId, dropCommit, orderValue, tip, maxFare, windows)` | 🟡 | Address = ZK drop commit; tip + delivery windows supported. **No scheduled/future ordering** — the `schedule` in menu v2 is venue opening hours, not order scheduling |
| Pay | native PAS **or** Asset Hub USDC escrow | ✅ | Dual-asset selector at checkout; fiat display captured into the receipt at checkout (C2); gasless where the relay can carry it (C1) |
| Order confirmation | `OrderCreated` event | ✅ | — |
| **Live tracking** (status, driver on map, ETA) | order `status` + E2E channel (`kind:loc`) | ✅ | Driver opt-in shares live location; customer sees driver+trace+ETA on TrackMap (off-chain, E2E) |
| Pick a Dasher (FARE-specific: reverse auction) | `commitBid` → `fetchSealedBids` → `acceptSealedBid` | ✅ | Sealed bid cards, cheapest first, each showing the bidder's delivered/failed record and success rate (A6r) — a new driver reads as unknown rather than as perfect |
| Chat with Dasher / support | E2E crypto (`msg.ts`) + relay channel (`channel.ts`) | ✅ | ChatPanel in order cards; per-order topic, KV/venue-node relay (MESSAGING.md) |
| Handoff / proof of delivery | `confirmDropoffZK` (ZK) + E2E photo (`kind:photo`) | ✅ | ZK dropoff + optional E2E delivery photo (crypto-shred, expires) |
| Rate order + driver + restaurant | `FareRatings` (verified-delivery) | ✅ | On-chain stars, gated to a Delivered order's customer |
| Reorder, history, receipts | per-order wallet registry (local) | 🟡 | `OrderReceipt` + active/past split + one-tap reorder (B7). Still **device-local** — losing the device loses the history; needs a backup/export |
| Refunds / problems | `openDispute` | ✅ | Evidence input on open + a status/outcome view (A7); arbiter rules from the ops console (D1) |
| Tell the restaurant what to cook | `ticket.ts` over the order thread | ✅ | Line items sealed to the venue's hot signer, bound to `orderValue` by arithmetic — no on-chain commitment needed |

### 2.2 Driver (Dasher app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Sign up + (stake) | `register` | ✅ | Stake optional (`minStake` is 0 on Paseo today) |
| **Go online / availability + location** | region discovery + radius filter | 🟡 | Radius filter exists; still **no explicit online/offline toggle or presence** |
| Receive offers (pay, distance) | in-region open-order discovery | ✅ | Server-side region topic filter + distance sort |
| Bid / accept offer (reverse auction) | `commitBid` / `revokeBid` (sealed) | ✅ | Bidding is sealed — the chain never sees who bid or how much — and "Withdraw sealed" retracts it through the relay, authorized by the revoke secret rather than a signature |
| Navigate to restaurant | venue pin | 🟡 | Pin shown; **no in-app nav/route** — no maps hand-off anywhere in the app |
| Confirm pickup | `confirmPickup` | ✅ | Dual-sig + QR |
| Navigate to customer | ZK — driver gets coords at handoff | 🟡 | By design coords are late-bound; still needs a nav bridge at handoff |
| Confirm delivery | `confirmDropoffZK` (driver signs commitment) | ✅ | Gasless — the relay submits and earns the flat `relayServiceFee` |
| **Earnings dashboard + cash out** | `FareVault.withdraw` / `withdrawToken` | 🟡 | Withdraw, cold-wallet `withdrawTo`, dust claim and gasless `withdrawFor` all wired (A5). Still **no earnings history** view |
| Manage stake | `addStake`/`requestUnstake`/`withdrawStake` | ✅ | Full lifecycle + unbonding countdown (A2) |
| Ratings / acceptance rate | `drivers(struct)` delivered/failed | 🟡 | Own stats shown; **no acceptance-rate metric** |
| Edit profile | `setMetadata` | ✅ | Commitment-backed (`regmeta.ts`) — revealed only to the counterparty. The plaintext `demo://` "Save public" escape hatch was removed |

### 2.3 Merchant (Venue / Merchant app)
| DoorDash stage | FARE primitive | Status | Gap / needed |
|---|---|---|---|
| Onboard (location, hours, payout) | `registerVenue` | ✅ | Location + payout + hot signer set at register |
| Build **menu** | `metadataURI` | ✅ | `MenuEditor` + `OptionEditor` — items, images, categories, modifier groups, structured weekly hours, logo/banner, cuisine. **Needs IPFS** |
| Receive + accept orders | order discovery + `ticket.ts` | ✅ | The venue now learns **what to cook**: line items sealed to its hot signer, checked against the escrowed `orderValue` |
| **Kitchen board / prep status** | `kitchen.ts` + `KitchenCard` | ✅ | Everything not yet handed over, FIFO, overdue badge, chime. Prep state (new → cooking → ready) is device-local on purpose — it is the kitchen's workflow, not a protocol fact |
| Mark ready / hand off to Dasher | `confirmPickup` (venue cosign) | ✅ | Venue hot-signer cosigns pickup |
| **Manage venue** (pause, edit pin/payout/signer, hours) | `setActive`/`setLocation`/`setPayout`/`setSigner`/`setMetadata` | ✅ | `VenueManage` (A4); hours live in the menu (v2) |
| Payouts + analytics | vault credit + `pickups` count | 🟡 | Payout via vault (native + token); **no analytics dashboard** |

### 2.4 Cross-cutting
| Concern | FARE today | Status | Gap / needed |
|---|---|---|---|
| Identity / wallet | per-order burners (customer), device key (driver/venue) | ✅ | Burner gas comes from the region relay's `/fund`; escrow funding is **Kusama-Shield-only** and `fundBurner` throws rather than falling back, because a burner funded any other way carries an on-chain edge home |
| Gas | relay-sponsored (C1/F8) | ✅ | The central faucet (`/api/drip`, `DRIP_PRIVATE_KEY`) was **deleted** — nothing had called it since funding went KS-only. Non-value actions go through the EIP-2771 forwarder; value actions use a gas-sponsored burner |
| Notifications | local + region push | ✅ | B4 P1 (local, on-device) + P2 (Web Push by region, SW-filtered so the push service only ever sees "a device in region X"). **Needs a VAPID keypair** |
| Messaging | order-scoped E2E channel | ✅ | `msg.ts` crypto + `channel.ts` transport; chat, location and photo all ride it |
| Ratings/reputation | `FareRatings` stars + delivered/failed | 🟡 | Stars shipped (B5). Reputation is **not** on the bid cards (A6r) |
| Disputes / support | `openDispute` + evidence + arbiter | ✅ | A7 (evidence + status view) and D1 (arbiter console) |
| Admin / governance | ops app at `/ops` | ✅ | D1–D4 shipped; D5 (offline MPC ceremony) remains |

---

## Part 3 — Integration backlog (grouped by where it lives)

Ordered roughly by leverage. Check off as landed.

### Group A — On-chain tie-ins (fast wins: primitive already exists) 🟡 MOSTLY DONE
*Pure PWA wiring — no new contracts.*
- [x] Driver retract-bid button (`DriverBid`) — was `withdrawBid`, now
      "Withdraw sealed" → `revokeSealedBid` → relay → `revokeBid`. The entry
      point changed under it; the capability did not.
- [x] Driver stake lifecycle: `addStake` / `requestUnstake` / `withdrawStake` (+ unbonding countdown) (`DriverAccount`)
- [x] Driver + venue profile edit: `setMetadata` (`DriverAccount` / `VenueManage`)
- [x] Venue management: `setActive` (pause/resume), `setLocation`, `setPayout`, `setSigner` (`VenueManage`)
- [x] Vault: `withdrawTo` (cold wallet) + `claimPaseoDust` (+ show `pendingPaseoDust`) (`VaultStrip`)
- [x] Surface driver **reputation** (delivered/failed + success %) in bid cards
      (`CustomerOrder`). Broke when bid cards moved off `biddersOf`/`bidOf` to
      the relay's bid box; rebuilt as `reputation.ts` (A6r).
- [x] Dispute **evidence** input on `openDispute` + a dispute status/detail view (`DisputeControl`)

### Group B — Off-chain product services (net-new)
*Menu/cart, tracking, comms — the DoorDash "app" layer over the settlement rail.*
- [x] **Catalog / menu / cart** behind venue `metadataURI` (IPFS); `orderValue`
      from a real cart — `web/src/menu.ts` (v2 model: item images, modifier
      groups, categories, structured weekly hours, logo/banner, cuisine; v1 menus
      still read), `web/functions/api/menu.ts` + `api/asset.ts` (server-side IPFS
      proxy key; artwork is separate CIDs because the menu JSON is capped at
      64 KB), `MenuEditor` (venue publishes), `MenuCart`/`VenuePicker`/
      `VenueHeader` + cart-driven `CreateOrder` (customer, with search and
      cuisine filter). Needs `IPFS_ADD_URL`/`IPFS_API_KEY` set; untested
      in-browser.
- [x] **The order ticket** — `web/src/ticket.ts`. The cart used to be priced
      client-side and then thrown away into a device-local receipt, so the venue
      received a `venueId` and an escrowed amount and **had no way to know what to
      cook**. The line items are now sealed to the venue's hot signer with
      `sealAnon` (the relay learns nothing, the envelope names no sender) and
      bound to the escrow: the venue re-adds the lines and compares against
      `orders(id).orderValue`, so a forged ticket needs no on-chain commitment to
      reject. `orderValue = 0` reports `unpriced` rather than a false match,
      because a POS-keeping venue escrows only the fare.
- [x] **Venue tablet mode** — `web/src/kitchen.ts` + `KitchenCard`. The venue view
      only ever showed `status === 2` (a driver is here, sign the release); a
      kitchen needs the moment before that. The board covers everything not yet
      handed over, FIFO by creation, with a device-local prep state
      (new → cooking → ready), an overdue badge, and a synthesized chime for a
      tablet across the room. Prep state stays off-chain deliberately: it is the
      kitchen's workflow, not a protocol fact.
- [x] **Live order tracking**: status stepper + ETA countdown (`OrderTracker`,
      derived from on-chain status + deadlines) **plus** the driver-location relay
      and map trace that used to be listed as remaining — `TrackPublisher` seals
      `kind:"loc"` envelopes over the order channel and the customer's `TrackPanel`
      renders driver + venue + trace on a tile-less `TrackMap`. Location never
      goes on-chain and only the customer can decrypt it.
- [x] **Messaging**: E2E crypto (`web/src/msg.ts` — secp256k1 ECDH → AES-GCM,
      per-order scoped) **and** the transport that used to be deferred
      (`web/src/channel.ts`: per-order `topic = H(orderId)`, KV relay `/api/msg`
      P1 → venue-node `/msg` P2, authenticated hello handshake) + `ChatPanel`.
      See [MESSAGING.md](MESSAGING.md)
- [x] **Notifications**: local order notifications (B4 P1) + background region push
      via the venue-node push service (B4 P2) — status changes, new offers, new bids
- [x] **Ratings**: on-chain verified-delivery stars (`FareRatings`) — gated to the Delivered order's customer, one per order; rate widget in history + driver rating in bid cards
- [x] Proof-of-delivery photo — the sealing layer (`web/src/photo.ts`, crypto-shred:
      random-key AES-GCM, key wrapped over msg.ts) **and** the capture/storage/view
      path that used to be deferred: driver captures → `compressImage` (downscale +
      EXIF strip) → `storeSealed` (content-addressed `/api/photo` KV, venue `/photo`
      fallback) → the key travels E2E as `kind:"photo"` → the customer's `TrackPanel`
      fetches, decrypts and views. Expires by storage TTL ∧ crypto-shred. Remaining
      nicety: swap the demo store for Bulletin Chain. See [PHOTOS.md](PHOTOS.md)
- [x] Order history / receipts / reorder — `OrderReceipt` (local cart snapshot +
      on-chain amounts), active/past split with a collapsible history section,
      one-tap `HistoryCard` reorder (fresh wallet, same venue/cart/drop). Receipts
      are device-local (survive-device-loss needs a backup/export — see identity note).

### Group C — Payments & economics (mainnet blockers)
- [x] **Gasless** (C1) — complete. Non-value user actions (`commitBid` /
  `revokeBid` / cancels / rate) go gasless via the EIP-2771 `FareForwarder` +
  venue-node `/forward` relay (`relayForward` in `web/src/relay.ts`); value
  actions (`createOrder` / `acceptSealedBid`) use gas-sponsorship on the funded
  burner (`sponsorGas` / `ensureGas`); settlement via `relaySettle`, earnings via
  `relayWithdraw`. By design the relay never fronts escrow, so value actions
  can't be forwarded — which is also why the NATIVE accept still reads
  `msg.sender` while `acceptSealedBidERC20` reads `_msgSender()`.
  **The fee model is F6-flat**, not the bps rebate this doc once described:
  `relayServiceFee = 1.25 PAS` escrowed at creation and paid to the settling
  relay, `relayRebateBps = 0`. The rebate needed a ~183 PAS fare to clear the
  relay's cost, so the profit guard declined every realistic order.
- [x] **Fiat-denominated pricing** (C2) — off-chain display layer: `web/src/pricing.ts`
  (PAS/USD rate — live endpoint `VITE_PRICE_URL` → static `VITE_PAS_USD` → default;
  cached, `usePasUsd` hook). Fiat shown on menu items, cart total and receipts; the
  rate is **captured at checkout** into the local receipt so its fiat value is
  locked. On-chain oracle binding at bid acceptance is the mainnet successor.
- [x] **Stablecoin escrow** (C3) — dual-mode ERC-20 escrow rail. Order carries an
  escrow `token` (address(0) = native); `createOrderERC20` / `acceptBidERC20` /
  `increaseTipERC20` pull value via `transferFrom`; every release/refund/split
  goes through one asset-agnostic `_credit` (native value or ERC-20 approve+pull).
  `FareVault` gains a per-token pull-payment ledger (`creditToken` / `withdrawToken`
  / `tokenBalanceOf`); owner-gated accepted-token allowlist. 9 tests in
  `test/stablecoin-escrow.test.ts` (full USDC delivery, fare-only, cancels/split,
  mode guards, accepted-token gate).
  **The escrow token is REAL Asset Hub USDC**, not a mock: asset **1337** at the
  ERC-20 precompile `0x0000053900000000000000000000000001200000` (6dp), accepted
  live by `scripts/accept-real-usdc.ts`. `MockUSDC` survives **only** as a
  hardhat fixture — the tests need a local ERC-20 with `mint`, and `deploy.ts`
  deploys it on localhost/hardhat only.
  **PWA UI done** (`web/src/token.ts` + App): a PAS/USDC pay-with selector on
  checkout, token-decimal amounts everywhere (order/bid/fare/receipt), and a
  `withdrawToken` earnings path — all feature-gated on the address book's
  `stablecoin` entry. `mintStablecoin` is **gone** and the token path **fails
  closed** when the burner is short: real USDC cannot be printed. Two precompile
  traps worth knowing: `approve(MaxUint256)` reverts ("Balance conversion
  failed" — it narrows to pallet-assets' `u128`), so always approve a bounded
  amount; and it is a bare IERC20 with **no `permit()`**, so the token order path
  must use approve+direct rather than `createOrderERC20WithPermit`.
  Sourcing USDC without a faucet: `scripts/swap-local-dex.mjs` swaps PAS→USDC on
  Asset Hub's asset-conversion DEX via the **XCM precompile's `ExchangeAsset`**
  (there is no asset-conversion precompile).
- [~] Shielded **funding path** for per-order burner wallets (C4, privacy mainnet
  gate) — **BUILT AND PROVEN ON PASEO**, not blocked on infra. This entry used to
  say "no shielded pool on Paseo"; there is one. FARE integrates **Kusama Shield**
  (`web/src/shieldpool.ts` + `shield.ts`, relay `/shield-withdraw`), and a full
  deposit → ZK withdrawal → fresh unlinked recipient has run on-chain for **both**
  native PAS and **shielded USDC** (asset 1337). See
  [SHIELDED-POOL-INTEGRATION.md](SHIELDED-POOL-INTEGRATION.md) and
  [E2E-SHIELDED-DELIVERY-REPORT.md](E2E-SHIELDED-DELIVERY-REPORT.md).
  `relay.ts fundBurner` no longer "falls back to the sponsored drip" — that drip
  was deleted, and it now **throws**, because a fallback would quietly reintroduce
  the funder→burner edge the whole mechanism exists to remove.
  What remains is **not code**: real unlinkability needs an anonymity set and time
  decorrelation, and the canonical v7 pool holds ~94 leaves on a testnet. That is
  why C4 stays a mainnet-*privacy* gate with the integration finished.

### Group D — Ops / governance / trust (⚙️ console, not consumer app)
*A separate app (`web/ops.html` → `/ops`, `web/src/ops/`) — shares the chain glue
with the PWA, no shared nav, no service worker. Four sibling tabs (D1–D4) share
one wallet session + toast in `OpsApp.tsx`; only D5 (offline ceremony) remains.*
- [x] **Arbiter console** (D1): dispute queue + `resolve` (customerShareBps, openerWins,
  driverAtFault, slash) — `web/src/ops/DisputesConsole.tsx`. Connect the arbiter wallet
  (badges whether it matches the on-chain `arbiter`), see each open dispute with
  its order + driver context (frozen escrow, reputation, stake), issue a ruling
  with a live escrow-split preview. Reuses `connect`/`contracts` from `chain.ts`.
- [x] **Governance console** (D2): `setParams`, `setRelayRebateBps`, `setGeoParams`,
  `setMinStake`, `setUnbondingSeconds`, `setDisputeBond`, `setWithdrawFeeBps` —
  `web/src/ops/GovernanceConsole.tsx`. Reads every knob live; bound checks mirror
  each contract's `require()`; authority gated per-contract `owner()`.
- [x] **Guardian pause console** (D3): `pause` / `unpause` / `setGuardian` across the
  four categories — `web/src/ops/PauseConsole.tsx`. Guardian-or-owner pause, owner-only
  unpause + guardian management.
- [x] **Upgrade console** (D4): router `register` / `upgradeContract` / `setContractFrozen`
  — `web/src/ops/UpgradeConsole.tsx`. Live address/version/frozen/history per registered
  contract; freeze-and-drain promotion with `freezeOld` default on.
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
| A1 | Retract bid | A | Driver view | ✅ done — rebuilt as the sealed path when `withdrawBid` was deleted (PR #15): "Withdraw sealed" → `revokeSealedBid` → relay `/revoke-bid` → `revokeBid`. Absent from `ORDERS_ABI` **by design** — the relay makes the call so the driver is never named on-chain |
| A2 | Driver stake lifecycle | A | Driver view | ✅ done |
| A3 | Profile edit (`setMetadata`) | A | Driver/Venue | ✅ done |
| A4 | Venue management (active/pin/payout/signer) | A | Venue view | ✅ done |
| A5 | Vault: withdrawTo + dust claim | A | Wallet chip | ✅ done |
| A6 | Reputation in bid cards | A | Customer view | ⚠️ was **undone** by the sealed-bid migration — rebuilt as A6r |
| A6r | Reputation on **sealed** bid cards | A | Customer view | ✅ done — `web/src/reputation.ts` (+13 tests) reads the `drivers(address)` struct per bidder, deduped and keyed on the bidder *set* so the 8 s poll doesn't re-read it. Shows `✓N · ✗M · P%`, distinguishes a **new driver** from a perfect one, never rounds up to 100 with a failure on record, and disables Accept for a banned driver (the contract's `isEligible` would revert anyway) |
| A7 | Dispute evidence + status view | A | Customer/Driver | ✅ done |
| B1 | Catalog / menu / cart | B | New service + all views | ✅ done — full catalog (images, categories, modifiers, hours, search) **+ the order ticket that actually reaches the venue** (`web/src/ticket.ts`); needs IPFS configured |
| B2 | Live tracking + ETA | B | Customer/Driver | ✅ done (E2E driver location + TrackMap) |
| B3 | Order-scoped messaging | B | Customer/Driver | ✅ done (channel + chat) |
| B4 | Notifications | B | Cross-cutting + venue-node | ✅ done (P1 local + P2 region push) |
| B5 | Ratings (stars) | B | Post-delivery | ✅ done |
| B6 | Proof-of-delivery photo | B | Driver/Customer | ✅ done (capture→seal→store→E2E view) |
| B7 | History / receipts / reorder | B | Customer view | ✅ done |
| C1 | Gasless meta-tx relay | C | Infra + all views | ✅ done |
| C2 | Fiat pricing (oracle) | C | Checkout | ✅ done (off-chain layer) |
| C3 | Stablecoin escrow | C | Vault + checkout | ✅ done (rail + tests + PWA UI) |
| C4 | Shielded burner funding | C | Infra | 🟡 **built + proven on Paseo** (Kusama Shield v7, native **and** USDC); remaining gate is the anonymity set, not code — see SHIELDED-POOL-INTEGRATION.md |
| D1 | Arbiter console (`resolve`) | D | Ops app (`/ops`) | ✅ done |
| D2 | Governance console | D | Ops app | ✅ done |
| D3 | Guardian pause console | D | Ops app | ✅ done |
| D4 | Upgrade console | D | Ops app | ✅ done |
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
- [~] F6 On-chain rewards — Tier 1 shipped and **since replaced in kind**: the trustless relay reward is now the **flat `relayServiceFee`** (escrowed at creation, paid in full to the account that submits the dropoff, self-identified via `msg.sender` — no oracle), not the original `relayRebateBps` carve-out, which is set to 0. Proven end-to-end on Paseo: the relay spent ~0.02 PAS of gas and earned 1.25 PAS. Both branches are verified — when no relay settles (`relayer == 0` or `== treasury`) the fee is **refunded to the customer** rather than paid out, so don't mistake that refund for a misdirected fee. Tier 2 (DA-score reward via `FareDataAvailability` + attester) deferred — no oracles for now
- [x] F7 Hosted super-node mode (for non-technical venues) — one appliance serves many venues via `HOME_COORDS` (union of regions)
- [x] F8 Venue-operated gasless relay (region meta-tx) — relay + EIP-2771 `FareForwarder`; non-value user actions gasless via `_msgSender()`

## See also
- [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) — consolidated what's-left list (ops · follow-ons · not-started · mainnet gates)
- [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) — venues-as-infrastructure design
- [ROADMAP.md](ROADMAP.md) — R1/R2/R3 release framing (this doc is the app-integration cut of it)
- [ARCHITECTURE.md](ARCHITECTURE.md) — contract topology + EIP-712 surface
- [PRIVACY.md](PRIVACY.md) / [GPS.md](GPS.md) — the privacy + settlement trust model
