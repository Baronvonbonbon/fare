# Relay sponsorship — expansion surface (possible upgrades)

Candidate upgrades that widen what a **venue-node relay** can sponsor gaslessly,
beyond today's set. Design notes + tradeoffs; nothing here is built yet. Anchored
in what the contracts actually permit (verified 2026-07-23).

## The rule that decides "sponsorable"

An action can be relayed gaslessly only if it **doesn't derive the caller's
identity from `msg.sender`** — either it carries its own signature/proof, or it's
**EIP-2771-aware** so the relay `execute()`s a user-signed request and the
contract still reads `_msgSender()`. **Value-bearing** actions can never be
meta-forwarded (the relay would front the money); they use the **funded-wallet**
path (relay sponsors *gas*, the user's own wallet supplies the *value*).

### Sponsorable today
| Endpoint | Action | Mechanism |
|---|---|---|
| `/submit` | `confirmPickup`, `confirmDropoffZK` | carry their own sigs / ZK proof (no `msg.sender` check) |
| `/forward` | `placeBid`, `withdrawBid`, `cancelOpen`, `cancelAssigned`, `abandonOrder`, `rate` | EIP-2771 via `FareForwarder` → `FareOrders`/`FareRatings` |
| `/withdraw` | `FareVault.withdrawFor` | driver-signed EIP-712; relay reimbursed by `withdrawFeeBps` |
| `/fund` | gas top-up (burner) | plain transfer, budget-gated |
| `/shield-withdraw` | KS burner funding | client-built proof; sponsor/fee mode |

**Key gap:** `FareDrivers` and `FareVenues` are **not** 2771-aware — `register`,
`registerVenue`, `setMetadata`, `addStake` read `msg.sender` directly. So
registration/onboarding is **not** meta-forwardable today.

---

## Upgrade 1 — Sponsored onboarding (drivers & venues)

Let a region's relay pay a new driver/venue's first-touch gas so they can
**register and immediately begin earning**, instead of "buy PAS first." Two
implementations, very different cost:

### Route A — seed-gas (no contract change, works today)
Relay funds a fresh wallet, the user self-`register`s (+ optionally stakes) and
starts bidding. A new relay endpoint (`/register-sponsor` or an ED-aware `/fund`
that accepts a not-yet-registered address).
- **Existential deposit (ED):** on Asset Hub a new account must be seeded
  **≥ ED** in the funding transfer or it's rejected/reaped, and a later sweep
  below ED loses the dust. Seed `ED + register-gas`, not just gas. (`/fund`'s
  current 5 PAS clears ED; a "small seed" must still clear it.)
- Creates a **persistent** identity — correct for drivers/venues (reputation,
  stake, payouts are per-address), unlike per-order customer burners.
- Fastest path to your "immediately begin earning" flow.

### Route B — make the registries 2771-aware (the durable fix)
Copy the `FareRatings` pattern (`ERC2771Context` + `_msgSender()` override +
`_forwarder` in the constructor) into `FareDrivers`/`FareVenues`; add
`register`/`registerVenue`/`setMetadata` to the relay's `FORWARD_TARGETS`. Then
onboarding is a **true gasless meta-tx** — no ED float, no bespoke seed path.
- Both registries are already `FareUpgradable` (router + freeze-and-drain), so
  this rides the **existing upgrade path** — but it *is* a redeploy + router
  promotion + record migration, not free.
- Only **zero-value** actions meta-forward: `register` with 0 stake,
  `setMetadata`, `requestUnstake`, `withdrawStake`. Anything **payable**
  (`register` *with* stake, `addStake`) stays funded-path (relay sponsors gas
  only).

---

## Upgrade 2 — Other actions worth sponsoring

| Action | Sponsorable? | Route |
|---|---|---|
| `setMetadata` (venue menu / driver profile) | ✅ | **frequent** for venues; keeps them engaged. A or B |
| `requestUnstake` / `withdrawStake` | ✅ | zero-value lifecycle; B |
| `rate` | ✅ *already* | forwardable today |
| `addStake`, `register`+stake, `increaseTip` | ⚠️ gas only | value-bearing → funded-wallet path |
| dispute open / bond | ❌ | bonded value; do not sponsor |

---

## Cross-cutting design constraints (the load-bearing ones)

1. **Sybil / gas-drain is the real risk.** Registration has **no F6-style
   reward** (unlike dropoff settlement), so open sponsorship is a pure
   loss-leader an attacker can script to drain the relay's budget with fake
   drivers. Mitigations, best first:
   - **Require a minimal stake** — the stake *is* the anti-Sybil, and it keeps
     the relay sponsoring only *gas* while the driver funds the value.
   - Rate-limit per IP / per region; keep it under `RELAY_GAS_BUDGET_PAS`.
   - App-layer proof-of-personhood / CAPTCHA before a sponsored register.
2. **Make onboarding recoupable, like F6.** Skim a small **onboarding fee off
   the driver's first N deliveries** (or first vault withdrawal), mirroring
   `relayRebateBps` / `withdrawFeeBps`. Turns "float seed gas" into a financeable
   acquisition loop instead of pure cost.
3. **Region-scope it.** A relay should sponsor onboarding for **its own region**
   (`HOME_COORDS`), not global strangers — a venue wants drivers *nearby*. This
   is the same region-manifest discovery the relay already uses.
4. **ED-aware funding + sweep.** `/fund` must seed `≥ ED + gas` for brand-new
   accounts; sweeps must leave ED or intentionally reap and accept the dust loss.

---

## Recommendation

**Route A first** (ED-aware seed-gas onboarding, gated behind a minimal stake for
Sybil resistance, region-scoped, under the budget guard) — unlocks "immediately
begin earning" with no on-chain change. Schedule **Route B** (2771 registries)
for the next batched registry upgrade as the durable, ED-free version. Add the
**onboarding-fee recoup** so sponsored acquisition pays for itself.

## See also
- [../venue-node/README.md](../venue-node/README.md) — the relay + its current endpoints
- [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) — region discovery, node roles
- [ROADMAP.md](ROADMAP.md) — R2 "Gasless everything" / economics
