# FARE — Remaining Actions

One consolidated, actionable view of what's left, pulled from the per-feature
docs and the [integration-plan board](PRODUCT-INTEGRATION-PLAN.md). Grouped by
*what kind of work it is*, most-actionable first.

Legend: ☐ not started · 🟡 partial (verifiable core built, rest deferred) · 🔒 mainnet gate.

---

## 1. Operational — make the live demo fully work (no new code)

The contracts are deployed + seeded on Paseo. These are config/ops steps:

- ☐ **Cloudflare Pages rebuild** — bake in the fresh `deployed-addresses.json`.
  If Pages is Git-connected it auto-builds on push to `main` (already triggered);
  otherwise trigger from the dashboard. *(No CLI/creds in-repo to do it here.)*
- ☐ **Faucet secret** — set `DRIP_PRIVATE_KEY` (funded) in Cloudflare Pages env so
  `/api/drip` auto-funds burners (the "one manual secret step"). Without it, gas
  UX degrades to the public faucet.
- ☐ **Venue relay (optional, gasless)** — run `venue-node/` with a funded
  `RELAY_PRIVATE_KEY` and build the app with `VITE_RELAY_URL=…`. See
  [venue-node/README](../venue-node/README.md).
- ☐ **IPFS (optional, shared menus)** — stand up the DATUM node + set
  `IPFS_ADD_URL` / `IPFS_API_KEY` / `VITE_IPFS_GATEWAY`. Without it, published
  menus are device-local (`local://`), single-device only.
- ✅ Deployment + seed done (10 contracts live; venues #1–2 + open order #1).

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
- 🟡 **C1 / F8 Gasless relay** — `venue-node/` relay shipped (gas sponsorship +
  settlement relay, no contract change). Remaining: **run it** against the live
  deploy, and an **EIP-2771 forwarder** for full meta-tx (createOrder / placeBid /
  rate). See [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md).

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
- 🟡 **F4 Client gateway/RPC fallback pool** — gateway pool shipped (`web/src/pool.ts` + test): the client learns venue/region IPFS gateways from manifests as it loads menus and folds them into menu resolution. Remaining: the **RPC-provider pool** — venue RPCs multiplexed *behind* the in-app light client (never a sole trusted read path).
- ☐ **F5 Data-availability scoring** (challenge-response + client reports).
- ☐ **F6 On-chain DA rewards** (fee discount / token) — protocol-incentivized replication.
- ☐ **F7 Hosted super-node mode** (for non-technical venues).

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
