# FARE — End-to-End Privacy Tiers (design)

Design note for extending FARE's privacy from "the customer is protected" to
"every party exposes only what its counterparty needs." Companion to
[PRIVACY.md](PRIVACY.md) (the risk analysis this builds on),
[SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) (the funding-in path, shipped) and
[KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) (pool constraints).

Status: **phase 1 built and validated on Paseo** (§4, §5, §7 — see the phase
table). Phases 2–4 are specified here, not built. Live results and the anonymity
ceiling they exposed: [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md).

---

## TL;DR

- The customer is already well protected. **Drivers and venues are not** — every
  payout lands at a persistent address in `FareVault`, giving anyone with an
  indexer a complete, permanent revenue graph per driver and per venue.
- The obvious fix — a `withdrawToShield(commitment)` that pulls a balance and
  deposits it into Kusama Shield in one transaction — **does not work.** It emits
  the account and the pool commitment in the same transaction, so the note is
  trivially attributable. Section 3 covers this; it is the finding that shapes
  the whole design.
- What does work is a **batched, denomination-bucketed, delayed** vault→pool
  deposit, executed by relays as a keeper role. That breaks the transaction-level
  link a chain observer needs.
- Privacy is offered as **tiers**, not a mode switch: each mechanism is
  independently useful, and the expensive ones (private discovery) can lag.
- Disclosure is **selective, not absolute** — disputes and safety incidents must
  stay resolvable. Fail-closed defaults make that enforceable without a ZK proof
  of correct encryption.

---

## 1. Threat model

In scope:

| | Adversary | What they see today | Defeated by |
|---|---|---|---|
| **T1** | **Chain observer** — anyone with an RPC and an indexer | Every payout, every bid, the customer↔venue edge, all amounts and timings | §4 shielded payouts, §6 private discovery |
| **T2** | **Relay operator** — a venue node routing traffic | IPs, request timing, who talks to whom, plaintext it forwards | §5 encryption, §7 relay hardening; fully only in phase 3 |
| **T3** | **Other participants** — a driver, venue, or customer in the system | Counterparty metadata beyond what the job needs | §5 need-to-know encryption |

Explicitly **out of scope**: a global passive network observer (ISP-level traffic
correlation). Defeating that needs mixnet-grade transport, which the app cannot
provide alone. Saying so bounds §7: relay hardening aims to blind the relay
*operator*, not to resist traffic analysis of the wire.

Also out of scope: a malicious *majority* of relays, and the trusted-setup
weakness already tracked in PRIVACY.md (single-party ceremony).

---

## 2. Where each party stands today

| Party | Identity | Location | Money | Metadata |
|---|---|---|---|---|
| **Customer** | Per-order burner (`wallets.ts`) | ZK dropoff — no coordinate on-chain | Shielded in, via Kusama Shield (`shield.ts` → `shieldpool.ts`) | Order contents E2E-encryptable (`msg.ts`) |
| **Driver** | **One persistent address** — stake, reputation, bids all bound to it | Pickup coords coarsened ~33 m, dropoff ZK | **Fully public** — `Withdrawn(account, to, amount)` per payout | **`metadataURI` plaintext** — name, vehicle, contact |
| **Venue** | **One persistent address** per venue, operator link public | Pin public **by design** (it's a business address) | **Fully public** — payout address + every release | `metadataURI` plaintext |

The asymmetry is the point: the work already done went to the party who could be
protected without touching the economics. The remaining exposure is concentrated
in the two parties whose stake, reputation, and payouts are identity-bound.

### Venue location — a deliberate non-goal

Encrypting the venue pin is not worth doing. It is a public business address,
it is already on every map product, and hiding it breaks discovery and driver
navigation for no adversary-visible gain. What is worth hiding is the *payout*
address (§4), the operator↔venue link, and the per-order customer↔venue edge
(§6) — not the pin.

---

## 3. The finding: a one-transaction shielded payout is self-defeating

The natural design is a vault method that pulls the caller's balance and
forwards it into the pool:

```solidity
// DOES NOT PROVIDE PRIVACY — do not ship this shape
function withdrawToShield(bytes32 commitment) external {
    uint256 amount = balanceOf[msg.sender];
    balanceOf[msg.sender] = 0;
    pool.depositNative{value: amount}(commitment);
}
```

One transaction emits both `Withdrawn(driver, pool, amount)` and the pool's
`Deposit(asset, commitment)`. An observer reads the receipt and learns exactly
which commitment belongs to which driver. The note is burned before it is
spent — the pool's anonymity set does nothing, because the attacker never needed
to search it.

The same trap applies to two adjacent designs worth naming so nobody re-proposes
them:

- **Withdraw to a fresh burner, deposit from there.** `Withdrawn(driver, burner,
  amount)` links driver→burner, and the burner's deposit links burner→commitment.
  The chain is one hop longer and just as complete. It also needs the burner
  pre-funded for gas, which re-links again.
- **Supply the commitment at bid time** so settlement credits it directly.
  `BidPlaced(orderId, driver, amount)` is public, so the driver→commitment
  binding is published even earlier.

The invariant to design against: **any transaction, or chain of transactions with
no other participants in it, that touches both an identity and a commitment
destroys the note's privacy.** Unlinkability has to come from *other people's*
deposits being indistinguishable from yours, which means batching.

---

## 4. Shielded payouts (phase 1 — this branch)

Split the payout into two transactions with no shared identity:

```
T1  driver signs an EIP-712 shield authorization (off-chain) and hands the
    keeper its commitment OFF-CHAIN — the commitment must never ride in this
    transaction's calldata, which is as public and permanent as storage.
    relay submits it → vault moves `bucket` from balanceOf[driver] into a
                       shared buffer and issues a TICKET
                       ── on-chain: (driver, bucket, ticket#). No commitment. ──

    ...dwell: the queue fills with other drivers' and venues' tickets...

T2  keeper executes a batch of N commitments in ONE tx, consuming the N
    oldest tickets FIFO
    → N × pool.depositNative{value: bucket}(commitment_i)
                       ── on-chain: N commitments. No account. ──
```

An observer of T2 sees N equal-value deposits from the vault. An observer of T1
sees that a driver moved a *bucketed* amount into the buffer. Pairing the two
requires guessing which of the N commitments is theirs — the anonymity set is the
batch, on top of whatever the pool already holds.

Design rules that make this hold:

- **Denomination bucketing.** Deposits are fixed sizes (e.g. 1 / 5 / 25 PAS).
  A driver with 7.3 PAS shields 5 + 1 + 1 and leaves 0.3 credited. Without this,
  amounts are fingerprints and the batch is decorative.
- **Minimum batch size.** Executing a batch of 1 is the §3 anti-pattern with extra
  steps. The queue must not execute below a floor (and the floor is a real
  liveness/latency tradeoff — see §8).
- **Dwell.** A batch must not chase a just-queued ticket, or timing re-links it.
  Enforced on-chain (`shieldMinDwell`) rather than left to keeper discipline.
- **Ticket ownership is on-chain, commitment ownership is not.** A ticket records
  its owner so the owner can reclaim a stalled one; that publishes only
  (account, bucket, position), which T1's event already revealed. What is never
  written anywhere is which commitment redeems which ticket.
  **Amended by the live run:** in isolation that is true, but consuming tickets
  in the *same transaction* as the deposits let an observer pair them. Phase 2
  splits the two (`sealShieldBatch` / `depositShieldBatch`), which fixes it
  without concealing anything — see [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) §2.
- **The buffer is fungible.** Value lives in one vault-held pool, not
  per-account, so the buffer balance itself reveals nothing about who queued.

### What this does *not* hide

- **The amount a driver earns per order** stays public in `OrderDelivered` /
  `RelayServiceFeePaid`. This design hides *where the money goes*, not what it
  was. Hiding amounts needs confidential escrow — out of reach here (§8).
- **T2's executor knows the pairing** if it also submitted T1. That is the T2
  threat, and phase 1 does not close it — phase 3 does (§7).
- **A keeper can steal the buffer.** This is the sharpest edge in phase 1 and it
  is inherent, not an oversight: the vault cannot check that a commitment in a
  batch belongs to a ticket holder, because knowing that is exactly the pairing
  the design exists to destroy. An authorized keeper that submits commitments it
  controls consumes the tickets and keeps the notes. Phase 1 bounds this rather
  than solving it — keepers are governance-authorized (`setShieldKeeper`), theft
  is immediately visible to the victims (their note does not exist in the pool),
  and the exposure is capped by what is queued at that moment. It is a genuine
  custody escalation over today's vault, where a relay can submit but never
  divert. **Do not enable a keeper you would not trust with the queued balance.**
  **Closed in phase 3** (§7): `depositShieldNoteZK` binds the deposit target into
  the proof and needs no keeper at all — prefer that path wherever the verifier
  is wired. The description of the fix that used to sit here was wrong in the
  same way phase 2's first attempt was: it imagined proving entitlement against a
  *ticket*, but a ticket's position is derivable from queue order, so the note
  pool replaces tickets rather than authenticating them.
- **USDC payouts.** The pool holds native PAS; the live USDC flow derives escrow
  by swapping shielded PAS → USDC on the local DEX (`venue-node/swap.mjs`). A
  shielded USDC *payout* needs the reverse swap, and it must happen at the
  **batch** level — a per-driver USDC→PAS swap is a fresh on-chain edge that
  re-links exactly what the batch just unlinked.

---

## 5. Need-to-know encryption (phase 1)

`metadataURI` on both `FareDrivers` and `FareVenues` is plaintext today — a
driver's name, vehicle, and contact route are world-readable, which fails T3 for
no benefit. Replace with:

- On-chain: `keccak256(metadata)` only — enough to prove the counterparty was
  shown the real thing, nothing to read.
- Off-chain: the payload encrypted per-order to the counterparty, reusing the
  ECDH → HKDF → AES-GCM layer already built and tested in `web/src/msg.ts`
  (§1 of [MESSAGING.md](MESSAGING.md)). Keys come from signatures both parties
  already produce at handoff, so there is still no key-exchange step.

Scope by stage: the driver's vehicle and contact are revealed at **assignment**,
not at bid; the customer's drop details at **assignment**, not at order creation.
Bidding needs fare, region, and reputation — not identity.

**As built** (`web/src/regmeta.ts`): `metadataURI` carries
`fare-meta:v1:<keccak256(canonical profile)>`, so no contract change was needed —
the field was already a free-form string. The profile travels over the existing
order thread (`channel.ts` kind `profile`) under the same per-order ECDH key, and
the receiver refuses anything that doesn't hash to the commitment. Binding is
half the point: a driver who could present any profile would have moved the
problem off-chain rather than solved it. Two consequences worth knowing:

- The chain holds a hash, so **the plaintext lives only on the driver's device**.
  Losing it means re-registering a new commitment; the driver UI warns when a
  committed profile has no local plaintext.
- Private is the **default** at registration. A tier a handful of people opt into
  is itself an identifying signal (§7).

---

## 6. Order-graph privacy (phase 4)

The original plan here was a private discovery board. **Tracing the actual leak
showed the board is not the lever**, and the plan is recorded below as it was
found to be wrong, because the reasoning matters more than the conclusion.

### Why the board delivers nothing

1. **Discovery is already coarse.** Drivers find work through `OrderRegion`
   (~55 km cells), not by venue. Nothing about discovery publishes the venue.
2. **The venue is public because `orders(orderId).venueId` is public STORAGE.**
   Moving discovery off-chain hides nothing while that field exists, and it
   cannot simply go: `confirmPickup` needs `venues.signerOf(venueId)` and
   settlement needs `venues.payoutOf(venueId)`.
3. **The customer is already a burner.** With per-order wallets shipped, the
   graph is *burner* ↔ venue, not *person* ↔ venue. What the original framing
   described — "person X ordered from venue Y at time T" — stopped being true
   when per-order wallets landed.

Commit-and-reveal on the venue would hide it during the open/bidding window and
then reveal it at pickup: a delay of minutes, bought with a change to
escrow-critical code. Hiding it for good means the venue's payout entering the
note pool as a commitment so the venue is never named at settlement — a
research-scale change, and the honest full fix. Neither is built.

### What was built instead: sealed bids

The largest remaining leak of the same kind, and it is about drivers rather than
customers. `BidPlaced(orderId, driver, amount)` publishes **every** bid,
including the ones that lose. Drivers are persistent identities, so an indexer
assembles a standing record of where each driver was willing to work and for how
much — about people who never won the job. The customer needs the bid; the world
does not.

```
commitBid(orderId, bidHash, revokeHash)   only a hash on-chain; submitted by a
                                          relay, so the bidder is not named
   ...terms travel to the customer off-chain, over the order channel...
acceptSealedBid(orderId, driver, amount, salt)   the customer reveals the winner
```

- `bidHash = keccak256(orderId, driver, amount, salt)` binds both the driver and
  the price, so a customer cannot accept at a price nobody bid or attribute a bid
  to a driver who never made it.
- `maxFare` and driver eligibility are checked **at reveal**, because at commit
  time the amount and the bidder are hidden.
- Retraction takes a **secret**, not a signature: bid hashes are public, so
  authorizing by signature would put the bidder's address on-chain and undo the
  point.
- `commitBid` is open to anyone (that is what keeps it anonymous), so commitments
  are capped per order.

**The winner is still public** — they perform the delivery and are paid. What
this removes is the losers, which is most of the graph. The open-bid path is
untouched and still works, so this is additive.

## 7. Selective disclosure and relay hardening

**Disclosure capsule (phases 1–2).** At order creation the participants encrypt
the order key to the arbiter's public key and escrow the capsule. Normal
operation never opens it; a dispute does.

The subtlety: a malicious party can escrow *garbage* and stonewall a dispute, and
proving a ciphertext is well-formed needs a ZK proof of correct encryption —
expensive. Cheaper and sufficient: **fail closed.** A dispute in which a party's
capsule does not open resolves against that party. No proof needed; the incentive
does the work.

**As built** (`web/src/capsule.ts`, `disclosure.ts`, arbiter UI in
`ops/DisputesConsole.tsx`). No contract change: `openDispute`'s `evidenceURI` is
free-form, so it carries the anchor.

- **What a capsule discloses is one order's thread key**, exported from the same
  per-order ECDH the messages already use (`msg.ts exportOrderKey`). It is not an
  account key: it cannot sign, cannot spend, and cannot open any other order.
  That scoping is what makes the disclosure selective rather than total.
- **Escrowed at thread open**, before anyone knows whether there will be a
  dispute — a party who could decide afterwards would simply decline.
- **Sealed only to a verified arbiter.** An address can't be encrypted to, so the
  pubkey comes from config (`VITE_ARBITER_PUBKEY`) and is used only once it
  derives to the address `FareDisputes.arbiter()` names. A wrong or hostile key
  is a no-op instead of a silent leak.
- **Ephemeral sender key per capsule**, so two capsules from the same driver on
  two orders aren't relatable.
- **Anchored on-chain at dispute time**: `fare-capsule:v1:<digest>` pins which
  capsules the dispute was opened over. Without it the transport could swap a
  capsule afterwards and fail-closed would punish the honest party. The digest is
  order-independent, since the two parties post separately.

Known limitation: the capsules live on the relay-hosted thread, and the anchor
only pins them at dispute time. **A malicious relay can drop a capsule and get an
honest party ruled against.** A party can detect this (their own capsule is
missing from the thread) and re-post, but a determined relay can keep dropping —
one more reason multi-relay routing (§3 of the phase table) is not optional
polish. Anchoring at assignment would close it, and that does need a contract
change.

**Relay hardening (phase 3).** Phase 1 leaves the keeper able to pair T1 with T2.
Closing it needs the queue entry to be authorized *without* naming the account —
a second circuit proving "I own ≥ `bucket` in the vault" against a balance
commitment, with a nullifier to prevent double-spend. That is a genuine ZK build
and should be scoped as a spike, not estimated here.

Everything cheaper comes first: multiple relays with per-order selection, a
no-logs posture that is actually verifiable, uniform request shapes, and padding
of the request cadence. Note that a *tier selection* is itself a signal — if only
three users pick "maximum", the tier is their fingerprint. Tiers must default on
to be worth anything.

---

## 8. Honest limits

- **The anonymity set is tiny.** ~230 leaves and 48 real withdrawals at last
  measurement. Every mechanism here is bounded by that number, not by the
  cryptography. Routing FARE's payouts through the pool grows it — but if FARE
  comes to dominate the set, the set *is* FARE's users, and cross-traffic cover
  disappears. Whether to share a pool or run a FARE-specific one is an open call.
- **The 16-entry known-roots window** (Issue 4, KUSAMA-SHIELD-FINDINGS) makes
  delayed withdrawals revert under load. Phase 1 turns delayed withdrawal from an
  edge case into the *common* path, so this needs measurement and a
  retry-against-fresh-root strategy before it scales.
- **Amounts and timing stay public.** Order values, fees, and delivery times are
  in the clear and are strong correlators on their own. Delivery timing in
  particular signals when someone is home — PRIVACY.md risk #4, unchanged here.
- **On Paseo a transaction holds at most 2 pool deposits** — a proof-size bound,
  not gas (a 2-deposit call estimates ~40 k; raising the limit to 500 M changes
  nothing). Before phase 2 this *was* the anonymity set, because sealing and
  depositing shared a transaction and an observer could read which accounts'
  tickets those commitments were. Phase 2 split them (§4), so the ceiling now
  decides only how many deposit transactions follow: measured at an 8-ticket seal
  with 4 deposit transactions in [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) §5.
  The residual limit is that a **seal** still names its accounts, so the
  anonymity set is the seal size — make it large.
- **Batching trades latency for privacy.** A driver wanting cash now and a large
  anonymity set cannot both be satisfied; the floor and delay are a product
  decision, not a parameter to tune quietly.
- **Anonymous driver credentials are unsolved.** Stake, slashing, and reputation
  are identity-bound. A membership proof ("registered, unbanned, stake ≥ M,
  rating ≥ R", nullifier per order) is the known shape, but slashing then needs
  bonded notes or a fault-triggered reveal. Spike before committing.

---

## 9. Staged plan

| Phase | Contents | Contract change | Status |
|---|---|---|---|
| **1a** | Batched shielded payouts (§4) — vault queue, batch, reclaim | `FareVault` | **built** |
| **1b** | Keeper (`venue-node/shieldkeeper.mjs`) + client queue/claim (`web/src/shieldpayout.ts`) | no | **built** |
| **1c** | Encrypted registration metadata (§5) + driver-facing UI — commitment in `metadataURI`, reveal over the order thread | no | **built** |
| **1d** | Disclosure capsule (§7) — capsule crypto, escrow at thread open, on-chain anchor, arbiter console | no | **built** |
| **2a** | Decouple sealing from depositing so the chain's per-tx deposit ceiling stops capping the anonymity set | `FareVault` | **built** |
| **2b** | Denomination tuning, known-roots retry, batch telemetry, tier UX | no | next |
| **3** | Relay hardening: multi-relay, blinded queue authorization (ZK), no-log posture | new circuit | spike first |
| **4a** | Sealed bids (§6) — commit/reveal so losing bids name nobody | `FareOrders` | **built** |
| **4b** | Sealed-bid client + relay channel carrying bid terms to the customer | no | open |
| **4c** | Venue payouts entering the note pool as commitments (the only fix that hides the venue for good) | `FareOrders`/`FareSettlement` | research |

Ordering was forced for §4 and §7 (a seal is meaningless before there is
something to seal). §6 turned out not to depend on them at all — see above.

## See also

- [PRIVACY.md](PRIVACY.md) — the risk analysis and what is already closed
- [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) — funding-in, shipped
- [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) — pool constraints (Issues 1–4)
- [MESSAGING.md](MESSAGING.md) — the E2E crypto layer §5 reuses
