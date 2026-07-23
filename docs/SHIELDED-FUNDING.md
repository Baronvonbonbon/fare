# Shielded burner funding (C4)

Status: **designed, blocked on external infra.** This is the seam and the plan,
not a working feature — no shielded pool exists on Paseo to build against. The
interface (`web/src/shield.ts`) marks the integration point so the real
implementation drops in without touching call sites.

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

## Why it's blocked

There is **no shielded pool or confidential-transfer primitive on Paseo** to
deploy against or call. Implementing C4 for real requires one of: a deployed
mixer/pool contract (plus its trusted setup or a Poseidon-Merkle circuit — FARE
already has a Groth16 toolchain from the dropoff proof, so a pool circuit is
tractable), or a privacy-enabled target chain with a confidential asset. Both
are external dependencies and mainnet-timed. The seam is in place; the
implementation waits on the infrastructure.

## See also
- [PRIVACY.md](PRIVACY.md) — the linkability threat model (risk #3)
- `web/src/wallets.ts` — burner rotation + the `sweepToMain` re-link warning
- [GPS.md](GPS.md) — the ZK dropoff proof (the existing Groth16 toolchain a pool circuit would reuse)
