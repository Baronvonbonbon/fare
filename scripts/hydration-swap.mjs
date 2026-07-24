#!/usr/bin/env node
// Hydration swap test script (Paseo testnet) — two jobs:
//   1) SOURCE a testnet stablecoin balance: swap PAS → USDC on Hydration and
//      deliver it back to an Asset Hub account (so we can test the real-asset
//      FARE order path without a stablecoin faucet).
//   2) PROVE the exact XCM swap path the relay's fee-recovery module needs
//      (venue-node/treasury.mjs) — same route, reversed.
//
// Uses Paraspell's XCM Router (SpellRouter). QUOTE mode is read-only (no signer,
// no funds) and validates the route + gives the live PAS↔USDC price that also
// feeds the profitability guard (economics.tokenToNativeWei). EXECUTE mode needs
// a funded SUBSTRATE (sr25519) signer — Paraspell submits substrate extrinsics,
// not EVM txs. Fund it from the Paseo faucet (faucet.polkadot.io) or the
// Hydration Discord faucet (#testnet-faucet, /drip <address>).
//
//   npm i @paraspell/xcm-router @paraspell/sdk         # (+ its wasm/augment deps)
//   node scripts/hydration-swap.mjs quote              # read-only price/route check
//   SUBSTRATE_SEED='//your seed' node scripts/hydration-swap.mjs swap
//
// Chain/exchange identifiers vary by Paraspell version + network; override via env
// and cross-check https://paraspell.github.io/docs/supported.html .
const MODE = process.argv[2] || "quote";
const FROM = process.env.SWAP_FROM_CHAIN || "AssetHubPaseo";
const EXCHANGE = process.env.SWAP_EXCHANGE || "HydrationPaseo"; // Hydration's Paseo testnet DEX
const TO = process.env.SWAP_TO_CHAIN || "AssetHubPaseo";
const FROM_SYMBOL = process.env.SWAP_FROM || "PAS";   // native gas token in
const TO_SYMBOL = process.env.SWAP_TO || "USDC";      // stablecoin out
const AMOUNT = process.env.SWAP_AMOUNT || "1000000000000"; // 1 PAS (12dp on relay/AH native) — adjust
const RECIPIENT = process.env.SWAP_RECIPIENT || "";   // Asset Hub account to receive the stablecoin

async function main() {
  let RouterBuilder;
  try { ({ RouterBuilder } = await import("@paraspell/xcm-router")); }
  catch { console.error("Install first:  npm i @paraspell/xcm-router @paraspell/sdk"); process.exit(2); }

  const base = RouterBuilder()
    .from(FROM).exchange(EXCHANGE).to(TO)
    .currencyFrom({ symbol: FROM_SYMBOL }).currencyTo({ symbol: TO_SYMBOL })
    .amount(AMOUNT);

  if (MODE === "quote") {
    // Read-only: route validity + best amount out (→ the live price).
    console.log(`Quoting ${FROM_SYMBOL} → ${TO_SYMBOL} via ${EXCHANGE} (${AMOUNT} in)…`);
    const out = await base.getBestAmountOut();
    const amountOut = BigInt(out.amountOut ?? out); // shape varies by version
    console.log(`  best amount out: ${amountOut} ${TO_SYMBOL} (smallest units)`);
    // price(native per whole token) fraction for the economics guard:
    //   RELAY_TOKEN_PRICE ≈ AMOUNT_in_whole / amountOut_in_whole   (invert for token→native)
    console.log(`  → set RELAY_TOKEN_PRICE from this rate (native per whole ${TO_SYMBOL}).`);
    console.log(`  ✓ route exists on the Hydration Paseo testnet.`);
    return;
  }

  if (MODE === "swap") {
    const seed = process.env.SUBSTRATE_SEED;
    if (!seed) { console.error("EXECUTE needs a funded substrate signer: SUBSTRATE_SEED='//alice-style seed' (fund via faucet.polkadot.io / Hydration Discord)."); process.exit(2); }
    if (!RECIPIENT) { console.error("Set SWAP_RECIPIENT = the Asset Hub account to receive the stablecoin."); process.exit(2); }
    // Build a substrate signer (polkadot-api / PolkadotJS keyring). Left explicit
    // rather than hidden — the signer model is the one hard dependency.
    const { Keyring } = await import("@polkadot/keyring");
    const { cryptoWaitReady } = await import("@polkadot/util-crypto");
    await cryptoWaitReady();
    const signer = new Keyring({ type: "sr25519" }).addFromUri(seed);
    console.log(`Swapping ${AMOUNT} ${FROM_SYMBOL} → ${TO_SYMBOL} → ${RECIPIENT} (signer ${signer.address})…`);
    await base
      .senderAddress(signer.address)
      .recipientAddress(RECIPIENT)
      .signer(signer)
      .onStatusChange((s) => console.log(`  · ${s.type ?? JSON.stringify(s)}`))
      .build()
      .then((txs) => txs);
    console.log(`✅ swap submitted — check the recipient's ${TO_SYMBOL} balance on Asset Hub.`);
    return;
  }

  console.error(`usage: node scripts/hydration-swap.mjs [quote|swap]`);
  process.exit(1);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
