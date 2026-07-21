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

Current posture — **ZK proximity proof (implemented):**

1. At order creation the drop commitment is `Poseidon(latEnc, lonEnc, salt)`
   (offset-encoded microdegrees; see `circuits/proximity.circom`). Browsing the
   chain reveals nothing about the destination.
2. At dropoff **no coordinates go on-chain at all** — not calldata, not
   storage, not events. `FareSettlement.confirmDropoffZK` takes a Groth16 proof
   that, against the on-chain commitment, the driver's committed position is
   within `dropoffRadiusMeters` of the customer's committed drop location:

   > `dist(driverPos, customerPos) < R  ∧  Poseidon(customerPos, salt) = dropCommit  ∧  Poseidon(driverPos, drvSalt) = driverCommit`

   Public signals are only `(orderId, dropCommit, driverCommit, radiusMeters,
   nullifier)`. Both parties' coordinates are private circuit witnesses.

   The adverse-interest model survives (see the table above): the driver
   ECDSA-signs a commitment to their **own** position — they won't sign a false
   one, because the proximity proof would then fail — and only the customer can
   produce the proof (it needs the drop salt, which only they hold), so the
   proof *is* the customer's consent. The driver hands their position + salt to
   the customer face-to-face; the customer proves locally and submits.

The pipeline reuses DATUM's circom/snarkjs approach: Poseidon commitments, a
hand-rolled BN254 Groth16 verifier over the `0x06/0x07/0x08` precompiles that
pallet-revive exposes on Asset Hub (`FareLocationVerifier.sol`), and a
single-file trusted setup (`scripts/setup-zk.mjs`; a real ceremony is a mainnet
prerequisite — `setVerifyingKey` is lock-once). The circuit's distance check
mirrors GeoLib's equirectangular + Bhaskara-cosine math, made division-free by
cross-multiplying `dx²+dy² ≤ R²`.

**Still plaintext (follow-up):** driver + venue coordinates at **pickup** remain
in calldata, and the driver's pickup coordinates are still emitted in
`PickupConfirmed`. The venue pin is public by design, so the sensitivity is far
lower than the customer's home — but the mainnet gate (docs/PRIVACY.md) also
wants driver coordinates out of pickup events. A pickup-side circuit or simply
dropping the coordinates from the event is the remaining step.

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
4. ~~**ZK proximity circuit** for location privacy~~ — **done** for dropoff
   (`confirmDropoffZK`); pickup-side is the remaining follow-up (above).
5. **Witness diversity**: for very high-value orders, require an extra
   attestor (a second staked driver nearby, or a venue-adjacent beacon).
