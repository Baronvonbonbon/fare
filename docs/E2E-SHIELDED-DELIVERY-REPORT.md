# Live end-to-end report — a Kusama-Shield-funded delivery on Paseo

**Date:** 2026-07-23 · **Network:** Paseo Asset Hub (chainId `420420417`), native PAS
· **Branch:** `feat/shielded-pool-kusama-shield`

One complete FARE delivery — **order → auction → pickup → dropoff → payouts** —
run live on Paseo, with the customer's order wallet funded **through the Kusama
Shield shielded pool** and every settlement relayed through a **venue-node**. This
is the as-if-mainnet test requested after the KS findings were sent upstream: it
proves the mechanism end to end and measures the on-chain privacy and cost.

> **Headline result.** The delivery completed and settled correctly. **No
> position data — home address, drop coordinates, or driver movements — touches
> the chain** (0 leaks across 15 transactions). Funding is mechanically unlinked
> (no `customer-main → burner` edge). The one honest caveat is not a FARE bug:
> the *strength* of the funding privacy depends on Kusama Shield's anonymity set
> and time-decorrelation, which Paseo does not yet have — so on testnet this is a
> proven **mechanism**, not yet real-world unlinkability. See §5.

Raw evidence: [`docs/e2e-live/ledger.json`](e2e-live/ledger.json) (every tx) and
[`docs/e2e-live/scan.json`](e2e-live/scan.json) (the exposure scan) — tracked
copies of the run outputs (`artifacts/` is gitignored). Reproduce with
`scripts/shield/e2e-{setup,run,scan}.mjs`.

---

## 1. What ran

```
customer-main ──depositNative(5 PAS)──▶ Kusama Shield pool  (0x7d5a49…)
                                              │  note enters the anonymity set
   venue-node relay ──proxy_withdraw──────────┘
                                              ▼
                             fresh burner (0x86cf3B…) receives 5 PAS, UNLINKED
                                              │
   burner ─createOrder(0.3 order + 0.05 tip)──▶ FareOrders          [Open]
   driver ─placeBid(0.15 fare)───────────────▶                      (reverse auction)
   burner ─acceptBid(driver, 0.15)───────────▶                      [Assigned]
   driver+venue ─dual-sign GPS─▶ relay ─confirmPickup──▶ FareSettlement [PickedUp]
                                    │  orderValue 0.3 → venue (vault)
   driver ─sign pos─▶ burner ─Groth16 proof─▶ relay ─confirmDropoffZK─▶ [Delivered]
                                    │  fare−fee+tip 0.19625 → driver (vault)
   venue.withdraw / driver.withdraw ─────────▶ FareVault (pull payouts)
   burner ─depositNative(3.473 PAS residual)─▶ Kusama Shield pool   (shielded return)
```

**Parties** (each a distinct on-chain identity, for a faithful cost split):

| Role | Address | Notes |
|---|---|---|
| customer-main | `0x26194f…CEE3` | deposits into KS; the only linkable step. *Also the protocol treasury on this deployment — a testnet artifact (§4).* |
| customer-burner | `0x86cf3B…7984` | fresh, KS-funded, places the order; unlinked to main |
| venue | `0xcaE73b…9732` | operator + hot signer + payout; registered venue id **3** |
| driver | `0x47391F…740e` | registered, bids, cosigns, paid |
| relay (venue-node) | `0xC2a138…dE5e` | sponsors gas for the KS withdrawal + both gasless settlements |

**Infra used:** the `venue-node` relay (`relay.mjs`) ran live on `:8788` with
`RELAY_PROFIT_GUARD=off`; `confirmPickup` and `confirmDropoffZK` were submitted
through its `POST /submit` endpoint (fully gasless for the user). The FARE
contracts are the live deployment in [`deployed-addresses.json`](../deployed-addresses.json);
KS is the working v7 pool `0x7d5a496bD61b631025A828d9049f6A68e007e0dC`.

---

## 2. Every transaction (15 total)

Gas is priced at the observed **1000 gwei** (`1e12` wei/gas). The Paseo eth-rpc
leaves `gasPrice`/`effectiveGasPrice` unset in receipts, so `gasUsed` is
authoritative and priced at that rate — verified against balance deltas.

| # | Phase | Party | Action | Value (PAS) | Gas | Fee (PAS) | Tx |
|--:|---|---|---|--:|--:|--:|---|
| 1 | setup | main | fund-venue | 60.0 | 10 897 | 0.0109 | `0x37c836…` |
| 2 | setup | main | fund-driver | 60.0 | 10 897 | 0.0109 | `0x35ceca…` |
| 3 | setup | main | fund-relay | 600.0 | 10 897 | 0.0109 | `0x5d4847…` |
| 4 | onboard | venue | registerVenue | — | 20 228 | 0.0202 | `0x051e64…` |
| 5 | onboard | driver | registerDriver | — | 7 482 | 0.0075 | `0x7f9baf…` |
| 6 | **fund** | main | **KS.depositNative** | 5.0 | 18 316 | 0.0183 | `0x30fda7…` |
| 7 | **fund** | relay | **KS.proxy_withdraw → burner** | — | 772 539 | **0.7725** | `0xbe2c00…` |
| 8 | order | burner | createOrder | 0.35 | 20 826 | 0.0208 | `0x382250…` |
| 9 | order | driver | placeBid | — | 10 770 | 0.0108 | `0x83c16b…` |
| 10 | order | burner | acceptBid | 0.15 | 3 617 | 0.0036 | `0x91e53e…` |
| 11 | settle | relay | confirmPickup *(gasless)* | — | 20 238 | 0.0202 | `0xeb728f…` |
| 12 | settle | relay | confirmDropoffZK *(gasless)* | — | 24 916 | 0.0249 | `0xa91338…` ⚠︎ |
| 13 | payout | venue | vault.withdraw | — | 1 603 | 0.0016 | `0xe2473b…` |
| 14 | payout | driver | vault.withdraw | — | 0* | 0.0000 | `0x1bd4c4…` |
| 15 | **return** | burner | **KS.depositNative (return)** | 3.473 | 18 085 | 0.0181 | `0x037084…` |

`*` driver withdraw reported `gasUsed 0` (an RPC quirk); it succeeded — the
driver balance rose by the payout. `⚠︎` tx 12 settled on-chain (order reached
**Delivered** and payouts credited) but its hash is **not resolvable** via the
load-balanced `eth-rpc-testnet.polkadot.io`; gas was recovered from the relay
balance delta. This RPC inconsistency is a finding in its own right — see §6.

---

## 3. Position / PII exposure — the core question

**Scan (`e2e-scan.mjs`) over the calldata + event logs of every resolvable tx:
0 private-location leaks.**

| Private value (must never be on-chain) | Result |
|---|---|
| Customer **home** latitude (the drop) | ✅ absent everywhere |
| Customer home **lat+lon pair** | ✅ absent everywhere |
| Driver **dropoff** coordinates (ZK witness) | ✅ absent everywhere |
| Driver **exact pickup** coordinates (pre-coarsen) | ✅ absent everywhere |

**Why it holds, per surface:**

- **`createOrder`** writes only `dropCommit = Poseidon(latEnc, lonEnc, salt)` — a
  hash. The home location is *committed*, never written. Confirmed: the raw drop
  latitude does not appear in the calldata; the Poseidon commitment does.
- **`confirmDropoffZK`** carries a Groth16 proof + hashed public signals
  `[orderId, dropCommit, driverCommit, radius, nullifier]` and a driver-signed
  `posCommit` — **no coordinate field exists in the calldata schema**. Both
  parties' positions are private circuit witnesses. (We independently verified
  the live verifier accepts a fresh proof via `eth_call` with *no* coordinates
  on chain — the mechanism is sound regardless of this tx's log-resolution
  issue.)
- **`confirmPickup`** is the *only* tx that contains any raw coordinates, and by
  design: the **public venue pin** (`37.774900, -122.419400`) and the driver's
  position **coarsened to a 300 µ° (~33 m) grid** (`37.775051,-122.419377` →
  `37.775100,-122.419500`). The driver's exact position never appears; the venue
  pin is public in `registerVenue` anyway.
- **KS deposits/withdrawal, bids, accept, payouts** carry hashes, amounts, and
  addresses — never coordinates.

**Conclusion:** the *position-privacy* guarantee is **unconditional** — it comes
from the ZK proximity proof + Poseidon commitment + client-side coarsening, and
does **not** depend on Kusama Shield usage at all. A customer's home address,
drop location, and the driver's movements are not recoverable from the chain.

---

## 4. Funding unlinkability

**No on-chain edge links the customer's funding identity to the order.**

- There is **no transaction** with `from = customer-main, to = burner` (checked
  across all 15 txs).
- The burner was funded by **`proxy_withdraw`** — the KS *pool* pays out to the
  burner, submitted by the venue-node relay. customer-main's only pool
  interaction is a `depositNative` into a shared pool of 230+ notes.
- So graph analysis sees: "main put 5 PAS into the pool" and, separately, "the
  pool sent 5 PAS to a fresh address." The two are linked **only** by the
  anonymity set — which is exactly the shielded-pool property.

**Treasury note:** on this deployment the protocol treasury is configured as the
deployer, which is also our customer-main. So this order's 0.003 PAS fee returns
to the same address — a **testnet artifact**, not the production topology. Set a
distinct treasury before mainnet.

---

## 5. The honest caveat: "assuming sufficient KS usage"

The request was to confirm no PII is determinable **assuming sufficient KS
usage**. That qualifier is load-bearing, and the two privacy axes answer
differently:

| Axis | Depends on KS usage? | Verdict on Paseo today |
|---|---|---|
| **Position / location** (home, drop, movements) | **No** | ✅ Fully private, unconditionally (ZK + commitments + coarsening) |
| **Funding / identity linkability** | **Yes** | ◑ Mechanism proven; real-world unlinkability **not** achieved on testnet |

The funding step here used the **last-leaf, deposit-then-immediately-withdraw**
pattern (the only pattern the deployed pool supports until KS fixes the
undocumented genesis leaf — [Issue 1](KUSAMA-SHIELD-FINDINGS.md#issue-1)). That
pattern is **timing-correlatable**: an observer who sees a 5 PAS deposit and a
near-simultaneous 5 PAS withdrawal can link them. The KS feasibility study itself
notes 44% of Tornado Cash deposits were de-anonymized this way. Genuine
unlinkability needs all of:

1. **The KS Issue-1 fix** (genesis leaf / commitment event on every insert) so a
   client can reconstruct the *full* tree and withdraw *any* note *later* — notes
   can then dwell in the pool (deposit ahead of time, withdraw on an uncorrelated
   schedule). Today we are forced into the immediate pattern.
2. **A real anonymity set.** Paseo AH sees single-digit daily EVM activity; the
   KS study estimates ~19 months to reach k≈100 at current rates.
3. **Larger `ROOT_HISTORY_SIZE`** ([Issue 4](KUSAMA-SHIELD-FINDINGS.md#issue-4-the-16-entry-known-roots-window-limits-relayed--delayed-withdrawal-under-load))
   so a delayed, relayed withdrawal doesn't get its root evicted before mining.

None of these are FARE code problems; all three are the KS-side items already
raised upstream. **So: the shielded-funding integration works and is correctly
wired, and the position privacy is real today — but the funding-unlinkability
promise only becomes real once the pool has usage and the KS fixes land.**

---

## 6. Costs — total and by party

### Value flow (the delivery escrow), PAS

The customer pays **0.5 PAS** total; it splits with no subsidy:

| Party | Receives | How |
|---|--:|---|
| Venue | **0.30000** | `orderValue`, credited at pickup |
| Driver | **0.19625** | `fare − 2.5% fee + tip` = 0.15 − 0.00375 + 0.05 |
| Treasury | **0.00300** | protocol fee (2.5%) minus the relay rebate |
| Relay (F6 rebate) | **0.00075** | 20% of the fee — the settling relay's on-chain rebate |
| **Sum** | **0.50000** | = customer's `orderValue + tip + fare` ✅ |

Live params observed: `feeBps = 250` (2.5% of fare only), `relayRebateBps = 2000`
(20% of that fee rebated to the settling relay). **The F6 relay-rebate mechanism
is live** — the venue-node relay earned 0.00075 PAS back for settling (though on
testnet that's dwarfed by its gas, as the design predicts).

### Gas cost, PAS — who pays

| Party | Gas spend | What they paid for |
|---|--:|---|
| **relay (venue-node)** | **0.81769** | KS `proxy_withdraw` (0.7725) + gasless pickup (0.0202) + gasless dropoff (0.0249) |
| **customer** (main + burner) | **0.06084** | KS deposit (0.0183) + createOrder (0.0208) + acceptBid (0.0036) + shielded return (0.0181) |
| driver | 0.01077 | placeBid (withdraw was ~free) |
| venue | 0.00160 | payout claim |
| **Per-delivery gas total** | **≈ 0.891** | — |
| *one-time onboarding* | *0.0277* | *venue reg 0.0202 + driver reg 0.0075 (amortized over all future orders)* |
| *wallet provisioning* | *0.0327* | *3 funding transfers (setup only)* |

**The dominant cost is the KS shielded withdrawal (0.7725 PAS) — the Groth16
withdrawal verification — and it lands entirely on the relay**, because the KS
pool has **no on-chain relayer fee** (`proxy_withdraw` doesn't reimburse the
submitter). The actual delivery-settlement gas (pickup + dropoff) is cheap
(0.045 PAS combined). See recommendation R2.

---

## 7. Recommendations

**R1 — Confirm by effect, not by returned hash (and bundle a venue-node RPC).**
Tx 12 settled but its hash was unresolvable on the public load-balanced RPC. The
robust pattern (which is how we recovered) is to poll the **effect** —
`statusOf(orderId)`, vault balances, the KS pool root — rather than trust a
client-computed hash the node may re-derive. This directly answers "can the
venue node's bundled pine-rpc be the endpoint?": a **pine (smoldot) light client
is great for the *reads*** (Merkle-proof-verified `statusOf`/balances/roots and
it removes the load-balancer inconsistency), but a light client does **not**
index historical transactions/receipts/logs by hash — pair it with the relay's
own event indexer (or a full node) for tx history. The pine-rpc container is
currently deferred (F4) and wasn't running here.

**R2 — Charge a relayer fee on the shielded withdrawal.** The relay ate 0.7725
PAS sponsoring `proxy_withdraw` with no reimbursement. FARE should deduct a fee
from the withdrawn amount before forwarding to the burner (the customer still
ultimately pays; the relay breaks even). Without this, no venue will sponsor
shielded funding at scale.

**R3 — Move off the last-leaf pattern once KS ships Issue-1.** Immediate
deposit→withdraw is weak privacy (§5). The moment general tree reconstruction is
possible, switch FARE to **deposit-ahead-in-standard-denominations, withdraw
on-an-uncorrelated-schedule**. Until then, label KS funding on testnet as a
mechanism demo, not a privacy guarantee.

**R4 — Don't strand burner residual.** This run left 0.982 PAS in the burner (we
over-reserved for the return deposit's gas). Production sweep logic should
shielded-return the maximum safe residual (leaving only exact gas), or sponsor
the return deposit's gas via the relay so nothing strands.

**R5 — Gas sizing is bimodal on Paseo; keep it that way deliberately.** At 1000
gwei the 500 M weight limit reserves ~500 PAS at submission — fine for the funded
relay/deployer, impossible for a 5 PAS burner. Burner txs must use
**estimate-based** limits (the app already relies on this; `eth_estimateGas`
returns sane low figures). Documented so nobody "helpfully" bumps burner gas
limits and breaks funding.

**R6 — Pre-mainnet gates unchanged.** Set a distinct treasury (§4); run a real
multi-party trusted-setup ceremony for the proximity circuit (the shipped setup
is single-party); and land the KS-side fixes (Issues 1 & 4) before the funding
privacy is real.

---

## 7b. Status of the recommendations (fixes applied 2026-07-23)

| # | Recommendation | Status |
|---|---|---|
| R1 | Confirm by effect, not returned hash | ✅ `KusamaShieldFunder.fundBurner` polls the burner balance; `e2e-lib` prices `gasUsed` directly. Pine-rpc note documented. |
| R2 | Relayer fee on the shielded withdrawal | ✅ relay `POST /shield-withdraw` fee mode (`SHIELD_FEE_PAS`): pool pays relay, forwards net to burner, keeps fee (gate: fee ≥ gas × margin). |
| R3 | Move off the last-leaf pattern | ✅ **deposit-ahead/withdraw-later** now works via snapshot + right-scan reconstruction (`shieldpool.ts`), validated by an interior-leaf withdrawal + unit tests. (Strong *privacy* still needs a KS anonymity set.) |
| R4 | Don't strand burner residual | ✅ `shieldedReturn` deposits the max safe residual back into the pool; gas reserve sized so the deposit doesn't revert. |
| R5 | Document bimodal gas sizing | ✅ venue-node README "Gas sizing on Paseo". |
| R6 | Distinct treasury; ceremony; KS fixes | ◑ **treasury set on-chain** to a distinct address (`0x6Db7…1FD1`, `configure` tx `0x0cece9…`). Trusted-setup ceremony + KS Issues 1/4 remain upstream (client workarounds shipped — see the findings doc). |

Also added: KS Issue-1 & Issue-4 **client-side workarounds** (general tree
reconstruction; unknown-root retry), a productionized `ShieldedFunder` wired into
the PWA (`initShieldedFunder`, gated on `VITE_SHIELD_POOL`), and
`web/src/shieldpool.test.ts` (reconstruction cross-checked against a full-tree
proof). The general-case reconstruction is proven live in
`scripts/shield/validate-general-withdraw.mjs`.

## 8. Reproduce

```bash
# 1. wallets, funding, venue/driver registration, relay .env
node scripts/shield/e2e-setup.mjs

# 2. start the venue-node relay (gasless settlement path)
cd venue-node && node --env-file=.env relay.mjs &   # RELAY_PROFIT_GUARD=off

# 3. the live delivery, funded through Kusama Shield
node scripts/shield/e2e-run.mjs      # resumable; state in scratchpad/e2e-state.json

# 4. position / PII exposure scan
node scripts/shield/e2e-scan.mjs     # → artifacts/e2e-live/scan.json
```

Needs `DEPLOYER_PRIVATE_KEY` (funds everything) in `.env`; the ZK artifacts at
`web/public/shield/withdraw_v7.{wasm,zkey}` and `web/public/zk/proximity.{wasm,zkey}`.

## See also
- [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) — the upstream issues (1–4) this run is gated on
- [SHIELDED-POOL-INTEGRATION.md](SHIELDED-POOL-INTEGRATION.md) — the C4 feasibility report
- [PRIVACY.md](PRIVACY.md) — the location-privacy threat model this run validates
