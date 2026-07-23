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
| Pool `FixedIlopPhase2Paseo_v7` | `0x7d5a496bD61b631025A828d9049f6A68e007e0dC` | native PAS, ~230 leaves, 48 real withdrawals — actively used |
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
- **Artifacts** vendored at `web/public/shield/withdraw_v7.{wasm,zkey}` (2.3 MB +
  34 MB). Proofs via snarkjs (already a FARE dependency, from the ZK dropoff proof).

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

Artifacts: `web/public/shield/withdraw_v7.{wasm,zkey}`. Deps: `ethers`,
`snarkjs`, `poseidon-lite`.

## See also
- [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) — the C4 design + `ShieldedFunder` seam
- [PRODUCT-INTEGRATION-PLAN.md](PRODUCT-INTEGRATION-PLAN.md) — C4 in the backlog
- Kusama Shield: `codeberg.org/KusamaShield` · `kusamashield.codeberg.page`
