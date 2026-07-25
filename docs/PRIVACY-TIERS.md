# FARE — End-to-End Privacy Tiers (design)

Design note for extending FARE's privacy from "the customer is protected" to
"every party exposes only what its counterparty needs." Companion to
[PRIVACY.md](PRIVACY.md) (the risk analysis this builds on),
[SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) (the funding-in path, shipped) and
[KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) (pool constraints).

Status: **design + phase-1 slice**. Phases 2–4 are specified here, not built.

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
  divert. Phase 3's ZK authorization is what removes it: once a ticket holder can
  prove entitlement without naming themselves, the vault can verify the batch and
  the keeper becomes untrusted again. **Do not enable a keeper you would not
  trust with the queued balance.**
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

---

## 6. Private discovery (phase 4 — the expensive one)

Goal: neither a chain observer nor a relay learns which customer ordered from
which venue. `OrderCreated` indexes `customer` and `venueId` today, so the graph
is published at creation.

**Recommended shape — two-phase reveal over an encrypted board, not PIR.** True
private information retrieval is the wrong tool here: an open order is *meant* to
be broadcast to every eligible driver, so there is no per-driver secret to
protect in the query. The leak is the *pairing*, and that is cheaper to fix:

1. **Post coarse.** The board carries only what bidding needs — region bucket
   (`OrderRegion`'s ~55 km cell already exists), fare, size, deadline. No venue,
   no customer, no drop area.
2. **Reveal on assignment.** Venue and drop details go to the *assigned* driver
   over the E2E channel (§5). Nobody else ever learns the pairing.
3. **Drop the on-chain edge.** `OrderCreated` stops indexing `venueId`; the
   venue is a commitment until settlement.
4. **Settlement must not re-reveal it.** Crediting the venue payout address at
   settlement republishes the edge — which is why this phase *depends on* §4.
   Shielded payouts and private discovery are not independent features; without
   §4, §6 leaks at settlement anyway.

Clients scan their region bucket and trial-match locally. Cost is O(orders in
region), which is small and bounded; that is the whole reason to prefer it to PIR.

Against T2, the board must be content-addressed and fetched with uniform request
shapes, so the relay stores opaque blobs and learns "a driver in region R polled"
rather than who bid on what.

---

## 7. Selective disclosure and relay hardening

**Disclosure capsule (phases 1–2).** At order creation the participants encrypt
the order key to the arbiter's public key and escrow the capsule. Normal
operation never opens it; a dispute does.

The subtlety: a malicious party can escrow *garbage* and stonewall a dispute, and
proving a ciphertext is well-formed needs a ZK proof of correct encryption —
expensive. Cheaper and sufficient: **fail closed.** A dispute in which a party's
capsule does not open resolves against that party. No proof needed; the incentive
does the work.

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
| **1b** | Keeper in venue-node, client shielding UX, encrypted registration metadata (§5), disclosure capsule (§7) | no | in progress |
| **2** | Denomination policy tuning, known-roots retry, batch telemetry, tier UX | no | next |
| **3** | Relay hardening: multi-relay, blinded queue authorization (ZK), no-log posture | new circuit | spike first |
| **4** | Private discovery (§6): coarse board, assignment-time reveal, drop the on-chain venue edge | `FareOrders` events | after 3 |

Ordering is forced, not preferred: §6 leaks at settlement without §4, and §7's
blinded queue is meaningless before §4 exists to blind.

## See also

- [PRIVACY.md](PRIVACY.md) — the risk analysis and what is already closed
- [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) — funding-in, shipped
- [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) — pool constraints (Issues 1–4)
- [MESSAGING.md](MESSAGING.md) — the E2E crypto layer §5 reuses
