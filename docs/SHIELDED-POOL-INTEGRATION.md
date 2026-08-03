# Kusama Shield integration — feasibility report (C4)

**Verdict: the shielded-pool approach works on Paseo, end to end, today.** We
deposited native PAS into the live Kusama Shield pool from FARE's stack,
generated a zero-knowledge withdrawal proof, and funded a **fresh, unlinked
address** via a relayer — no FARE contract changes required. The remaining
blockers are not cryptographic; they are (a) a general-case tree-reconstruction
gap in the deployed pool and (b) the anonymity-set cold-start that every mixer
faces. Details below.

This complements [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) (the C4 design) with
concrete, verified findings against a real deployment.

---

## 1. What we integrated against

**Kusama Shield** — a permissionless multi-asset shielded pool (Tornado / Privacy
Pools lineage) that runs on `pallet_revive` / PolkaVM. It uses a Poseidon
commitment scheme, an audited LeanIMT (Lean Incremental Merkle Tree), and a
Groth16 circuit, with a **predeployed PoseidonT3 precompile** at
`0x1d165f6fE5A30422E0E2140e91C8A9B800380637` (a PVM-native Poseidon — the thing
that makes Merkle operations affordable on Asset Hub, which is impossible in pure
Solidity).

### Live Paseo Asset Hub deployment (the one we used)

| Contract | Address | Notes |
|---|---|---|
| Pool `FixedIlopPhase2Paseo_v7` | `0x7d5a496bD61b631025A828d9049f6A68e007e0dC` | **superseded 2026-08-01** — see the migration note below |
| Pool (canonical v7) | `0x3068490C79708D0725E3D4Aa9C35Da708f09071e` | what FARE points at now |
| Verifier (Groth16) | `0x354f7353F6770b015376c386A3bF4760A7773E16` | 8 public signals |
| PoseidonT3 precompile | `0x1d165f6fE5A30422E0E2140e91C8A9B800380637` | `hash(uint256[2])`, selector `0x561558fe` |

> **Address caveat.** The Kusama Shield docs page for Paseo lists
> `0x73082Ac2833afD07D035c512031E6Af72B1bDEBD`, but a deposit there **reverts** —
> it's a different/incompatible build. The repo's `deployed_v7_fresh.json` address
> `0x7d5a49…` is the one that matches the **published circuit artifacts**
> (`withdraw_phase2_fixed_v7.{wasm,zkey}`) and accepts our deposits. Always
> integrate against the deployment whose verifier matches your proving key.

---

## 2. How FARE funds a burner through it (architecture)

The private-funding flow, mapped onto FARE's per-order burner model:

```
customer main wallet ──depositNative{value}(commitment)──▶ Kusama Shield pool
                                                                   │  (note sits in the anonymity set)
                                                                   ▼
   client builds a Groth16 withdrawal proof (recipient = fresh burner)
                                                                   │
   venue relay ──proxy_withdraw(proof, pubSignals, burner)────────▶ pool
                                                                   │  relay pays gas
                                                                   ▼
                                        fresh burner receives native PAS
                                        (gas + escrow), UNLINKED to main
```

Key properties:

- **No FARE contract change.** The pool is external; the burner simply receives
  native PAS and then creates a normal (native-PAS) order. This is why the C3
  `ShieldedFunder` seam (`web/src/shield.ts`) drops in cleanly.
- **Relayer path (`proxy_withdraw`) is exactly what we need** — the relay (our F8
  venue relay, extended) submits the withdrawal and pays its gas; funds are routed
  to an arbitrary `recipient` through a freshly-deployed `SimpleTokenForwarder`,
  so the burner needs **zero** pre-funding. This resolves the chicken-and-egg
  (a fresh burner has no gas to withdraw for itself).
- **Notes model, not fixed denominations.** `depositNative` takes any `msg.value`;
  a withdrawal specifies `withdrawnValue` and re-inserts a **change note** for the
  remainder. So a single large deposit can fund many burners over time.

---

## 3. Proven, end to end (the probe)

`scripts/shield/probe.mjs` runs the whole recipe against the live pool and
**passed**:

```
1. depositNative(commitment) value=0.5 PAS      ✓ deposited (tree 229 → 230)
2. Merkle proof from on-chain sideNodes         ✓ local root == on-chain currentRoot
3. Groth16 withdrawal proof (v7, 8 signals)     ✓ nullifierHash matches
4. proxy_withdraw → fresh 0x1Af1Bb8B…           ✓ recipient 0.0 → 0.5 PAS
✅ fresh address received 0.5 PAS, unlinked to the depositor
```

That is the core feasibility question answered **affirmatively on Paseo**: a
FARE customer can privately fund a throwaway wallet through Kusama Shield.

### The cryptographic recipe (verified against the live chain)

- **Commitment** (`commitment.circom`), all standard circomlib Poseidon over BN254
  — matches `poseidon-lite`:
  - `nullifierHash = Poseidon(nullifier)`
  - `commitment    = Poseidon( Poseidon(value, asset), Poseidon(nullifier, secret) )`  (asset = 0 for native)
- **Merkle tree**: 128-level LeanIMT; parent = `PoseidonT3(left, right)`; root =
  the last inserted node; a 16-entry known-roots window (`isKnownRoot`) lets a
  proof use any of the last 16 roots.
- **Withdraw circuit** (`withdraw_phase2_fixed_v7`): public inputs
  `[withdrawnValue, treeDepth, context, root, asset]`, outputs
  `[newCommitmentHash, nullifierHash, contextHash]`. snarkjs emits public signals
  as **outputs-then-inputs**, giving the contract's exact 8-signal layout:
  `[newCommitmentHash, nullifierHash, contextHash, withdrawnValue, treeDepth, context, root, asset]`.
- **Artifacts** vendored at `web/public/shield/`: `withdraw_v7.wasm` (2.3 MB) and
  the 34 MB proving key, split into `withdraw_v7.zkey.part{0,1,2}` + a
  `withdraw_v7.zkey.json` manifest because Cloudflare Pages rejects any single
  asset over 25 MiB. Browser and node both reassemble the parts in memory and
  pass snarkjs a `Uint8Array` — see `scripts/shield/{split-zkey,zkey}.mjs`.
  Proofs via snarkjs (already a FARE dependency, from the ZK dropoff proof).

---

## 4. Gotchas discovered (each cost a debugging cycle)

1. **Undocumented genesis leaf.** The deployed pool's `treeSize` (230) is one
   greater than the number of `Deposit`+`NewCommitment` events (229). The
   contract seeds a leaf at index 0 at construction that emits **no event** — the
   published source's constructor doesn't show this, so the deployed bytecode
   differs from the repo source. This means a naive event-based tree rebuild is
   off by one and every leaf index shifts. **This is the main integration hazard.**
2. **The tree is fed by two event types.** Withdrawals re-insert a change note via
   `insert()` and emit `NewCommitment(hash)`, *not* `Deposit`. A client that scans
   only `Deposit` events misses ~20% of the leaves (we saw 181 vs 229). You must
   merge `Deposit` **and** `NewCommitment`, ordered by `(block, logIndex)`.
3. **JavaScript `>>` is 32-bit and wraps the shift.** Iterating 128 tree levels,
   `idx >> 40` returns `idx >> 8`, fabricating "set" bits at high levels and
   corrupting the root. Bit tests over a 128-level tree **must** use `BigInt`.
   This one silently produces a plausible-but-wrong root.
4. **RPC archive quality varies wildly.** The KS team's RPC
   (`paseo-assethub-rpc.laissez-faire.trade`) returned only 2 of 230 leaves;
   `eth-rpc-testnet.polkadot.io` returned 229/230 (the genesis being the only gap).
   `eth_getLogs` completeness is not guaranteed — scan defensively (subdivide on
   error) and **assert leaf count == `treeSize`**.
5. **`proxy_withdraw` has no on-chain relayer fee.** The relay pays gas and is not
   reimbursed by the contract. For FARE the venue relay would sponsor it (or take
   a fee off-chain / out of the withdrawn amount before forwarding).

---

## 5. The one real limitation: general-case tree reconstruction

The probe sidesteps the genesis problem with a shortcut that only works for the
**rightmost (most recent) leaf**: for the last leaf, the Merkle path siblings are
exactly the pool's persistent on-chain `sideNodes` at the set bits of its index —
readable directly, no event replay, no genesis value needed. We verified this
reproduces `currentRoot` exactly.

That shortcut is enough for a **deposit-then-immediately-withdraw** pattern (fund
each burner right after depositing its note). But a general client — one that
deposits once and withdraws later, after other users have inserted leaves — needs
to reconstruct the **full** tree, which requires the **genesis leaf value** (not
published) plus a complete, correctly-ordered `Deposit`+`NewCommitment` index.

**Options to close this for production:**
- Obtain the genesis value from the Kusama Shield team (or a corrected source /
  official indexer/SDK — their published `ts_tests/pas.ts` is a hardcoded test,
  not a reusable indexer).
- Restrict FARE to the last-leaf pattern (deposit-and-immediately-withdraw per
  order), accepting the race that another user's insert between our deposit and
  withdraw forces a retry — and the **privacy cost** below.

---

## 6. Privacy analysis (the actual mainnet blocker)

Even with flawless integration, immediate deposit→withdraw is **weak privacy**:
an observer correlates the deposit and the near-simultaneous withdrawal by timing.
The Kusama Shield feasibility study cites that **44% of Tornado Cash deposits were
de-anonymized** via timing/address-reuse. Real privacy requires:

- a **large anonymity set** — Kusama/Paseo Asset Hub currently sees single-digit
  daily EVM activity; the study estimates ~19 months to reach k≈100 at current
  deposit rates, and
- **time-decorrelation** — notes must dwell in the pool and withdrawals must not
  track deposits.

So the shielded pool is a genuine *unlinkability primitive*, but its privacy is
only as strong as the pool's usage. For a mainnet FARE this argues for depositing
ahead of time in standard sizes and withdrawing on an uncorrelated schedule — not
per-order just-in-time.

---

## 7. Recommendation

- **Feasibility: proven.** The mechanism works on Paseo with FARE's existing ZK
  stack and no contract changes. This retires the "blocked on external infra"
  status from the C4 design — the infra now exists.
- **For the branch feasibility build** (`feat/shielded-pool-kusama-shield`):
  implement the `ShieldedFunder` against this pool using the last-leaf pattern,
  extend the venue relay with a `/shield-withdraw` endpoint (submits
  `proxy_withdraw`), and strip the PAS drip + MockUSDC so the pool is the sole
  funding path — a faithful "as-if-mainnet" test of the flow.
- **Before mainnet**, resolve two things that are out of FARE's hands: the
  general-case reconstruction (genesis value / official indexer) and, more
  fundamentally, the anonymity-set cold-start. Neither is a code problem in FARE.

---

## 8. Reproduce

```bash
# live end-to-end probe (deposits 0.5 PAS, withdraws to a fresh address)
SHIELD_POOL=0x7d5a496bD61b631025A828d9049f6A68e007e0dC \
  node scripts/shield/probe.mjs        # needs DEPLOYER_PRIVATE_KEY in .env

# enumerate pool events / leaf accounting
node scripts/shield/diag.mjs
```

Artifacts: `web/public/shield/withdraw_v7.{wasm,zkey.part*}`. Deps: `ethers`,
`snarkjs`, `poseidon-lite`.

## See also
- [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) — the C4 design + `ShieldedFunder` seam
- [PRODUCT-INTEGRATION-PLAN.md](PRODUCT-INTEGRATION-PLAN.md) — C4 in the backlog
- Kusama Shield: `codeberg.org/KusamaShield` · `kusamashield.codeberg.page`


---

## Migration to the canonical v7 pool (2026-08-01) — ⛔ REVERSED 2026-08-03

> **This migration was wrong and has been undone.** The canonical pool
> `0x3068490C…` cannot be withdrawn from: `isKnownRoot` panics for every
> non-zero root once the tree passes 16 leaves, so every `withdraw` and
> `proxy_withdraw` reverts *after* the proof verifies. It cost a driver's 1 PAS
> shielded payout before we caught it. FARE is back on `0x7d5a496b…`. Full
> analysis: [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) Issue 7.
>
> **The verification below is left verbatim as the record of what went wrong.**
> Every claim in it is true and none of it was sufficient: hash equality and
> selector presence are facts about *artifacts*, and "money can leave" is a
> *behaviour*. The migration's entire risk was the behaviour, and nothing in
> this list executed it. One free `staticCall` would have caught it.

The [Kusama Shield release](https://forum.polkadot.network/t/kusama-shield-new-release/18301)
standardised Paseo on `0x3068490C79708D0725E3D4Aa9C35Da708f09071e`. The pool FARE had been
using, `0x7d5a496b…`, **appears nowhere in the new SDK** — Issue 2 in
[KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) (docs address ≠ working deployment)
resolved in favour of the other address, leaving ours orphaned.

**The swap is drop-in.** Verified before changing anything:

- **The circuit is byte-identical.** The SDK ships `withdraw_phase2_fixed_v7.wasm` and
  `withdraw_phase2_fixed_v7_0001.zkey`; both hash the same as the artifacts already in
  `web/public/shield/` (`ba4cd3ec…caae2a` and `30e82f85…3f71e8`). No re-proving, no new
  trusted setup, no change to the 8-signal layout.
- **The interface is identical.** Both deployments expose exactly the selectors FARE calls —
  `depositNative(bytes32)`, `proxy_withdraw(uint256[2],uint256[2][2],uint256[2],uint256[8],address)`,
  and `treeSize()`.
- **`proxyWithdrawV7()` in the SDK is a thin wrapper over `proxy_withdraw`** — the
  sender-unlinkability work (a forwarder deployed per withdrawal) lives inside the contract, so
  FARE already takes that path by calling `proxy_withdraw`. No client change was needed for it.
- **The same PoseidonT3 precompile** (`0x1d165f6f…`) backs both.

**What it cost.** The anonymity set drops from 331 leaves to 94. Both numbers are far too small
to provide real privacy on a testnet, and both this document and Parity's own feasibility study
conclude the anonymity set — not the cryptography — is the hard problem. Being on the deployment
upstream actually supports matters more before mainnet.

**On-chain component.** `FareVault` holds the pool address in storage, so this was not purely a
client change:

```
FareVault.setShieldPool(0x3068490C…)
tx 0xff96b84c5a6f34c3d0e0afac9ced474cff532ebf952f104ad9122b1bc3bfdc35
```

Safe to flip because `nextNoteIndex` was `1` — no shielded notes had been inserted into the
vault's tree, so nothing was mid-flight. **Any future migration must re-check that**: switching
the pointer with notes outstanding would send them somewhere their commitments do not exist.
Notes already deposited in the old KS pool remain withdrawable directly from it; the vault
pointer only governs where new ones go.

**Still not fixed upstream:** the 16-entry known-roots window (Issue 4). The relay's
retry-on-`"Unknown root"` workaround stays.


## The forwarder hop costs 96% of a withdrawal and hides nothing (2026-08-03)

Measured on the working pool, same note size, same fresh recipient, both
succeeding and delivering 0.5 PAS:

| call | gas | fee @ 1000 gwei | tx |
|---|---|---|---|
| `withdraw` | **31,141** | **0.031 PAS** | `0x791a4473…` |
| `proxy_withdraw` | **773,079** | **0.773 PAS** | `0x05b612dd…` |
| difference | 741,938 | 0.742 PAS | **24.8×** |

The forwarder is **96% of the cost of a shielded withdrawal**. It is 24× the
entire rest of the operation — proof verification, nullifier write, escrow
update, transfer and change insert combined — because `new SimpleTokenForwarder`
is a contract deployment, and deploying on PolkaVM is expensive. For scale, a
`depositNative` is 17,900 gas, so the forwarder costs about **41 deposits**.

**And it buys no privacy.** Both functions end with the same line:

```solidity
emit Withdrawal(asset, withdrawnValue, recipient, newCommitmentHash);
```

The pool names the recipient in its own event log on both paths, and the
forwarder emits `NativeForwarded(from, to, amount)` on top of that — so the
recipient is published twice on the expensive path and once on the cheap one.
The only difference the forwarder makes is which address appears as the
immediate sender of the *value transfer*, in the same transaction that logs the
recipient anyway. That defeats an observer who reads balance traces but not
event logs, which is not an observer worth 0.742 PAS.

**What is identical between them**, and is where the real privacy lives:

- Both take `recipient` as a parameter, so **the recipient never signs** and a
  relay can submit either. Sender unlinkability is a property of the *relayed
  submission*, not of the forwarder.
- Both spend a nullifier against a ZK proof, so which deposit funded the
  withdrawal is hidden by the anonymity set in both.
- Neither reveals the funder. The customer→burner edge that per-order burners
  exist to break is broken identically by both.

**Recommendation: switch `web/src/shieldpool.ts` and the relay's
`/shield-withdraw` to `withdraw`.** The call takes byte-identical arguments —
`withdraw(uint[2],uint[2][2],uint[2],uint[8],address)` — so it is a one-word
change with no proof, circuit or client-model impact. It takes the single most
expensive action in FARE (0.773 PAS, 40× a ZK dropoff) down to 0.031 PAS,
roughly the cost of creating an order.

Not done unilaterally: it is a live privacy-surface change and belongs to whoever
owns that call. The measurement is `scripts/shield/pool-withdraw-probe.mjs`
(`MODE=withdraw|proxy`), and it is cheap to re-run.

## PoseidonPolkaVM — already in use, no change needed (2026-08-01)

The release advertises **PoseidonPolkaVM at 17.7× cheaper gas than Solidity**, which looked like a
free win for `FareVault`'s 16-level note tree. It isn't a win, because FARE has been using it since
the shielded-payout work landed. Checked rather than assumed:

| | |
|---|---|
| `deployed-addresses.json` → `poseidon` | `0x1d165f6fE5A30422E0E2140e91C8A9B800380637` |
| Live `FareVault.shieldPoseidon()` | `0x1d165f6fE5A30422E0E2140e91C8A9B800380637` |
| The SDK's `poseidonPrecompile` for Paseo | `0x1d165f6fE5A30422E0E2140e91C8A9B800380637` |

Same address all three. And the Poseidon deployments the SDK references across networks
(`0x1d165f6f…` Paseo, `0x4faE22c0…`, `0x3d92Af83…`) all share one bytecode hash
(`0x75f3e47d…`) — one build, deployed per network.

Measured on Paseo, `hash(uint256[2])` costs **3,406 gas**. That is consistent with the claim:
3,406 × 17.7 ≈ 60,300, which is the range a Solidity Poseidon-T3 lands in. The 17.7× is relative
to a Solidity implementation FARE never used.

Two things follow. **`FareVault` needs no change** — and it could not take one anyway, since
`setShieldPoseidon` is deliberately one-shot (`require(address(shieldPoseidon) == address(0))`,
because a tree initialised against one hasher and used with another would silently produce
unverifiable roots). And the note tree is already on the cheapest hasher available, so a gas
reduction there has to come from the tree structure or the surrounding Solidity, not the hash.

*Recorded so nobody re-investigates this.*
