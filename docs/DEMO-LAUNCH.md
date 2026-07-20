# FARE — Demo Launch Plan

Assessment date: 2026-07-12. Targets chosen: **public testnet pilot** +
**local meetup/hackathon demo**. Mobile direction: **plan true native
(React Native/Expo)** after the pilot. Ecosystem focus: **Parity/W3F tech &
infra options** (not funding). Status: **pre-pilot, no merchants/drivers
lined up yet.**

## Where the repo stands

Solid protocol foundation:

- 8 contracts — escrow / reverse auction / dual-sig GPS settlement, pull-payment
  vault, disputes, per-category pause, freeze-and-drain upgradable layer.
- **36 tests passing** (fare flows, GeoLib, upgradability, pause safety).
- Mobile-first PWA with all three roles (Customer / Driver / Venue), burner
  wallet mode, and a three-tier node picker down to an in-browser smoldot
  light client.

**The biggest gap is simple: nothing is deployed to Paseo yet.** Only
`deployed-addresses.localhost.json` exists — today the demo only runs against
a local hardhat node.

## Next steps for the pilot + hackathon demo (priority order)

1. **Deploy to Paseo and commit the addresses.** Config is ready
   (`polkadotTestnet` network, PaseoSafeSender workarounds). Fund the deployer
   at the [Polkadot faucet](https://faucet.polkadot.io/) — 5,000 PAS per
   request, free, no auth. Contracts on Paseo run on the **Passet Hub** test
   chain ([forum post](https://forum.polkadot.network/t/testnets-paseo-officially-becomes-the-polkadot-testnet-temporary-passet-hub-chain-for-smart-contracts-testing/13209));
   the `eth-rpc-testnet.polkadot.io` default already targets it — verify
   against the [connect docs](https://docs.polkadot.com/smart-contracts/connect/).
2. **Host the PWA on HTTPS** (Cloudflare Pages / Vercel). The Geolocation API
   and PWA install both require a secure context — hard prerequisite for any
   two-phone demo, not a nice-to-have.
3. **QR handoff.** Copy-pasting an EIP-712 signature between two strangers'
   phones kills the demo moment; driver scans customer's screen instead.
   ~1 day: QR render lib + `BarcodeDetector`/jsQR.
4. **In-app funding for burner wallets.** Burner-key mode already exists; add
   a funded "drip" account that auto-tops-up new burners so a pilot user never
   touches a faucet captcha. On testnet this substitutes for the R2 gasless
   relay.
5. **Order contents channel** (see merchant section) — without it a real venue
   can't participate even in a pilot.
6. **Faster/event-driven refresh** — full-scan polling is fine at pilot scale
   but feels laggy on a demo floor.
7. **The filmed field test** (two phones, one real handoff, tx hashes) — the
   roadmap's "single most persuasive artifact," doubles as the hackathon
   opener.
8. Before opening to the *public* (vs. an invited cohort): fuzz/invariant
   tests and a Slither pass from R1. Testnet money, but a public pilot that
   visibly breaks is worse than none.

## Mobile client

**A mobile client exists today and covers all roles:** the `web/` PWA installs
on both iOS and Android from the browser — Customer / Driver / Venue views,
GPS-signed attestations, wallet (injected/burner/key), node picker. The
settlement model only needs *foreground* GPS at the handoff moment, which the
browser Geolocation API provides — so the PWA is genuinely enough for the
pilot.

PWA limits: no background location (no live driver tracking), weak push on iOS
(installed PWAs only; Safari throttles service workers), no device
attestation.

### React Native / Expo plan (post-pilot)

Sequence it **after** the Paseo pilot; use the pilot to validate flows.

- **Chain access is easy:** contracts speak standard eth-rpc, so ethers v6
  works in RN with crypto polyfills — no WASM needed via the hosted gateway.
  One codebase, both stores, via Expo + EAS Build.
- **Share the protocol layer:** extract `chain.ts` / `geo.ts` / EIP-712
  signing into a shared package consumed by web + RN; the PWA stays alive as
  the zero-install surface.
- **Light-client mode is the one casualty:** smoldot is WASM and RN has no
  WASM runtime — [SubWallet-Mobile](https://github.com/Koniverse/SubWallet-Mobile)
  works around this with a webview. Ship the native app gateway-first; keep
  light-client mode on the PWA / Pine daemon initially.
- **What native buys:** `expo-location` (background/foreground GPS, accuracy
  control), `expo-camera` QR scanning, real push, keys in `expo-secure-store`,
  and — the big one — **Play Integrity / App Attest device attestation**, the
  roadmap's R3 "L2 attested-device" tier. That tier is impossible as a PWA.
- **Wallets:** in-app burner keys as default (pilot-proven UX) plus
  WalletConnect for [Nova Wallet](https://novawallet.io/) and SubWallet.
- **Store caveat:** a P2P crypto-settled delivery app will get Apple review
  scrutiny; run the iOS pilot through TestFlight, don't block the testnet
  pilot on store approval.

## Merchant / vendor readiness

Already strong for merchants: `FareVenues` gives an operator account, a hot
signer key for the counter tablet, a payout address, and a public location
pin. The zero-payment-rail onboarding (`orderValue = 0`, keep the existing
POS, FARE only handles the delivery fare) is the strongest merchant pitch.
Pull-payments mean they withdraw on their own schedule.

Missing before any real venue can use it:

1. **A menu/cart channel — the top functional blocker.** Nothing carries
   *what the customer ordered*; a restaurant can't cook from a `dropCommit`.
   Minimum viable: menu JSON at the venue's `metadataURI` + an order-items
   hash with off-chain delivery of the items (even a QR the customer shows).
2. **Guided onboarding wizard** — register venue, generate the hot signer on
   the tablet, set payout address. Currently requires understanding the
   contract.
3. **"Venue tablet mode"** — kiosk view of incoming orders with sound/
   notification on new orders (polling is fine for pilot).
4. **Fiat-denominated pricing + stablecoin escrow** before real money: quote
   local currency, settle USDC/USDT. Food margins can't absorb DOT volatility
   (roadmap R2); the infra now exists (below).
5. Boring but decisive at recruitment: one-page merchant explainer,
   receipts/export for bookkeeping, driver-reputation display so venues trust
   who walks in.

## Parity / Web3 Foundation tech & infra options

Timing is strongly favorable:

- **Polkadot Hub mainnet is live.** Revive (pallet-revive, FARE's exact
  target) [went live on Polkadot mainnet late January 2026](https://medium.com/@OneBlockplus/polkadots-january-2026-reset-from-economic-model-to-execution-layer-7542898bc471)
  with elastic scaling (~2s blocks), after the
  [January 20 scheduled launch](https://blockchain.news/flashnews/polkadot-hub-to-add-evm-pvm-smart-contracts-and-2-second-blocks-on-jan-20-2026)
  and a Kusama-first rollout. The solc 0.8.24/cancun toolchain carries to
  mainnet unchanged — R3's mainnet plan is now a deploy decision plus audit.
  Track the [Revive status thread](https://forum.polkadot.network/t/revive-smart-contracts-status-update/16366)
  for current limits.
- **Native stablecoins with a contract-facing interface.**
  [Circle-issued USDC is native on Asset Hub](https://www.circle.com/blog/now-available-usdc-for-polkadot-asset-hub)
  (asset ID 1337) and USDT (1984); the
  [ERC-20 precompile](https://docs.polkadot.com/smart-contracts/precompiles/erc20/)
  exposes them to Solidity as standard ERC-20s — the R2 stablecoin-escrow
  vault variant needs **no bridge and no wrapped assets**, just an ERC-20 code
  path in `FareVault`.
- **Testnet infra:** [Paseo](https://paseo.site/developers) is the official
  community-run testnet mirroring Polkadot's runtime; the
  [faucet](https://faucet.polkadot.io/) covers all Paseo chains. Parity hosts
  the eth-rpc gateway already configured here; community RPC providers offer
  redundancy for the pilot.
- **Light clients:** smoldot (already used via pine-rpc) is the W3F-backed
  trust-minimized path; the three-tier node picker is exactly the story
  Parity likes to showcase — feature it in the hackathon demo.
- **Mobile wallet ecosystem:** [Nova Wallet](https://novawallet.io/)
  (mobile-first, WalletConnect) and SubWallet (mobile + EVM/
  MetaMask-compatible); see the
  [wallet integration docs](https://docs.polkadot.com/parachains/integrations/wallets/).
- **Kept in the back pocket** (funding not the current ask): once the filmed
  field test exists, it is precisely the artifact W3F Grants / Decentralized
  Futures reviewers respond to.

## Suggested sequence

Paseo deploy + hosted PWA + QR handoff + burner auto-fund (~1–2 weeks) →
invited pilot with one friendly venue using the menu-channel MVP → filmed
field test → hackathon demo → start the Expo app with the shared protocol
package.
