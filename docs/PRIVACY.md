# On-Chain Location Privacy — Risk Analysis

Assessment date: 2026-07-20. Scope: the privacy risk of the position data
FARE writes to a public ledger. This is the *data-exposure* companion to
[GPS.md](GPS.md), which covers *integrity* (what a GPS attestation proves and
why the adverse-interest model is sound). Integrity and privacy are separate
axes — do not conflate them.

> **Update (ZK dropoff implemented).** The drop-reveal risk below (risk #1) is
> resolved: `confirmDropoffZK` puts a Groth16 proximity proof on-chain instead
> of coordinates, so the customer's drop location **never** enters calldata,
> storage, or events. This document's original analysis is retained for the
> record; risks #2 (driver coords at *pickup*), #3 (linkability) and #4–#5
> remain and still gate mainnet. See [GPS.md](GPS.md) for the design.

## TL;DR

- ~~The commitment scheme gives temporal, not permanent, privacy — at dropoff
  the coordinates enter public calldata forever.~~ **Fixed:** the drop location
  is now proven in zero knowledge; no coordinate is written at dropoff.
- **Driver coordinates at pickup — scrubbed.** `PickupConfirmed` no longer emits
  them (closing risk #2's bulk-indexable leak), and the client coarsens the
  driver's position to a ~33 m grid before signing, so the exact spot never
  enters calldata. The venue signer's coordinates stay in calldata — they are
  the venue's public location.
- On-chain identities are persistent, and the app reuses **one burner per
  device**, so the customer↔venue *relationship graph* is still derivable even
  though the drop coordinates are now hidden.
- For a **testnet demo/pilot** the posture is now solid on the home-address
  axis. Before **real-money mainnet**, close the remaining pickup-event leak and
  the linkability posture (per-order burners), and run a real trusted-setup
  ceremony (the current setup is single-party).

## What FARE writes on-chain

| Data | Where | Storage form | Exposure |
|---|---|---|---|
| Venue pin | `FareVenues.registerVenue` | plaintext storage | Public **by design** (business location) |
| Drop location — at order creation | `FareOrders.createOrder` | `Poseidon(latEnc, lonEnc, salt)` | **Private** — commitment reveals nothing |
| Drop location — at dropoff | `FareSettlement.confirmDropoffZK` | **nothing** — a Groth16 proof + hashed public signals `(orderId, dropCommit, driverCommit, radiusMeters, nullifier)` | **Private** — no coordinate on-chain |
| Driver GPS — pickup | `confirmPickup` | coarsened (~33 m) in calldata; **not emitted** (`PickupConfirmed` carries no coords) | Coarse; near a venue that is public anyway |
| Driver GPS — dropoff | `confirmDropoffZK` | **nothing** — private ZK witness | **Private** — no coordinate on-chain |
| Venue GPS at pickup | `confirmPickup` | calldata | Public (venue pin is public anyway) |
| Order metadata | `OrderCreated(orderId, customer, venueId — all indexed)` | event topics | Public relationship graph |
| Pickup region (Phase 2) | `OrderRegion(region, orderId)` | event; region = ~0.5° (~55 km) cell of the venue pin | Coarse; derived from the public venue pin |

Key distinction: **calldata is not storage, but it is still permanent and
publicly readable.** A value used only transiently inside a function (like the
drop reveal, consumed for the hash + proximity check and never written to
storage) is nonetheless preserved forever in the transaction the whole world
can fetch. "Not stored" ≠ "not on-chain."

## Risks

1. ~~**The drop reveal is a home address, made permanent.**~~ **RESOLVED by the
   ZK dropoff.** The drop location is now committed with Poseidon at creation and
   proven within-radius at dropoff via `confirmDropoffZK` — no coordinate ever
   enters calldata, storage, or events. What remains on-chain is a proof and
   hashed public signals from which the location is not recoverable. (Original
   risk retained below for context.) The customer's drop coordinates never leave
   their device in the clear; the driver shares their own position face-to-face
   only so the customer can build the proof locally.

2. ~~**Driver location is the most exposed — via events.**~~ **RESOLVED.**
   `PickupConfirmed` and `DropoffConfirmed` used to emit `driverAtt.lat/lon`,
   which event-log indexing turns into bulk driver-movement inference (routes,
   operating area, home from start/end clustering). Neither event emits
   coordinates now: dropoff is fully ZK (no coords anywhere), and pickup emits
   only `(orderId, driver, venueSigner)` with the driver's position coarsened to
   a ~33 m grid in calldata. The `FareDrivers` ABI privacy-invariant test
   already blocked a *stored* location field; the event scrub closes the
   aggregate-inference gap it couldn't. (A `withArgs` test now pins the
   `PickupConfirmed` arity so a regression re-adding coords fails CI.)

3. **Linkability defeats pseudonymity — and burner reuse makes it worse.**
   On-chain addresses are persistent. The web app keeps **one burner key per
   device** (`localStorage` `fare.burner.key`), so every order and drop reveal
   from a customer links to one identity; their home is derivable after a
   single delivery. Same failure mode for drivers.

4. **Metadata leaks even with the commitment intact.** `OrderCreated` indexes
   `customer` and `venueId`, so *before any reveal* the chain shows "person X
   ordered from venue Y at time T" — a behavioral/relationship graph.
   Phase 2's `OrderRegion` adds a coarse locality. Delivery **timing patterns**
   are their own hazard: they signal when a person is home (burglary / stalking
   relevance), independent of the coordinates.

5. **Immutability = legal exposure.** GDPR / CCPA "right to erasure" is
   structurally impossible on a public, globally-replicated ledger that holds
   what are effectively personal home addresses. For a production pilot this is
   a compliance problem, not merely a privacy nicety.

6. **Mempool & precision (minor).** The reveal is visible in the pending
   transaction before it is mined (it becomes public regardless, so this is
   incremental). Microdegree precision (~11 cm) reveals the exact spot — far
   more than a proximity check needs.

## What already protects you

- **128-bit random salt** (`randomSalt()` = 16 random bytes). The commitment
  can't be brute-forced pre-dropoff even though a city's coordinate space is
  small — this is load-bearing and must never be weakened.
- **Commitment scheme** — genuine temporal privacy; browsing the chain reveals
  nothing about a destination before delivery.
- **Adverse-interest signing** (see GPS.md) — an *integrity* protection, listed
  here only to keep it from being mistaken for a privacy one.

## Mitigations

### The real fix (mainnet-grade) — **IMPLEMENTED**
**ZK proximity proof** (Groth16), as laid out in GPS.md: prove
`dist(driver, customer) < R ∧ Poseidon(customer, salt) = dropCommit ∧
Poseidon(driver, drvSalt) = driverCommit` with only
`(orderId, dropCommit, driverCommit, radiusMeters, nullifier)` public.
**Neither party's coordinates ever hit calldata or an event.** Landed as
`circuits/proximity.circom`, `FareLocationVerifier.sol` (BN254 precompiles),
`FareSettlement.confirmDropoffZK`, the browser prover `web/src/zk.ts`, and
`scripts/setup-zk.mjs`. Remaining mainnet caveat: run a real multi-party
trusted-setup ceremony before `setVerifyingKey` (lock-once); the shipped setup
is single-party (fine for testnet).

### Near-term stopgaps (rough value/effort order)
1. **Per-order fresh burner wallets** (default) — breaks the linkability chain
   cheaply; cost is that each order-wallet needs a drip top-up. App-level.
2. **Coarsen the on-chain reveal** — geohash-truncate to ~±300–600 m and push
   exact-coordinate verification into the off-chain signature exchange.
   Weakens the on-chain distance check (a real tradeoff); a stopgap only.
3. ~~**Reduce driver-coordinate exposure**~~ **DONE** — `DropoffConfirmed` and
   `PickupConfirmed` no longer emit driver coordinates, and pickup coords are
   coarsened to a ~33 m grid in calldata. Closed risk #2.
4. **Blunt user warning** at dropoff — now moot: the ZK path means the location
   never becomes public, so there is nothing to warn about.

## The mainnet gate

Before any real-money launch:

- ✅ ZK proximity proofs are live for **dropoff** (coordinates never on-chain) —
  done (`confirmDropoffZK`). Remaining: run a real trusted-setup ceremony.
- ✅ Remove driver coordinates from the **pickup** path — done: not emitted, and
  coarsened to ~33 m in calldata.
- ☐ Address the linkability posture (per-order identities or equivalent) — the
  drop coordinates are hidden, but the customer↔venue relationship graph and
  timing patterns remain.

The single worst exposure — a public, permanent index of customers' **home
addresses** — is closed. The remaining items are real but lower-severity; do not
ship for real value until they're addressed too.

## See also

- [GPS.md](GPS.md) — attestation integrity, the adverse-interest model, radii,
  and the ZK circuit design.
- [ROADMAP.md](ROADMAP.md) — where the ZK proximity work and device-attestation
  tiers sit in the plan.
