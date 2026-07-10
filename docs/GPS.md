# GPS Settlement — What It Proves, What It Doesn't

## The honest framing

A smart contract cannot sense physical location. What `FareSettlement`
actually verifies is:

> Two parties **with adverse economic interests** each produced an EIP-712
> signature over coordinates + a timestamp, and those coordinates are
> mutually consistent with the registered/committed location within a
> tunable radius, within a freshness window.

That's it. The security comes from the *adversity of interests*, layered
with economics:

| Attack | Why it fails (or what bounds it) |
|---|---|
| Driver fakes pickup GPS alone | Venue won't cosign — no pickup without the venue's signature |
| Venue fakes pickup alone | Driver won't cosign; orderValue never releases |
| Driver fakes dropoff alone | Customer won't sign the handoff; fare never releases |
| Customer refuses to sign after receiving goods | Driver opens a bonded dispute; arbiter sees pickup was confirmed + driver's dropoff attestation; customer loses escrow split and reputation |
| Driver + venue collude (phantom pickup) | Only releases `orderValue` the customer already escrowed for that venue — equivalent to venue fraud on a normal order; customer disputes, venue/driver stakes slashable, reputations burned |
| GPS spoofing (mock location) | Not detectable on-chain. Bounded by: the counterparty must *also* be spoofing (collusion case above), stake slashing, reputation, and at scale device-attestation (see below) |
| Replay of an old attestation | `orderId` + `phase` bind the signature to one order step; the status gate makes each phase fire once; timestamps bound freshness |
| Cross-order replay | `orderId` is in the signed struct |

**Design consequence:** every release of money requires signatures from two
parties whose incentives oppose each other at that moment. The pickup pairs
the driver (wants the job started) with the venue (loses goods if fake). The
dropoff pairs the driver (wants the fare) with the customer (loses escrow if
fake). Collusion is possible but always maps onto an existing fraud shape
with an existing economic answer (stake, dispute, reputation) — the same
posture DATUM takes for "attention isn't provable" (its F-1).

## Privacy

Venue pins are public information — that's fine. Customer drop locations are
**home addresses** and must not sit in a public ledger.

Current MVP posture:

1. At order creation only `keccak256(abi.encode(lat, lon, salt))` goes
   on-chain. Browsing the chain reveals nothing about the destination.
2. At dropoff the customer's signed reveal (lat, lon, salt) appears in
   **calldata** — public, permanent. This is the MVP's known privacy gap.

Production upgrade path (in priority order):

- **ZK proximity proof** (the real fix): a Groth16 circuit proving
  `dist(driverPos, customerPos) < R ∧ H(customerPos, salt) = commit` with
  only `(orderId, commit, nullifier)` public. The DATUM circom/snarkjs
  pipeline (Poseidon commitments, BN254 verifier, trusted-setup scripts) is
  directly reusable. Note the driver's coordinates are also private inputs,
  so *neither* party's position ever hits calldata.
- Interim mitigation: geohash-truncate the reveal (e.g. ~±600 m cell) and
  push exact-coordinate verification into the driver/customer signature
  exchange off-chain. Weakens the on-chain distance check; acceptable only
  as a stopgap.

## Radii and freshness

- `pickupRadiusMeters` (default 150) — urban-canyon GPS error is 10–50 m;
  150 m accepts a driver parked around the corner while still rejecting a
  driver two blocks away.
- `dropoffRadiusMeters` (default 100) — tighter, because the customer's
  committed pin *is* the destination.
- `attestationMaxAgeSecs` (default 15 min) + future-skew allowance (5 min) —
  attestations are signed on phones with imperfect clocks, then submitted in
  a transaction that may wait for a block. The window must cover
  sign→handshake→submit latency without letting stale fixes replay.
- All tunable by governance within hard bounds (25–2000 m, 1 min–2 h).

## On-chain geometry

`GeoLib` works in **microdegrees** (`int32`, degree × 10⁶ ≈ 11 cm
resolution) and uses the equirectangular approximation with a Bhaskara-I
rational cosine (max err ≈ 0.16%, no lookup tables, no trig):

```
d² = (Δlat·M)² + (Δlon·cos(latμ)·M)²   where M = 111,320 m/degree
```

At geofence scales (< a few km) this is accurate to well under 1% versus
haversine — far below GPS noise. Comparisons are done on squared meters to
avoid an on-chain square root.

## Hardening ladder (post-MVP)

1. **Stake floors > 0** for drivers (and venues) once volume justifies it —
   makes collusion carry real capital risk. Already governance-settable.
2. **Velocity/plausibility checks** at dispute time: pickup→dropoff
   timestamps vs. distance imply a speed; superhuman speeds are evidence.
3. **Device attestation** (Play Integrity / App Attest) as an L2-style
   assurance tier for high-value orders — mirrors DATUM's AssuranceLevel
   gradient rather than a single global rule.
4. **ZK proximity circuit** for location privacy (above).
5. **Witness diversity**: for very high-value orders, require an extra
   attestor (a second staked driver nearby, or a venue-adjacent beacon).
