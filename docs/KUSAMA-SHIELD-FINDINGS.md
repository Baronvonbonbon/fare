# Kusama Shield — integration findings & questions

*From an external integrator (the FARE team). We integrated private wallet
funding against your Paseo Asset Hub pool and got it working end-to-end. Two
things blocked a general-purpose integration; we think both are easy fixes on
your side and wanted to check whether you'd be open to addressing them. Thank
you for building this — the relayer withdrawal path is exactly what we needed.*

> **Update — we shipped client-side workarounds for Issues 1 & 4** so FARE isn't
> blocked while you consider these, but they'd be simpler and more robust if
> fixed upstream:
> - **Issue 1:** instead of the genesis value, we snapshot each note's immutable
>   left-path (`sideNodes` at its index's set bits) at deposit time and rebuild
>   only the right side from a bounded post-deposit event scan. This gives
>   general deposit-ahead/withdraw-later (validated by withdrawing an interior
>   leaf). Publishing the genesis value / emitting an event on every insert would
>   let integrators skip the snapshot dance.
> - **Issue 4:** our relayer retries on `"Unknown root"` (rebuild against a fresh
>   root), which narrows but can't close the race under load — a larger
>   `ROOT_HISTORY_SIZE` still matters.
>
> Implementation: `web/src/shieldpool.ts`, `venue-node/relay.mjs` (`/shield-withdraw`).

---

## Deployment we tested against

Paseo Asset Hub (chainId `420420417`), native PAS:

| Component | Address |
|---|---|
| Pool `FixedIlopPhase2Paseo_v7` | `0x7d5a496bD61b631025A828d9049f6A68e007e0dC` |
| Groth16 Verifier | `0x354f7353F6770b015376c386A3bF4760A7773E16` |
| PoseidonT3 precompile | `0x1d165f6fE5A30422E0E2140e91C8A9B800380637` |
| Circuit | `withdraw_phase2_fixed_v7` (`.wasm` + `.zkey` from `scripts/`), 8 public signals |

**What worked:** `depositNative(commitment)` → build a withdrawal proof →
`proxy_withdraw(pA, pB, pC, pubSignals, recipient)` delivered native PAS to a
fresh recipient address. The commitment scheme, the LeanIMT with the PoseidonT3
precompile, and the v7 8-signal proof layout all behaved exactly as documented.

---

## Issue 1 — `treeSize()` is one greater than the number of leaf-insert events (blocks tree reconstruction)

To build a withdrawal proof, an integrator must reconstruct the Merkle tree
client-side (to obtain the Merkle path for their leaf). We reconstruct it from
events, but the leaf count never matches `treeSize()`.

A complete scan of **all** logs emitted by the pool (no topic filter, small
block chunks) at the time of testing returned:

| Event | Count |
|---|---|
| `Deposit(address,bytes32)` | 181 |
| `NewCommitment(bytes32)` | 48 |
| `Withdrawal(address,uint256,address,uint256)` | 48 |
| **Total leaf-inserting events** (`Deposit` + `NewCommitment`) | **229** |
| `treeSize()` on-chain | **230** |

So **one leaf was inserted without emitting any event.** Our hypothesis is a
**genesis / initialization leaf at index 0**, inserted at construction — the
published `FixedIlopPhase2Paseo_v7` source constructor only sets the verifier and
does not `insert()`, so the deployed bytecode appears to differ from the repo
source, or there is an initialization step we can't see.

**Why this blocks integration:** a missing leaf at index 0 shifts every
subsequent leaf's index by one, so the reconstructed root never matches
`currentRoot()` and no general withdrawal proof verifies. We could only complete
a withdrawal by using a shortcut valid *only for the most-recently-inserted
leaf* (its path siblings equal the persistent on-chain `sideNodes` at its index's
set bits — no full reconstruction needed). That works for a
deposit-then-immediately-withdraw flow but not for the general case (deposit now,
withdraw later, after other users have inserted leaves).

### Could you confirm / fix?

Ranked by ease for integrators:

1. **Publish the genesis leaf value** (and confirm it's at index 0). With it, we
   prepend it to the event-derived leaves and reconstruction is exact.
   *Note:* if it helps, the genesis value equals `currentRoot()` read at the
   block immediately after deployment (a 1-leaf tree's root is that leaf) — so it
   can be recovered from any archive node, but it isn't documented.
2. **Emit an event for the genesis insert** (e.g., a `Deposit`/`NewCommitment`/
   `Genesis` log at construction) in the next deployment, so
   `count(Deposit ∪ NewCommitment) == treeSize()` always holds and event-based
   reconstruction is self-checking. More broadly: *emit a commitment event on
   every `insert()`, with no exceptions* — that single invariant makes
   third-party integration robust.
3. **Add a view** such as `genesisLeaf()` or `leaf(uint256 index)` so integrators
   can read what events don't reveal.

---

## Issue 2 — the Paseo docs address doesn't match the working deployment

`kusamashield.codeberg.page/networks/PaseoAH.html` lists the Paseo pool as
`0x73082Ac2833afD07D035c512031E6Af72B1bDEBD`. A `depositNative` to that address
**reverts** for us, whereas `0x7d5a496bD61b631025A828d9049f6A68e007e0dC` (from
`contracts/paseo_assethub/deployed_v7_fresh.json`) works and matches the
published `withdraw_phase2_fixed_v7` proving/verifying keys. Integrators need the
address whose Verifier matches the shipped `.zkey`.

**Fix:** point the Paseo docs at the deployment that matches the published
circuit artifacts (or clarify which is canonical and publish the matching
artifacts for it).

---

## Issue 3 — reconstruction procedure is undocumented (minor, but a time sink)

Two non-obvious details cost us debugging cycles; documenting them would help the
next integrator:

- The tree is fed by **both** `Deposit` **and** `NewCommitment` (withdrawal change
  notes) events. A client scanning only `Deposit` misses ~20% of leaves. They
  must be merged and inserted in `(blockNumber, logIndex)` order.
- Your published client (`ts_tests/src/pas.ts`) is a hardcoded test rather than a
  reusable indexer/SDK, so integrators reverse-engineer the reconstruction. A
  short "How to reconstruct the tree and build a withdrawal proof" doc — or a
  small SDK function — would remove this friction. (For reference, the LeanIMT
  root computation must use big-integer bit tests across all 128 levels; a 32-bit
  shift silently produces a wrong-but-plausible root.)

---

## Issue 4 — the 16-entry known-roots window limits relayed / delayed withdrawal under load

This is the one that matters most for our use case (fund a fresh wallet via a
relayer, with time between deposit and withdrawal for privacy). Solving Issue 1
lets us reconstruct the tree and withdraw *any* leaf at *any* later time — the
dwell time between deposit and withdraw is unbounded, which is what we want. But
withdrawal also requires the proof's root to still be within the last 16:

```solidity
uint32 public constant ROOT_HISTORY_SIZE = 16;   // circular buffer
require(isKnownRoot(root), "Unknown root");        // in withdraw / proxy_withdraw
```

Because appending a leaf changes existing leaves' authentication paths, a
delayed withdrawal must prove against a *recent* root — and that root must still
be in the window **when the tx is mined**. If **more than 16 inserts land between
proof generation and mining** (easy on a busy network, and our funding path adds
relayer latency), the root is evicted and the withdrawal reverts. 16 is small;
Tornado Cash uses 30, and higher-throughput mixers keep hundreds.

**Recommendation:** increase `ROOT_HISTORY_SIZE` substantially (e.g. 256–1024) in
a future deployment, or otherwise retain more historical roots. This widens the
gen→mine submission window from ~16 inserts to hundreds, so a relayer-submitted,
time-decorrelated withdrawal reliably lands under load. Client-side we can reduce
the race (relayer submits with minimal latency; retry on `"Unknown root"`), but
we can't close it if inserts outpace our rebuild-and-submit cycle.

## Questions for the team

1. Is there a genesis leaf at index 0? If so, can you publish its value and/or
   emit an event for it in future deployments?
2. Which Paseo address is canonical, and can the docs be corrected to match the
   shipped circuit artifacts?
3. Is a reconstruction indexer / SDK planned, or would you accept a docs PR
   describing the `Deposit`+`NewCommitment` reconstruction?
4. Would you consider a larger `ROOT_HISTORY_SIZE` to support relayed/delayed
   withdrawals under network load (Issue 4)?

## How to reproduce

Our end-to-end probe (deposit 0.5 PAS → prove → `proxy_withdraw` to a fresh
address) is a single Node script using `ethers`, `snarkjs`, and `poseidon-lite`
against pool `0x7d5a49…` and your published v7 `.wasm`/`.zkey`. Happy to share it
or open an issue on `codeberg.org/KusamaShield/Solidity_helpers` if useful.
