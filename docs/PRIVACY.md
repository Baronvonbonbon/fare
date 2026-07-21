# On-Chain Location Privacy — Risk Analysis

Assessment date: 2026-07-20. Scope: the privacy risk of the position data
FARE writes to a public ledger. This is the *data-exposure* companion to
[GPS.md](GPS.md), which covers *integrity* (what a GPS attestation proves and
why the adverse-interest model is sound). Integrity and privacy are separate
axes — do not conflate them.

## TL;DR

- The commitment scheme gives **temporal** privacy (a drop location is hidden
  *until* dropoff), **not permanent** privacy. At dropoff the exact
  coordinates enter public calldata forever.
- **Driver coordinates are the most exposed of all** — they are *emitted in
  event logs*, which are trivially indexable (the same logs the app's own
  discovery reads).
- On-chain identities are persistent, and the app reuses **one burner per
  device**, so a customer's home is derivable after ~1 delivery.
- For a **testnet demo/pilot** the current posture is acceptable *with* a user
  warning + per-order burners. Before **real-money mainnet** the ZK path (or
  moving reveals off-chain) is a **hard prerequisite** — otherwise FARE
  permanently publishes customers' home addresses.

## What FARE writes on-chain

| Data | Where | Storage form | Exposure |
|---|---|---|---|
| Venue pin | `FareVenues.registerVenue` | plaintext storage | Public **by design** (business location) |
| Drop location — at order creation | `FareOrders.createOrder` | `keccak256(abi.encode(lat, lon, salt))` | **Private** — commitment reveals nothing |
| Drop location — at dropoff | `FareSettlement.confirmDropoff` | `DropoffReveal(lat, lon, salt)` in **calldata** (not stored, not emitted) | **Public & permanent** |
| Driver GPS (pickup + dropoff) | `confirmPickup` / `confirmDropoff` | calldata **and emitted** in `PickupConfirmed` / `DropoffConfirmed` | **Public & trivially indexable** |
| Venue GPS at pickup | `confirmPickup` | calldata | Public (venue pin is public anyway) |
| Order metadata | `OrderCreated(orderId, customer, venueId — all indexed)` | event topics | Public relationship graph |
| Pickup region (Phase 2) | `OrderRegion(region, orderId)` | event; region = ~0.5° (~55 km) cell of the venue pin | Coarse; derived from the public venue pin |

Key distinction: **calldata is not storage, but it is still permanent and
publicly readable.** A value used only transiently inside a function (like the
drop reveal, consumed for the hash + proximity check and never written to
storage) is nonetheless preserved forever in the transaction the whole world
can fetch. "Not stored" ≠ "not on-chain."

## Risks

1. **The drop reveal is a home address, made permanent.** The commitment buys
   privacy only *until* dropoff; then the exact coordinates sit in public
   calldata forever, bound to the customer's address and a timestamp, and
   geocodable to a street address. There is no delete.

2. **Driver location is the most exposed — via events.** `PickupConfirmed` and
   `DropoffConfirmed` both emit `driverAtt.lat / driverAtt.lon`. Event logs are
   the cheapest thing on a chain to index (it is exactly how this app's
   discovery works), so a driver's pickup/dropoff points are queryable in
   bulk. Over many jobs: routes, operating area, and likely home (start/end
   clustering). The `FareDrivers` ABI privacy-invariant test prevents a driver
   location being *stored as a profile field*, but does nothing about the
   aggregate inference from attestation events — **necessary, not sufficient.**

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

### The real fix (mainnet-grade)
**ZK proximity proof** (Groth16), as laid out in GPS.md: prove
`dist(driver, customer) < R ∧ H(customer, salt) = commit` with only
`(orderId, commit, nullifier)` public. **Neither party's coordinates ever hit
calldata or an event.** Reuses the DATUM circom/snarkjs pipeline (Poseidon
commitments, BN254 verifier, trusted-setup scripts). This is a substantial
project and the correct long-term answer.

### Near-term stopgaps (rough value/effort order)
1. **Per-order fresh burner wallets** (default) — breaks the linkability chain
   cheaply; cost is that each order-wallet needs a drip top-up. App-level.
2. **Coarsen the on-chain reveal** — geohash-truncate to ~±300–600 m and push
   exact-coordinate verification into the off-chain signature exchange.
   Weakens the on-chain distance check (a real tradeoff); a stopgap only.
3. **Reduce driver-coordinate exposure** — stop emitting `driverAtt.lat/lon`
   in `PickupConfirmed` / `DropoffConfirmed` (keep only in calldata) and/or
   round them. Removes the trivially-indexable leak (risk #2).
4. **Blunt user warning** at dropoff that the location becomes public — honest,
   zero-engineering.

## The mainnet gate

Before any real-money launch, at least one of the following **must** hold:

- ZK proximity proofs are live (coordinates never on-chain), **or**
- Exact-coordinate verification is fully off-chain and only coarse/hashed data
  is ever written,

**and** driver coordinates are removed from emitted events, **and** the
linkability posture (per-order identities or equivalent) is addressed. Absent
these, FARE is a public, permanent index of customers' home addresses and
drivers' movements — do not ship it for real value in that state.

## See also

- [GPS.md](GPS.md) — attestation integrity, the adverse-interest model, radii,
  and the ZK circuit design.
- [ROADMAP.md](ROADMAP.md) — where the ZK proximity work and device-attestation
  tiers sit in the plan.
