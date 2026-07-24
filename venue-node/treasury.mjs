// Relay treasury / fee-recovery swaps (venue-node).
//
// THE PROBLEM this solves: a gasless TOKEN order pays the relay its F6 rebate in
// the order token (e.g. USDC), but the relay spends gas in NATIVE (PAS/DOT). So
// its native balance only ever drops while USDC accrues — it runs out of gas.
// This module (a) prices the token rebate in native so the profitability guard
// can actually decide "does the fee cover gas?" (see economics.tokenToNativeWei),
// and (b) auto-recovers: when native gas dips below a floor, swap accrued token
// fees → native via Hydration's omnipool, bridged with Paraspell's XCM Router.
//
// Target (verified reachable): Hydration Paseo testnet
//   RPC wss://paseo-rpc.play.hydration.cloud ; Paraspell XCM Router supports
//   Paseo + Hydration. Submission uses the Asset Hub EVM **XCM precompile** so the
//   relay's existing EVM key drives it (no separate substrate signer) — Asset Hub
//   pallet-revive exposes XCM-category precompiles.
//
// LIVE-SWAP PREREQUISITE: the fee token must be a real Asset Hub *asset*
// (pallet-assets, seen from EVM via its ERC-20 precompile) to be XCM-transferable.
// Our EVM-only MockUSDC cannot be XCM'd — swap `execute` is therefore gated and
// unit-tested against a mock; the pure planning/pricing below is the live part.
import { tokenToNativeWei } from "./economics.mjs";

// ── config ───────────────────────────────────────────────────────────────────
export const SWAP_ENABLED = (process.env.SWAP_ENABLED || "off").toLowerCase() === "on";
export const HYDRATION_RPC = process.env.HYDRATION_RPC || "wss://paseo-rpc.play.hydration.cloud";
// Gas-management thresholds (PAS).
export const cfg = {
  floorWei: pas(process.env.GAS_FLOOR_PAS || "50"),     // top up when native < floor
  targetWei: pas(process.env.GAS_TARGET_PAS || "200"),  // swap enough to reach ~target
  reserveWei: pas(process.env.GAS_RESERVE_PAS || "5"),  // never spend below this (XCM fees)
  minSwapToken: BigInt(process.env.MIN_SWAP_TOKEN_UNITS || "0"), // don't swap dust (token smallest units)
  pollMs: Number(process.env.SWAP_POLL_MS || 300_000),
};
function pas(s) { return BigInt(Math.round(Number(s) * 1e6)) * 10n ** 12n; } // PAS(18) via 1e6 fixed-point

// Fallback price (whole native per whole token) as an exact fraction {num, den};
// null when unset. Read dynamically so a live quote / config change takes effect.
// e.g. RELAY_TOKEN_PRICE="0.5" ⇒ 1 USDC = 0.5 PAS.
export function priceFraction(str = process.env.RELAY_TOKEN_PRICE || "") {
  if (!str) return null;
  const [w, f = ""] = String(str).split(".");
  const den = 10n ** BigInt(f.length);
  return { num: BigInt(w + f), den };
}

// ── currency-aware valuation (feeds the economics guard) ─────────────────────
/// Value a token rebate (token smallest units) in native wei, using a live quote
/// if `quote` is given ({num,den} native-per-whole-token) else the config price.
/// Returns null when no price is available — the caller should then DECLINE token
/// settlements (it can't prove coverage) rather than guess.
export function rebateInNative(tokenWei, tokenDecimals, nativeDecimals, quote) {
  const p = quote ?? priceFraction();
  if (!p) return null;
  return tokenToNativeWei(tokenWei, tokenDecimals, nativeDecimals, p.num, p.den);
}

// ── pure top-up planning (unit-tested) ───────────────────────────────────────
export function shouldTopUp(gasWei, floorWei = cfg.floorWei) {
  return BigInt(gasWei) < BigInt(floorWei);
}

/// Decide how much TOKEN to swap: enough native to reach `target` from the current
/// balance, converted to token at `price` (native-per-whole-token {num,den}),
/// capped by the fee balance available (minus nothing — the token isn't gas), and
/// only if it clears `minSwapToken`. Returns { swapTokenWei, wantNativeWei } or
/// null (nothing to do). `reserveWei` guards the native we must keep for XCM fees.
export function planSwap({ gasWei, feeTokenWei, tokenDecimals, nativeDecimals, price, target = cfg.targetWei, minSwapToken = cfg.minSwapToken }) {
  if (!price) return null;
  const deficit = BigInt(target) - BigInt(gasWei);
  if (deficit <= 0n) return null;
  // token needed = nativeWei / (price · 10^(nd-td))  →  tokenWei = deficit·den·10^(td-nd)/num
  let n = deficit * BigInt(price.den);
  let d = BigInt(price.num);
  const shift = BigInt(tokenDecimals) - BigInt(nativeDecimals);
  if (shift >= 0n) n *= 10n ** shift; else d *= 10n ** -shift;
  const needTokenWei = d === 0n ? 0n : n / d;
  const swapTokenWei = needTokenWei < BigInt(feeTokenWei) ? needTokenWei : BigInt(feeTokenWei);
  if (swapTokenWei < BigInt(minSwapToken) || swapTokenWei <= 0n) return null;
  return { swapTokenWei, wantNativeWei: tokenToNativeWei(swapTokenWei, tokenDecimals, nativeDecimals, price.num, price.den) };
}

// ── swap execution (live path — gated + lazy) ────────────────────────────────
/// Get a live native-per-whole-token quote from Hydration via Paraspell's XCM
/// Router (best amount out), as a {num,den} fraction. Lazy-imports Paraspell so
/// the venue-node runs without the dep unless swaps are enabled.
export async function hydrationQuote({ feeToken, feeTokenSymbol, nativeSymbol, sampleTokenWei, tokenDecimals, nativeDecimals }) {
  const { RouterBuilder } = await import("@paraspell/xcm-router"); // needs: npm i @paraspell/xcm-router
  const out = await RouterBuilder()
    .from("AssetHubPolkadot").exchange("HydrationDex").to("AssetHubPolkadot")
    .currencyFrom({ symbol: feeTokenSymbol }).currencyTo({ symbol: nativeSymbol })
    .amount(sampleTokenWei.toString())
    .getBestAmountOut(); // { amountOut } in native smallest units
  // price(native per whole token) = (amountOut/10^nd) / (sample/10^td)
  const num = BigInt(out.amountOut) * 10n ** BigInt(tokenDecimals);
  const den = BigInt(sampleTokenWei) * 10n ** BigInt(nativeDecimals);
  return { num, den };
}

/// Execute a fee-recovery swap: token → native via Hydration, delivered back to
/// the relay on Asset Hub. The user-chosen submission model is the Asset Hub EVM
/// **XCM precompile** (relay's EVM key). Paraspell builds the route/message; the
/// precompile `send`s it. GATED: throws unless SWAP_ENABLED and a real
/// XCM-transferable fee asset + precompile wiring are configured — kept explicit
/// rather than silently no-op'ing money movement.
export async function executeSwap(_plan, _ctx) {
  if (!SWAP_ENABLED) throw new Error("swaps disabled (set SWAP_ENABLED=on)");
  throw new Error(
    "executeSwap: live Hydration swap not wired for the current fee token. " +
    "Prereqs: (1) the fee token must be a real Asset Hub asset (pallet-assets, ERC-20 precompile) — MockUSDC is EVM-only and not XCM-transferable; " +
    "(2) submit via the Asset Hub XCM precompile from the relay EVM account (Paraspell builds the route, precompile sends). See docs/RELAY-TREASURY.md."
  );
}

/// Orchestrate one top-up cycle: if native gas is below floor, quote + plan +
/// (if enabled/wired) execute. `ctx` supplies live reads/exec. Returns a summary.
export async function topUpCycle(ctx) {
  const gasWei = await ctx.nativeBalance();
  if (!shouldTopUp(gasWei, cfg.floorWei)) return { skipped: "gas above floor", gas: gasWei };
  const feeTokenWei = await ctx.feeTokenBalance();
  const price = (SWAP_ENABLED && ctx.quote) ? await ctx.quote().catch(() => null) : (priceFraction());
  const plan = planSwap({ gasWei, feeTokenWei, tokenDecimals: ctx.tokenDecimals, nativeDecimals: ctx.nativeDecimals, price });
  if (!plan) return { skipped: "no plan (price/fees/min)", gas: gasWei, feeTokenWei: feeTokenWei.toString() };
  if (!SWAP_ENABLED || !ctx.execute) return { planned: plan, executed: false, reason: "SWAP_ENABLED off or no executor" };
  const res = await ctx.execute(plan);
  return { planned: plan, executed: true, res };
}
