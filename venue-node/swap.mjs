// Asset-conversion cost-coverage layer — turn shielded PAS into exactly the
// assets an order costs (gas + fare + tip), on FARE's own chain, no XCM.
//
// WHY THIS EXISTS. The live Kusama Shield pool on Paseo is NATIVE-PAS ONLY
// (`depositNative`), so a shielded burner arrives holding PAS. But FARE orders
// escrow in USDC. The combined e2e (docs/E2E-COMBINED-REPORT.md) shields the gas
// but leaves the escrow **USDC value linkable** — its "one genuinely-new mainnet
// gap". This layer closes it: everything shields as the ONE asset the pool
// supports (PAS), then the burner fans that PAS out via the local
// `asset-conversion` DEX into exactly what each cost needs —
//   keep PAS for gas · swap PAS→USDC for fare+tip
// so the USDC now originates from a burner-side swap of shielded PAS, not from a
// `main→burner` transfer. No new pool, no XCM, no Hydration.
//
// EXECUTION MODEL (the key enabler). asset-conversion is a SUBSTRATE pallet, but
// the burner is an EVM account. It drives the swap WITHOUT a separate substrate
// key via `revive.ethSubstrateCall(call, txEncoded)` — pallet-revive dispatches a
// Substrate runtime call under the caller's MAPPED `Signed` origin (the burner
// must be `revive.mapAccount`-ed first). There is NO asset-conversion precompile
// (only per-asset ERC20 precompiles via AssetsPrecompiles), so ethSubstrateCall is
// the path. Pure quote + planning below are live/tested; `executeSwap` is the
// gated seam that builds the SCALE-encoded call and submits it — see the stub.
//
// See also: economics.mjs (tokenToNativeWei), treasury.mjs (relay-side
// fee-recovery, which uses the same DEX in the other direction: USDC→PAS).
import { tokenToNativeWei } from "./economics.mjs";

export const AH_WSS = process.env.AH_WSS || "wss://asset-hub-paseo-rpc.n.dwellir.com";

// ── XCM-location helpers (the asset-conversion pallet keys pools by location) ──
export const NATIVE_LOC = { parents: 1, interior: "Here" };            // PAS (relay token)
export const assetLoc = (assetId) => ({ parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: assetId }] } });

// ── live quote (read-only, no signer) ────────────────────────────────────────
/// Generalized asset-conversion quote: how many out-units for `amountIn` in-units
/// along `path` (array of XCM locations, ≥2). Uses the runtime API
/// `quotePriceExactTokensForTokens`, include-fee=true (the amount actually
/// deliverable after the pool fee). Returns a BigInt (out smallest-units) or null
/// (no pool / no liquidity). Lazy-imports @polkadot/api so the venue-node runs
/// without it unless a swap/quote is requested.
export async function quoteExactIn(path, amountIn, { api: injected } = {}) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("path needs ≥2 locations");
  const api = injected ?? await connect();
  try {
    // pallet quotes pairwise; for a 2-hop path chain the quotes.
    let amt = BigInt(amountIn);
    for (let i = 0; i + 1 < path.length; i++) {
      const out = await api.call.assetConversionApi.quotePriceExactTokensForTokens(path[i], path[i + 1], amt.toString(), true);
      const v = out?.toJSON?.();
      if (v == null) return null;
      amt = BigInt(v);
      if (amt <= 0n) return null;
    }
    return amt;
  } finally { if (!injected) await api.disconnect().catch(() => {}); }
}

/// Native (PAS) per 1 whole token, as an exact {num,den} fraction for the
/// economics guard (feeds economics.tokenToNativeWei) — the recommended price
/// source. Direction token→native. `tokenDecimals` sizes the "1 whole token".
export async function priceNativePerToken(assetId, tokenDecimals = 6, opts = {}) {
  const api = opts.api ?? await connect();
  try {
    const nativeDec = api.registry.chainDecimals[0]; // PAS = 10 on substrate
    const oneToken = 10n ** BigInt(tokenDecimals);
    const out = await quoteExactIn([assetLoc(assetId), NATIVE_LOC], oneToken, { api });
    if (out == null || out <= 0n) return null;
    return { num: out, den: 10n ** BigInt(nativeDec) };
  } finally { if (!opts.api) await api.disconnect().catch(() => {}); }
}

async function connect() {
  const { ApiPromise, WsProvider } = await import("@polkadot/api"); // npm i @polkadot/api
  return ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
}

// ── pure coverage planning (unit-tested, no I/O) ─────────────────────────────
/// Given a shielded burner holding `haveNativeWei` PAS, plan the swap that leaves
/// it able to pay an order: keep `gasReserveNativeWei` PAS for gas, and obtain
/// exactly `needTokenWei` of the order token (fare + tip) by swapping PAS→token.
///
/// Uses EXACT-OUT (`swapTokensForExactTokens`) so the burner ends with precisely
/// the escrow amount; `amountInMax` bounds slippage. `price` is native-per-whole-
/// token {num,den} (from priceNativePerToken). All amounts smallest-units.
///
/// Returns:
///   { ok:true,  method, amountOut, amountInMax, keepNativeWei, needNativeEstWei }
///   { ok:false, shortfallNativeWei, needNativeEstWei }   // burner underfunded
///   null                                                 // nothing to swap
export function planCoverage({
  haveNativeWei, needTokenWei, gasReserveNativeWei = 0n,
  tokenDecimals, nativeDecimals, price, slippageBps = 100, minSwapNativeWei = 0n,
}) {
  if (!price) return null;
  const need = BigInt(needTokenWei);
  if (need <= 0n) return null; // no token cost to cover (e.g. a native-only order)

  // PAS the swap would consume for `need` token, at the mid price, plus slippage.
  const needNativeEstWei = tokenToNativeWei(need, tokenDecimals, nativeDecimals, price.num, price.den);
  const amountInMax = (needNativeEstWei * BigInt(10_000 + slippageBps)) / 10_000n;
  if (amountInMax < BigInt(minSwapNativeWei)) return null; // dust

  const spendable = BigInt(haveNativeWei) - BigInt(gasReserveNativeWei);
  if (spendable < amountInMax) {
    return { ok: false, shortfallNativeWei: amountInMax - (spendable > 0n ? spendable : 0n), needNativeEstWei };
  }
  return {
    ok: true,
    method: "swapTokensForExactTokens",
    amountOut: need,                                   // exact token out (fare+tip), token dp
    amountInMax,                                       // slippage bound on PAS in, in `nativeDecimals`
    nativeDecimals: Number(nativeDecimals),            // dp of amountInMax/keep (EVM view = 18)
    keepNativeWei: BigInt(haveNativeWei) - amountInMax, // worst-case PAS left (≥ gasReserve)
    needNativeEstWei,
  };
}

/// Rescale an integer amount between decimal bases. Rounding up is for UPPER
/// bounds (amountInMax) so truncation never makes the bound too tight to fill.
export function scaleAmount(amount, fromDecimals, toDecimals, roundUp = false) {
  const shift = BigInt(toDecimals) - BigInt(fromDecimals);
  if (shift === 0n) return BigInt(amount);
  if (shift > 0n) return BigInt(amount) * 10n ** shift;
  const d = 10n ** -shift;
  const q = BigInt(amount) / d, r = BigInt(amount) % d;
  return roundUp && r > 0n ? q + 1n : q;
}

/// Human-readable descriptor of the swap call (pure — for inspection/tests; the
/// wire encoding is `encodeSwapCall`, which also rescales native decimals). `sendTo`
/// is the burner's FALLBACK AccountId32 (`fallbackAccountId`) so the bought token
/// lands back on the burner. `amountInMax` here is in the plan's (EVM 18-dp) view.
export function buildSwapDescriptor(plan, { assetId, sendTo }) {
  if (!plan?.ok) throw new Error("buildSwapDescriptor: plan not ok");
  return {
    pallet: "assetConversion",
    method: plan.method, // swapTokensForExactTokens
    args: {
      path: [NATIVE_LOC, assetLoc(assetId)],           // PAS → token
      amountOut: plan.amountOut.toString(),
      amountInMax: plan.amountInMax.toString(),
      sendTo,
      keepAlive: false,
    },
  };
}

// ── EVM → substrate dispatch (the ethSubstrateCall rail) ─────────────────────
// pallet-revive routes an EVM tx whose `to` is the sentinel RUNTIME_PALLETS_ADDR
// by decoding its calldata as a SCALE-encoded RuntimeCall and dispatching it under
// `RawOrigin::Signed(to_fallback_account_id(signer))` (source: revive lib.rs
// ~2279 + runtime.rs ~381). So the burner's EVM key drives a substrate swap with
// NO substrate key and NO mapAccount — the origin is the burner's fallback account
// (`H160 ++ 0xEE×12`), which is exactly where its shielded PAS lands.
export const RUNTIME_PALLETS_ADDR = "0x6d6f646c70792f70616464720000000000000000"; // PalletId("py/paddr")

/// Fallback AccountId32 that an EVM address controls: the 20-byte address followed
/// by 12 bytes of 0xEE. This is the origin of any RUNTIME_PALLETS_ADDR dispatch it
/// signs, and thus where its native balance + any `sendTo`-returned token live.
export function fallbackAccountId(h160) {
  const a = String(h160).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`bad H160 address: ${h160}`);
  return "0x" + a + "ee".repeat(12);
}

/// SCALE-encode the `assetConversion.swapTokensForExactTokens` RuntimeCall for a
/// coverage plan, as the calldata to send to RUNTIME_PALLETS_ADDR. Uses the live
/// metadata (via `api`) to encode the XCM locations + args correctly — returns a
/// 0x hex string (`call.method.toHex()`). Pure w.r.t. chain state (no submission).
export function encodeSwapCall(api, plan, { assetId, sendTo }) {
  if (!plan?.ok) throw new Error("encodeSwapCall: plan not ok");
  // The pallet denominates native PAS in the chain's decimals (10-dp) — but the
  // plan's amountInMax is in its EVM view (18-dp). Rescale the NATIVE amount to
  // substrate units (round up: it's an upper bound). The token amountOut shares
  // decimals across EVM/substrate (asset dp), so it passes through unchanged.
  const subNativeDec = api.registry.chainDecimals[0];
  const amountInMaxSub = scaleAmount(plan.amountInMax, plan.nativeDecimals ?? 18, subNativeDec, true);
  const call = api.tx.assetConversion.swapTokensForExactTokens(
    [NATIVE_LOC, assetLoc(assetId)], // PAS → token
    plan.amountOut.toString(),       // exact token out (fare + tip), token dp
    amountInMaxSub.toString(),       // slippage-bounded PAS in, substrate (10-dp)
    sendTo,                          // burner's fallback AccountId32
    false,                           // keepAlive: a burner is disposable
  );
  return call.method.toHex();
}

// ── swap execution (live path — lazy deps) ───────────────────────────────────
/// Execute the coverage swap FROM the EVM burner, no substrate key. Steps:
///   1. build + SCALE-encode assetConversion.swapTokensForExactTokens (encodeSwapCall);
///   2. send an EVM tx { to: RUNTIME_PALLETS_ADDR, data: <encoded call>, value: 0 }
///      signed by the burner (ethers Signer) — revive dispatches it under the
///      burner's fallback origin, spending its PAS and returning USDC to `sendTo`.
///
/// ctx: { signer (ethers Signer, required), assetId (required),
///        api? (@polkadot/api ApiPromise — else one is opened on AH_WSS and closed),
///        sendTo? (defaults to the burner's fallback AccountId32),
///        gasLimit? } . Returns { txHash, sendTo, amountOut, amountInMax }.
export async function executeSwap(plan, ctx = {}) {
  if (!plan?.ok) throw new Error("executeSwap: plan not ok (see planCoverage)");
  const { signer, assetId } = ctx;
  if (!signer || typeof signer.sendTransaction !== "function") throw new Error("executeSwap: ctx.signer (ethers Signer) required");
  if (assetId == null) throw new Error("executeSwap: ctx.assetId required");

  const burner = await signer.getAddress();
  const sendTo = ctx.sendTo ?? fallbackAccountId(burner);
  const api = ctx.api ?? await connect();
  try {
    const data = encodeSwapCall(api, plan, { assetId, sendTo });
    const tx = await signer.sendTransaction({
      to: RUNTIME_PALLETS_ADDR, data, value: 0n,
      ...(ctx.gasLimit ? { gasLimit: ctx.gasLimit } : {}),
    });
    await tx.wait();
    return { txHash: tx.hash, sendTo, amountOut: plan.amountOut.toString(), amountInMax: plan.amountInMax.toString() };
  } finally { if (!ctx.api) await api.disconnect().catch(() => {}); }
}
