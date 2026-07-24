#!/usr/bin/env node
// Live coverage-swap probe — proves venue-node/swap.mjs `executeSwap` works END TO
// END on Paseo Asset Hub: a burner holding shielded PAS swaps PAS → USDC on the
// local `asset-conversion` DEX, driven by ONE ordinary EVM transaction (no
// substrate key), and the USDC lands back on the burner.
//
// The rail (see docs/RELAY-TREASURY.md): the EVM tx targets the sentinel
// RUNTIME_PALLETS_ADDR, so pallet-revive decodes its calldata as a SCALE-encoded
// runtime call and dispatches `assetConversion.swapTokensForExactTokens` under the
// signer's FALLBACK account (`H160 ++ 0xEE×12`) — which is exactly where the
// burner's PAS sits and where `sendTo` returns the bought USDC. The asset-1337
// ERC20 precompile's `balanceOf(burnerH160)` reads that fallback account, so the
// USDC gain is observable at the plain EVM address.
//
// This is the one confirmation the unit tests + live-metadata encode round-trip
// can't give: a real swap moving real value. It is the coverage-layer sibling of
// scripts/shield/probe.mjs (which proves the shielded WITHDRAWAL that funds the
// burner's PAS in the first place).
//
// Run:  npm i @polkadot/api          # once, at repo root (only extra dep)
//       node scripts/shield/coverage-swap.mjs
//       DRY=1 node scripts/shield/coverage-swap.mjs   # plan + encode only, no tx
// Env:  BURNER_PRIVATE_KEY | DEPLOYER_PRIVATE_KEY  (funded with PAS on Paseo AH)
//       TESTNET_RPC (EVM RPC)   AH_WSS (substrate WSS for the quote + call encode)
//       ASSET_ID (1337 USDC | 1984 USDt)   NEED_USDC (0.5)   GAS_RESERVE_PAS (2)
//       TOKEN_PRECOMPILE (override the ERC20 precompile address)

import { ethers } from "ethers";
import { ApiPromise, WsProvider } from "@polkadot/api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  priceNativePerToken, planCoverage, encodeSwapCall, executeSwap,
  fallbackAccountId, RUNTIME_PALLETS_ADDR,
} from "../../venue-node/swap.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

// ── config ───────────────────────────────────────────────────────────────────
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const AH_WSS = process.env.AH_WSS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ASSET_ID = Number(process.env.ASSET_ID ?? 1337);
const TOKEN_DEC = Number(process.env.TOKEN_DECIMALS ?? 6);
const NEED = process.env.NEED_USDC ?? "0.5";            // token to end up with (fare+tip stand-in)
const GAS_RESERVE = process.env.GAS_RESERVE_PAS ?? "2"; // PAS kept for gas, never swapped
const DRY = ["1", "true", "yes"].includes(String(process.env.DRY || "").toLowerCase());

// asset ERC20 precompiles (docs/RELAY-TREASURY.md). Override via TOKEN_PRECOMPILE.
const PRECOMPILE = process.env.TOKEN_PRECOMPILE ?? {
  1337: "0x0000053900000000000000000000000001200000", // USDC
  1984: "0x000007C000000000000000000000000001200000", // USDt
}[ASSET_ID];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];

function loadKey() {
  for (const k of ["BURNER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]) if (process.env[k]) return process.env[k];
  const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = env.match(/^(?:BURNER_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)=(.+)$/m);
  if (!m) throw new Error("no BURNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY (env or .env)");
  return m[1].trim();
}

async function main() {
  if (!PRECOMPILE) throw new Error(`no ERC20 precompile known for asset ${ASSET_ID} — set TOKEN_PRECOMPILE`);
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(loadKey(), provider);
  const api = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
  const token = new ethers.Contract(PRECOMPILE, ERC20_ABI, provider);

  try {
    const burner = wallet.address;
    const fallback = fallbackAccountId(burner);
    const sym = await token.symbol().catch(() => `asset${ASSET_ID}`);
    const pas0 = await provider.getBalance(burner);
    const tok0 = await token.balanceOf(burner);
    console.log(`Burner:   ${burner}`);
    console.log(`Fallback: ${fallback}  (swap origin + sendTo)`);
    console.log(`Balances: ${ethers.formatEther(pas0)} PAS · ${ethers.formatUnits(tok0, TOKEN_DEC)} ${sym}`);
    console.log(`Goal:     end up with +${NEED} ${sym} (asset ${ASSET_ID}), keep ${GAS_RESERVE} PAS for gas\n`);

    // 1. live price from the local asset-conversion pool
    const price = await priceNativePerToken(ASSET_ID, TOKEN_DEC, { api });
    if (!price) throw new Error(`no asset-conversion pool / liquidity for asset ${ASSET_ID}`);
    console.log(`1. price: 1 ${sym} = ${Number(price.num) / Number(price.den)} PAS  (${price.num}/${price.den})`);

    // 2. plan the coverage swap (exact-out: buy exactly NEED, bound PAS in)
    const plan = planCoverage({
      haveNativeWei: pas0, needTokenWei: ethers.parseUnits(NEED, TOKEN_DEC),
      gasReserveNativeWei: ethers.parseEther(GAS_RESERVE),
      tokenDecimals: TOKEN_DEC, nativeDecimals: 18, price,
    });
    if (!plan) throw new Error("planCoverage returned null (nothing to swap / no price)");
    if (!plan.ok) throw new Error(`burner underfunded: needs ~${ethers.formatEther(plan.shortfallNativeWei)} PAS more (after the ${GAS_RESERVE} PAS gas reserve)`);
    console.log(`2. plan: buy ${ethers.formatUnits(plan.amountOut, TOKEN_DEC)} ${sym} for ≤ ${ethers.formatEther(plan.amountInMax)} PAS (mid ${ethers.formatEther(plan.needNativeEstWei)}); keep ≥ ${ethers.formatEther(plan.keepNativeWei)} PAS`);

    // 3. encode against live metadata + sanity-decode (the tx calldata)
    const data = encodeSwapCall(api, plan, { assetId: ASSET_ID, sendTo: fallback });
    const decoded = api.registry.createType("Call", data);
    console.log(`3. calldata → ${RUNTIME_PALLETS_ADDR}  (${(data.length - 2) / 2} bytes)`);
    console.log(`   decodes to ${decoded.section}.${decoded.method}, amountInMax(10-dp)=${decoded.args[2].toString()}`);

    if (DRY) { console.log("\n(DRY) plan + encode verified; no transaction sent."); return; }

    // 4. execute — one EVM tx from the burner, dispatched under its fallback origin
    console.log(`\n4. submitting swap EVM tx…`);
    const res = await executeSwap(plan, { signer: wallet, assetId: ASSET_ID, api, gasLimit: 2_000_000n });
    console.log(`   ✓ tx ${res.txHash}`);

    // 5. confirm by EFFECT (balance rise), not just the receipt — RPC may lag
    let tok1 = tok0, pas1 = pas0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      tok1 = await token.balanceOf(burner);
      if (tok1 > tok0) break;
    }
    pas1 = await provider.getBalance(burner);
    const gained = tok1 - tok0, spent = pas0 - pas1;
    console.log(`5. after: ${ethers.formatEther(pas1)} PAS · ${ethers.formatUnits(tok1, TOKEN_DEC)} ${sym}`);
    console.log(`   Δ ${sym}: +${ethers.formatUnits(gained, TOKEN_DEC)}   Δ PAS: -${ethers.formatEther(spent)} (swap + gas)`);
    if (gained <= 0n) throw new Error("token balance did not rise — swap did not land (check the tx on-chain)");
    console.log(`\n✅ COVERAGE SWAP CONFIRMED: burner turned shielded PAS into ${ethers.formatUnits(gained, TOKEN_DEC)} ${sym} via the local DEX — one EVM tx, no substrate key.`);
  } finally {
    await api.disconnect().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌ COVERAGE-SWAP PROBE FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
