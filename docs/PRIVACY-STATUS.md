# FARE — where privacy stands, by role

Status as of the 2026-07-26 migration (`scripts/upgrade-privacy.ts`), which put
privacy phases 1–4 on the live Paseo deployment.

This is the "what is actually protected" reference. The *designs* live in
[PRIVACY-TIERS.md](PRIVACY-TIERS.md), the original risk analysis in
[PRIVACY.md](PRIVACY.md), and the live measurements in
[E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) and [E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md).

**Read the Open columns first.** Everything closed is closed; the value of a
document like this is in what still leaks.

Those Open rows are **executable**. `test/expected-leaks.test.ts` asserts that
each chain-observable leak below is still present, and quotes the row it pins —
so closing one breaks a test, and editing a row without touching the test breaks
a different one. The tables and the suite cannot drift apart in either
direction (TEST-PLAN B3).

---

## Customer

| Closed | How |
|---|---|
| Identity across orders | A fresh burner wallet per order (`web/src/wallets.ts`), so consecutive orders share no on-chain identity |
| Funding those burners | Shielded through Kusama Shield — the funding edge that would otherwise re-link a burner to the main wallet |
| Drop location | ZK proximity proof: no coordinate ever enters calldata, storage, or an event |
| Order contents and chat | End-to-end encrypted, per-order keys |
| Name, phone, buzzer code, delivery instructions | Committed and revealed like a driver's profile (`web/src/regmeta.ts`), and never on-chain. A burner has no registry slot, so the commitment rides the order thread's `hello` **signed by the order wallet** — a relay that rewrites it is ignored rather than able to make an honest reveal fail. The plaintext goes only to the assigned driver. |
| What the venue is cooking | The line items are sealed to the venue's hot signer under an ephemeral key (`web/src/ticket.ts`), so the relay carrying them learns nothing and the envelope names no sender. The venue checks the total against the escrowed `orderValue`, so the binding needs no on-chain commitment. |

| Open | Why it matters |
|---|---|
| **Order value and tip are public** | `OrderCreated` publishes both. Spend per order is legible forever. |
| **Delivery timing is public** | When a delivery completes signals when someone is home — burglary and stalking relevance, independent of coordinates. PRIVACY.md's risk #4, still unaddressed. |
| **Which venue an order is for** | `orders(orderId).venueId` is public **storage**, not merely an event. |

One nuance on the last row: because per-order burners already shipped, that edge
is *burner* ↔ venue, not *person* ↔ venue. It leaks a venue's order volume more
than a customer's habits — which is why the phase-4 plan built against the older
framing was retargeted (PRIVACY-TIERS §6).

## Driver

Drivers were the most exposed party a month ago and are now the most improved.

| Closed | How |
|---|---|
| The keeper's divertible buffer | **Removed.** The three-transaction ticket path (`queueShieldCredit` → `sealShieldBatch` → `depositShieldBatch`) and `setShieldKeeper` are gone from the vault. Its anonymity set was only the seal size, and the keeper held the account↔commitment pairing, so it could substitute its own commitments — dormant only because nobody was authorized, and one owner call from being live. The ZK note path needs no keeper and is permissionless. |
| Revenue graph | Payouts enter the shielded pool. With the ZK path the anonymity set is every unspent note **of the same bucket**, not a batch — the bucket is a public signal of the spend, so denominations partition the crowd (measured in `test/anonymity-set.test.ts`). |
| Name, vehicle, plate, contact | On-chain is `keccak256(profile)`; the details are revealed only to the order counterparty and refused unless they hash to that commitment. The "Save public" button that wrote a plaintext `demo://` profile instead is **gone** — a privacy default undoable in one tap is a default, not a property. |
| Losing bids | Sealed: only a hash is committed, and a relay submits it, so the chain never sees who bid or how much |
| The open-bid escape hatch | **Removed.** `placeBid`/`withdrawBid`/`acceptBid`/`acceptBidERC20` and the public bid mapping are gone from the contract, not merely un-offered by the UI. Sealed bids were additive at first, which made the guarantee a default a driver could opt out of; there is now no second path to opt into. Asserted by absence in `test/expected-leaks.test.ts`. |
| Pickup coordinates | Coarsened to ~33 m and no longer emitted |

| Open | Why it matters |
|---|---|
| **Persistent identity** | Stake, reputation, and the winning assignment are address-bound. Anonymous driver credentials (membership + reputation proof) were never in scope. |
| **Per-order earnings** | `OrderDelivered` publishes the amount paid. |
| **The winning bid is public** | Unavoidable in this design — the winner performs the delivery and is paid. Sealed bids remove the losers, which is most of the graph, not all of it. |

## Venue

| Closed | How |
|---|---|
| Payout destination | The same shielded paths drivers use |
| Counter phone and pickup instructions | Committed in the menu JSON (which `metadataURI` already anchors, and only the operator can set) and revealed over the order thread to the assigned driver. The menu stays public; these are not in it. |

| Open | Why it matters |
|---|---|
| **Location and menu are public** | **By design.** A venue is a business address; encrypting it breaks discovery and navigation for no adversary-visible gain (PRIVACY-TIERS §2). |
| **Order volume and timing** | Derivable from the venue edge above. |
| **Settlement names the venue** | The payout credits `venues.payoutOf(venueId)`. Closing this means venue payouts entering the note pool as commitments so the venue is never named — research-scale, tracked as phase 4c. |

## Cross-cutting

| Open | Severity |
|---|---|
| **Both trusted setups are single-party** — the proximity circuit and the shield-note circuit | **Mainnet-blocking.** `setVerifyingKey` is lock-once, so a real multi-party ceremony with a published transcript must precede any mainnet deploy. This is the top item. |
| **Relay metadata** | Request bodies are padded to fixed blocks, a note spend routes away from the relay that saw its insert, and client addresses are hashed under a rotating salt so no table of callers is kept. But with a single relay configured there is no split to make, and a malicious relay can still drop a disclosure capsule and get an honest party ruled against. |
| **Anonymity is only as large as usage** | An empty note tree is an anonymity set of one. The mechanisms are right; the privacy is whatever adoption provides. |
| **Amounts are public everywhere** | Order values, fees, and payouts. Hiding them needs confidential escrow, which nothing here provides. |

---

## What is actually live

Migrated 2026-07-26 (PR #11). The old vault stays live so existing balances
remain withdrawable — the freeze-and-drain pattern.

```
vault           0x1ebE61af02d4b5E6083089f220e5D95766643a13   (old 0x51bD2e55… draining)
orders          0x0e638033a89Fa4367acEbb57F62f59776d1c6437
shieldVerifier  0x97C3DA8aD06E99B195D4B2B86dfa18d23387fDcD
shieldPool      0x7d5a496bD61b631025A828d9049f6A68e007e0dC   (Kusama Shield)
poseidon        0x1d165f6fE5A30422E0E2140e91C8A9B800380637   (Paseo precompile)
buckets 1 / 5 / 25 PAS · minBatch 8 · dwell 300 s · no keeper authorized
```

**Exercised end to end** (`scripts/privacy/live-order-e2e.mjs`, order #3): one
real delivery through every privacy path this work added —

| Step | Result |
|---|---|
| Customer burner funded from Kusama Shield | 5 PAS, no edge from the funder |
| Order created by that burner | #3 |
| **Sealed bid** | commit named neither the driver nor the price — checked against the mined transaction |
| Accept, pickup | assigned, picked up |
| **ZK dropoff** | delivered; no drop coordinate in calldata or logs |
| Payouts | driver credited 1.95 PAS (fare 2 less the 2.5% protocol fee) |
| **ZK shielded payout** | note inserted, tree matched the client, spend named no account |
| Pool withdrawal | 1.0 PAS to a fresh address |
| Venue withdrawal | plain path still works |

Three bugs surfaced, all fixed and none of them theoretical:

- **`depositAndSnapshot` recorded the wrong block.** It fell back to
  `getBlockNumber()` when `tx.blockNumber` was still null after `wait()`, so a
  later scan could start *past* its own commitment and the note looked lost.
  A client-side bug that would have hit a real customer.
- **User transactions must size their own gas.** Paseo reserves
  `gasLimit × gasPrice` at submission, so the 500 M weight limit reserves ~500
  PAS — fine for a funded relay, impossible for a fresh driver.
- **`positionCommit` is Poseidon(lat, lon, salt)**, a three-input hash. Nesting
  two-input hashes produces a commitment the proximity circuit rejects.

One artifact of the demo configuration worth knowing when reading the numbers:
the treasury and the venue payout are the **same address** (the deployer), so the
venue and treasury credits above are one balance read twice, not a split.

## If you only fix three things

1. **Run a real trusted-setup ceremony.** Everything else is testnet-shaped
   without it, and the lock-once VK means it cannot be retrofitted.
2. **Get a second relay into the pool.** Half the phase-3b work is inert with
   one — the split it performs has nowhere to route.
3. **Decide about amounts.** Values, tips, and payouts are the largest remaining
   public surface for every role, and no amount of identity privacy hides them.

## See also

- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — designs, threat model, phase table
- [PRIVACY.md](PRIVACY.md) — the original location-exposure analysis
- [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) — phases 1–2 live, and the
  proof-size ceiling that reshaped them
- [E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md) — phase 3 live, and why that ceiling
  stopped applying
