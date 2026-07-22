# FARE — Remaining Actions

One consolidated, actionable view of what's left, pulled from the per-feature
docs and the [integration-plan board](PRODUCT-INTEGRATION-PLAN.md). Grouped by
*what kind of work it is*, most-actionable first.

Legend: ☐ not started · 🟡 partial (verifiable core built, rest deferred) · 🔒 mainnet gate.

> **Live status (Paseo, 2026-07-22).** Full protocol deployed + seeded, now
> including **F6 (relay gas-rebate)** and **F8 (EIP-2771 forwarder + gasless
> withdraw)**. Migrated via `scripts/upgrade-f6-f8.ts` (freeze-and-drain).
> Current addresses: forwarder `0x57C7…97FCe`, vault `0x9f03…C0Ea` (old vault
> kept live for drain), orders `0x7e73…B32e`, settlement `0xC560…25a8E`, ratings
> `0xa854…73D6` — see `deployed-addresses.json`. Fees on-chain:
> `relayRebateBps=2000`, `withdrawFeeBps=100`. **Gasless UX is deployed but
> dormant** — it activates only once a relay is actually running + reachable
> (see §1). Everything else falls back to direct, gas-paying calls, so nothing
> is broken in the meantime.

---

## 1. Operational — make the live demo fully work (no new code)

The full protocol (incl. F6/F8) is deployed + seeded on Paseo. Remaining ops:

- ☐ **Run a venue relay (this is what turns gasless ON)** — run `venue-node/`
  with a funded `RELAY_PRIVATE_KEY`, then either build the app with
  `VITE_RELAY_URL=…` or advertise `PUBLIC_RELAY` from the agent's manifest (the
  client discovers it). The forwarder + gasless-withdraw vault are already live,
  so a running relay immediately makes placeBid / cancels / rate / withdraw
  gasless. **Note the profitability guard:** with real (tiny) testnet fares the
  relay will *decline* settlement (rebate ≪ gas) and the app prompts "pay your
  own gas?"; set `RELAY_PROFIT_GUARD=off` for a fully-gasless demo, or raise
  `relayRebateBps`/`feeBps`. See [venue-node/README](../venue-node/README.md).
- ☐ **Faucet secret** — set `DRIP_PRIVATE_KEY` (funded) in Cloudflare Pages env so
  `/api/drip` funds burners on demand (the "one manual secret step"). Without it,
  gas top-ups fall back to the public faucet. (Auto-drip on connect was removed;
  value actions ensure gas on demand, non-value actions go gasless via the relay.)
- ☐ **IPFS (optional, shared menus)** — stand up the DATUM node + set
  `IPFS_ADD_URL` / `IPFS_API_KEY` / `VITE_IPFS_GATEWAY`. Without it, published
  menus are device-local (`local://`), single-device only.
- ✅ **Cloudflare Pages rebuild** auto-triggers on push to `main` (address books
  committed); the client also re-resolves upgraded contracts from the router at
  runtime.
- ✅ Deployment + seed + **F6/F8 migration** done (15 contracts live; venues #1–2;
  demo order re-seeded on the new orders).

---

## 2. Feature follow-ons (🟡 — core built, infra/UI deferred)

Each has a verified core already committed; the remaining half is the deferred
infra/UI, spec'd in the linked design note.

- 🟡 **B2 Live tracking** — status stepper + ETA done. Remaining: **driver-location
  relay + map trace** (needs the off-chain location channel).
- 🟡 **B3 Messaging** — E2E crypto done + tested (`web/src/msg.ts`). Remaining:
  handoff pubkey wiring + a **relay** (P1 `/api/msg`+KV → P2 venue-node) + chat UI.
  See [MESSAGING.md](MESSAGING.md).
- 🟡 **B6 Proof-of-delivery photo** — crypto-shred sealing done + tested
  (`web/src/photo.ts`). Remaining: capture+compress UI, an **authorized submitter**
  (Bulletin Chain `store` / IPFS pin), key-wrap over `msg.ts`, and the expiry job.
  See [PHOTOS.md](PHOTOS.md).
- ✅ **C1 / F8 Gasless relay** — `venue-node/` relay (gas sponsorship + settlement
  relay) **and** the EIP-2771 forwarder: `FareForwarder` + `_msgSender()` in
  `FareOrders`/`FareRatings` make the **non-value** user actions (placeBid /
  withdrawBid / cancels / rate) gasless via the relay's `/forward`. Value actions
  (createOrder / acceptBid / increaseTip) stay on the gas-sponsored funded-burner
  path so the relay never fronts escrow. **PWA wired** (`web/src/relay.ts`
  `relayForward` — the app signs a `ForwardRequest` and posts it to `/forward`
  when a forwarder is deployed + a relay is available, else falls back to direct
  calls). **Relay discovery:** the agent advertises `services.relayUrl` in its
  region manifest (`PUBLIC_RELAY`); the client learns a relay pool and prefers the
  discovered region relay over the build-time `VITE_RELAY_URL` (DATUM `relayUrl`
  pattern). **Gasless earnings:** `FareVault.withdrawFor` (driver-signed, relay-
  submitted, `withdrawFeeBps` reimburses the relay) lets a driver cash out with
  zero gas — `relayWithdraw` in the app + `/withdraw` on the relay.
  **Profitability guard:** the relay estimates gas and only sponsors a
  reward-bearing action when the fee reward covers the fare's cumulative relayed
  cost × margin (`venue-node/economics.mjs`); no-reward actions run under a gas
  budget; declines return 402 → the app prompts "pay your own gas?"
  (`RELAY_PROFIT_GUARD=off` to disable). **Deployed live on Paseo** (forwarder +
  migrated vault). Remaining: only **run a relay** to activate it (§1).
  See [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md).

---

## 3. Not started (☐)

**Group B — product**
- ☐ **B4 Push notifications** — VAPID keys + push service + service-worker push
  handlers (status changes, new offers/bids). External infra.

**Group C — payments / economics**
- ☐ **C2 Fiat-denominated pricing** — quote in local currency, settle at an oracle
  rate captured at acceptance.
- ☐ **C3 Stablecoin escrow** — Asset Hub USDC/USDT via the ERC-20 precompile; an
  ERC-20 variant of `FareVault`.
- 🔒 **C4 Shielded funding** for per-order burners — see §4.

**Group D — ops / governance console** (⚙️ deliberately out of the consumer PWA)
- ☐ **D1 Arbiter console** — dispute queue + `resolve` (customerShareBps, openerWins, slash).
- ☐ **D2 Governance console** — `setParams` / `setGeoParams` / `setMinStake` / `setDisputeBond` / `setArbiter`.
- ☐ **D3 Guardian pause console** — `pause` / `unpause` / `setGuardian`.
- ☐ **D4 Upgrade console** — router `register` / `upgradeContract` / `setContractFrozen`.

**Group E — trust & release**
- ☐ **E1 Filmed end-to-end field test** (two phones, one real handoff) — R1's key artifact.
- ☐ **E2 Slither / Mythril** static-analysis pass (add to CI).
- ☐ **E3 External audit** before mainnet value.
- ☐ **E4 Device-attestation tier** (Play Integrity / App Attest), L0/L1/L2 gradient.

**Group F — venues-as-infrastructure** (design in [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md))
- ✅ **F1 `VenueMetadataUpdated` event** — `setMetadata` now emits it (+ test); event-driven menu-update replication unblocked.
- ✅ **F2 Venue appliance** — `venue-node/` Docker Compose (Kubo + agent + relay + Caddy). Remaining: **run it** on a venue box, and an optional `pine-rpc` light-client container (folded into F4).
- ✅ **F3 Replication agent** — `venue-node/agent.mjs`: chain-indexed region pinning + region-manifest publish, re-pins on `VenueMetadataUpdated`.
- ✅ **F4 Client gateway/RPC fallback pool** — gateway pool (`web/src/pool.ts`): the client learns venue/region IPFS gateways from manifests as it loads menus. RPC-provider pool (`web/src/rpcpool.ts`, wired in `chain.ts`): venue RPCs augment reads only in hosted mode as lower-priority fallbacks behind the hosted anchor, and broadcasts fan out to several endpoints — the in-app light client stays the trustless primary, venue RPC never a sole read path (§4/§5). Both tested.
- ✅ **F5 Data-availability scoring** — `venue-node/scorer.mjs`: challenge-response (random byte-range vs. CID-canonical content) + decayed client reports → per-node score + leaderboard. Feeds F6.
- 🟡 **F6 On-chain rewards** — Tier 1 **LIVE on Paseo**: **trustless relay gas-rebate** (`relayRebateBps` in `FareOrders`, + test). A governed share of the protocol fee is carved to the account that submits the dropoff tx (the relay that fronted gas), self-identified via `msg.sender` — no oracle, no new cost to orders, escrow math exact. Deployed with `relayRebateBps=2000` (20% of the fee). Remaining: **Tier 2 DA-score reward** (`FareDataAvailability` + a trusted attester to bring F5 scores on-chain) — **deferred, no oracles for now**; token emission intentionally out of MVP.
- ✅ **F7 Hosted super-node mode** — one appliance serves many venues by setting `HOME_COORDS` to a list of centers; the agent pins the union of their regions (+ tests). The relay is already region-agnostic, and the hosted `/api/menu` publish path exists, so non-technical venues need no box of their own.

---

## 4. 🔒 Mainnet gates (hard prerequisites)

Do NOT ship for real value until all hold. Privacy is largely closed already
(ZK dropoff, driver-coord scrub, per-order burners); what remains:

- 🔒 **Real MPC trusted-setup ceremony** before `setVerifyingKey` (lock-once). The
  shipped setup is single-party — fine for testnet, not mainnet.
- 🔒 **Shielded funding path** for per-order burner wallets (C4). Faucet-funded
  burners are unlinkable *only* on testnet (shared faucet); on mainnet, funding
  from a real wallet re-links them. Needs a mixer / shielded pool / relayer-funded
  meta-txs.
- 🔒 **External audit** (E3) + fuzz/invariant coverage (✅ started, `test/invariant.test.ts`).
- 🔒 **Stablecoin escrow** (C3) — food margins can't absorb DOT volatility.

Full mainnet gate + rationale: [PRIVACY.md](PRIVACY.md) · [ROADMAP.md](ROADMAP.md).

---

## See also
- [PRODUCT-INTEGRATION-PLAN.md](PRODUCT-INTEGRATION-PLAN.md) — the tracking board (A–F) + DoorDash journeys
- [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) · [MESSAGING.md](MESSAGING.md) · [PHOTOS.md](PHOTOS.md)
- [ROADMAP.md](ROADMAP.md) · [PRIVACY.md](PRIVACY.md) · [GPS.md](GPS.md) · [ARCHITECTURE.md](ARCHITECTURE.md)
