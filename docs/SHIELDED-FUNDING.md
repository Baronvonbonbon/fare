# Shielded burner funding (C4)

Status: **IMPLEMENTED against Kusama Shield on Paseo.** The concrete backend
(`web/src/shieldpool.ts` engine + `KusamaShieldFunder` in `web/src/shield.ts`)
funds burners through the live KS pool; the venue relay submits the withdrawal
(`POST /shield-withdraw`). Proven end to end live — see
[E2E-SHIELDED-DELIVERY-REPORT.md](E2E-SHIELDED-DELIVERY-REPORT.md) — and the
general-case reconstruction is validated in `web/src/shieldpool.test.ts` +
`scripts/shield/validate-general-withdraw.mjs`.

> **Enable it:** set `VITE_SHIELD_POOL` in the web build (else the funder is not
> registered and funding falls back to the faucet, unchanged). The relay reads
> `SHIELD_POOL` / `SHIELD_FEE_PAS`. Mainnet still needs a real anonymity set +
> the KS-side fixes below to be genuinely private — the mechanism is done, the
> privacy strength is a usage property (see the e2e report §5).

The original design and the seam it dropped into follow.

## Gasless stablecoin orders (Option C) + KS-only funding — IMPLEMENTED

The shielded **closed loop** for a stablecoin order needs the burner to hold no
native gas and no faucet crutch. Built + tested (contracts hardhat-tested, relay
+ web tsc/unit-tested; live upgrade pending):

- **Gasless token orders (contracts).** `createOrderERC20` / `acceptBidERC20` /
  `increaseTipERC20` now read **`_msgSender()`** (their escrow is a `transferFrom`
  from the customer's own balance, so a forwarding relay never fronts value → safe
  to meta-forward), and **`createOrderERC20WithPermit`** carries an EIP-2612
  permit so there's no separate approve tx. A customer with **zero native
  balance** places and funds a token order entirely by signatures; the relay pays
  all gas. NATIVE `createOrder`/`acceptBid` still read `msg.sender` (a relay must
  never front `msg.value`). Proven in `test/gasless-erc20.test.ts`.
- **Relay economics (reuse F6).** The relay forwards the token-order actions and
  **attributes their gas to the order** (creation gas via the `OrderCreated`
  event) into the existing per-order cumulative; its profitability guard then
  requires the **F6 dropoff rebate to cover that cumulative × margin** before it
  settles. So the relay is compensated *from the order* — raise `relayRebateBps`
  to size it. No new order field.
- **KS-only funding (web).** The `/api/drip` + relay `/fund` faucet **fallback is
  removed**: `fundBurner` funds a burner **solely** through the shielded pool
  (throws if unconfigured — no faucet). `placeOrder` funds the burner via KS and
  places the token order **gaslessly** (`gaslessCreateOrderERC20` = permit +
  forwarder) when a relay is available.

**Single tx for stable + gas?** No — a KS note is single-asset (the asset is
bound in the commitment), so one `proxy_withdraw` pays one asset. You don't need
to shield the gas though: shield the **USDC** (one withdrawal) and let the relay
absorb gas (gasless order + optional bundled top-up). Shielding *both* assets
means two notes/withdrawals. See the design discussion in the commit history.

## The problem

FARE's customer privacy rests on **per-order burner wallets** (`web/src/wallets.ts`,
[PRIVACY.md](PRIVACY.md) risk #3): every order is placed from a fresh wallet, so
consecutive orders share no on-chain identity and a home address can't be
derived from "person X's orders."

That unlinkability is real **on testnet only**, because the burner is funded
from a shared faucet — the funding source is common to everyone, so it links
nothing. **On mainnet the faucet goes away.** A burner must be funded with real
value, and the obvious path — send PAS/USDC from the customer's main wallet —
writes an on-chain edge `main → burner` that collapses the whole scheme: anyone
can follow the funding transfer back to the funder.

So the burner is only as private as its **funding path**. C4 is that path.

## Requirement

Fund a fresh burner with escrow-sized value such that **no on-chain edge links
the burner to the customer's funding identity**, while:

- the customer still ultimately pays (no subsidy);
- the burner needs enough for `orderValue + tip + maxFare` (+ gas, unless gas is
  separately sponsored via the F8 relay);
- funding is fast enough for a checkout (seconds, not a mixing epoch);
- refunds can flow back (sweep) without re-linking — today `sweepToMain` warns
  that it re-links; the shielded path should offer a shielded return too.

## Design — shielded pool with note withdrawal

The standard construction (Tornado-style / Aztec-style), sketched to FARE's shape:

1. **Deposit (amortized, done rarely).** The customer deposits a fixed
   denomination from their main wallet into a shielded pool contract once,
   receiving a secret **note** (a commitment `H(secret, nullifier)` added to an
   on-chain Merkle tree). One deposit funds many future orders. The deposit *is*
   linkable to main — but it reveals only "this person put N into the pool," not
   which later withdrawal is theirs.
2. **Withdraw to burner (per order).** To fund a burner, the client proves in
   zero knowledge that it knows a note in the tree and hasn't spent it (reveals a
   `nullifier`, not the note), and directs the withdrawal to the fresh burner
   address. The link to main is broken by the anonymity set of all deposits.
3. **Relayer-paid withdrawal.** The withdrawal tx itself needs gas, and paying it
   from main would re-link — so it's submitted by a **relayer** (the F8 venue
   relay is already this shape) that takes its fee from the withdrawn amount. The
   burner never needs pre-funding.

Anonymity-set caveats are inherited from the construction: privacy scales with
the number of deposits of that denomination; fixed denominations are required;
timing/amount correlation must be managed (deposit ahead of time, standard
sizes). FARE's escrow amounts vary, so either (a) fund burners in fixed units
and let change accrue in the vault, or (b) use a variable-amount pool
(Aztec-style confidential notes) if the target chain offers one.

### Alternatives considered

- **Confidential-transfer precompile / privacy L2.** If the settlement chain
  ships a shielded asset (encrypted balances, e.g. a USDC confidential variant),
  funding is a shielded transfer — no pool contract, no Merkle proofs. Cleanest
  if available; entirely dependent on the chain. This is the likely mainnet
  answer on a Polkadot privacy parachain.
- **Relayer float / off-chain settlement.** A relayer funds burners from its own
  float and the customer settles the relayer off-chain (or via a shielded
  channel). Moves the trust to the relayer and needs an off-chain rail; weaker
  than a pool but simplest operationally.

## Integration points (where the stub plugs in)

Only two call sites change, both already funnel through helpers:

- `web/src/relay.ts` → `ensureGas` / `sponsorGas`: before a value action, if
  `shieldedFundingAvailable()`, fund the burner via `fundBurner()` instead of the
  faucet/relay drip.
- `web/src/wallets.ts` → `newOrderWallet` funding step (in `App.tsx placeOrder`):
  same swap.
- Refund return: `sweepToMain` gains a shielded sibling that deposits burner
  balances back into the pool rather than forwarding to main in the clear.

`shield.ts` exposes exactly these so the swap is a one-line guard at each site;
until a pool/precompile exists, `shieldedFundingAvailable()` is `false` and every
call falls back to today's behavior.

## ~~Why it's blocked~~ → how it was unblocked

*(Historical: this section described the blocker. It is now resolved.)* A
shielded pool **does** exist on Paseo — **Kusama Shield** (Tornado/Privacy-Pools
lineage, Poseidon + LeanIMT + Groth16, with a PVM-native PoseidonT3 precompile).
FARE integrates against it with **no contract changes** (`web/src/shieldpool.ts`
+ `shield.ts`, relay `/shield-withdraw`). Two KS-side gaps (undocumented genesis
leaf; a 16-entry known-roots window) are handled **client-side** rather than
waiting on upstream:

- **Genesis leaf / incomplete logs (KS Issue 1):** we never read the genesis
  value. At deposit we snapshot the note's immutable left-path (`sideNodes` at
  bit-set levels); at withdraw we reconstruct only the right side from a bounded
  post-deposit event scan. This gives **deposit-ahead / withdraw-later** for any
  note — validated by withdrawing an *interior* leaf live.
- **Known-roots eviction (KS Issue 4):** the relay returns HTTP 409 on
  `"Unknown root"`; the client rebuilds the proof against a fresh root and
  resubmits (`fundBurner` retry loop).

What remains for **genuine mainnet privacy** is not code: a real KS anonymity
set + time-decorrelation, and (ideally) the upstream fixes so we can drop the
workarounds. See [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) and the
e2e report §5.

## See also
- [PRIVACY.md](PRIVACY.md) — the linkability threat model (risk #3)
- `web/src/wallets.ts` — burner rotation + the `sweepToMain` re-link warning
- [GPS.md](GPS.md) — the ZK dropoff proof (the existing Groth16 toolchain a pool circuit would reuse)
