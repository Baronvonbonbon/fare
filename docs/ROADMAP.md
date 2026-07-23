# FARE — From MVP to a Formal, Complete Product

The MVP proves the protocol shape. This is the gap analysis between "works
on Paseo" and "a product people trust with dinner and drivers trust with
income" — organized as R1/R2/R3 releases, mirroring the DATUM release
discipline.

## R1 — Protocol proof (now → next)

**Contracts**
- [x] Order book + reverse auction + escrow + dual-sig GPS settlement
- [x] Optional-stake registries with governance-raisable floors
- [x] Arbitrated disputes, per-category pause, pull-payment vault
- [x] Upgradable layer: `FareGovernanceRouter` registry + freeze-and-drain
      `FareUpgradable` base, paginated record imports, router-following web
      client (DATUM ladder, slim port)
- [x] Paseo deployment — live addresses in `web/src/deployed-addresses.json`
- [ ] A filmed end-to-end field test (two phones, one real handoff) — the
      single most persuasive artifact for the project
- [x] Fuzz + invariant tests (escrow conservation: Σcredits = Σescrow deltas)
      — `test/invariant.test.ts`: seeded randomized campaign asserting escrow
      conservation + vault solvency after every op
- [x] Slither pass + CI gate (DATUM audit-hedge #6 equivalent) — zero high-severity; see docs/SECURITY-REVIEW.md. Mythril on-demand.

**App**
- [x] PWA with Customer / Driver / Venue roles, GPS-signed attestations
- [x] QR codes for the attestation handoff (`qr.tsx` — `QRShow`/`QRScan`;
      pickup driver↔venue, dropoff driver↔customer)
- [ ] Event-driven refresh (currently polling)

## R2 — Product hardening

**Economics & trust**
- Driver/venue stake floors > 0 + slash-funded victim compensation (learn
  from DATUM G-9: route slashes to the harmed party, not governance)
- Reputation surfaced as a score in bid cards (delivered/failed is already
  on-chain); anomaly detection off-chain first, DATUM-reputation-style
- Cancellation-bond tuning with real data; per-venue take on prep-time
  no-shows (venue never loses: orderValue releases at pickup)

**UX blockers that decide adoption**
- **Gasless everything for customers and drivers.** Nobody buys PAS to buy
  pad thai. Add a relay path (DATUM `DatumRelay` pattern: relay pays gas,
  users sign EIP-712); meta-tx for createOrder/placeBid/confirms. *(Shipped:
  F8 forwarder + relay for non-value actions, gasless settlement, gasless
  withdraw, KS shielded funding. Next: **sponsored onboarding** —
  [RELAY-SPONSORSHIP.md](RELAY-SPONSORSHIP.md).)*
- **Fiat-denominated pricing** — quote in local currency, settle in
  DOT/stable via an oracle rate captured at acceptance.
- **Stablecoin escrow option** (Asset Hub USDC/USDT via the ERC-20
  precompile) — food margins can't absorb DOT volatility. The vault
  already isolates the money path; add an ERC-20 variant like DATUM's
  TokenRewardVault.
- Order metadata privacy: cart contents belong off-chain (IPFS hash or
  direct P2P message), never in calldata.
- Real-time driver↔customer messaging: off-chain (XMTP/libp2p), keyed to
  the order.

**Governance ladder (reuse DATUM wholesale)**
- Phase 0 deployer → Phase 1 council (disputes arbiter = council) →
  Phase 2 conviction-voted parameter governance
- `DatumGovernanceRouter`-style registry if the contract count grows;
  at 7 contracts, plain owner-rotation to a Safe is enough

**Security**
- External audit before any mainnet value (internal DATUM passes kept
  finding HIGHs at a much more mature stage — assume this needs one too)
- **MPC trusted-setup ceremony** — now a concrete prerequisite: the ZK
  proximity circuit has shipped (`circuits/proximity.circom`) with a
  single-party setup; a real ceremony must run before the mainnet
  `setVerifyingKey` (lock-once)

## R3 — Scale & decentralization

- ~~**ZK proximity settlement** (docs/GPS.md) — location privacy end-state~~
  **shipped.** The full location-privacy line is done:
  - Dropoff is **zero-knowledge** — `confirmDropoffZK` + `circuits/proximity.circom`
    + `FareLocationVerifier` (Groth16/BN254 over Asset Hub precompiles); no
    coordinate touches calldata, storage, or events.
  - Driver coordinates **scrubbed from pickup** — not emitted, ~33 m coarsened
    in calldata (the venue pin is public, so no circuit was warranted).
  - **Per-order customer burner wallets** (`web/src/wallets.ts`) — orders no
    longer chain to one identity.
  - Remaining mainnet gates: a real **MPC trusted-setup ceremony** (see
    R2/Security) and a **shielded funding path** for the per-order wallets
    (testnet relies on the shared faucet). Full status in docs/PRIVACY.md.
- **Batch settlement**: high-volume venues confirm N pickups in one tx
  (DATUM `settleClaimsMulti` shape)
- **Driver discovery/matching off-chain, settlement on-chain** — the
  auction can move to a p2p gossip layer with only winning-bid commitment
  on-chain if gas per order becomes load-bearing (DATUM's hybrid
  optimistic-aggregation decision applies here verbatim: measure first)
- Device attestation tier (Play Integrity / App Attest) as an
  AssuranceLevel-style per-order gradient: L0 open, L1 GPS dual-sig,
  L2 GPS + attested device
- Multi-city venue federations, venue-side allowlists of preferred drivers
  (DATUM CampaignAllowlist shape)
- Kusama → Polkadot Hub mainnet plan, EIP-170 revalidation, deploy
  runbooks + dress rehearsal (copy DATUM's MODULAR-DEPLOY-RUNBOOK habit)

## What makes this "formal"

1. **A written trust model** (docs/GPS.md) that says out loud what is and
   isn't proven — the DATUM "acknowledged-unfixable" discipline.
2. **Runbooks over memory**: deploy, incident, upgrade — one markdown each.
3. **Invariant-first testing**: escrow conservation, status-machine
   soundness, "exits never pause-gated".
4. **An explicit decentralization gradient**: who can do what today
   (deployer arbiter, owner params) and the concrete ladder out of it.
5. **Field evidence**: a real delivery, on Paseo, on video, with the tx
   hashes in the README.
