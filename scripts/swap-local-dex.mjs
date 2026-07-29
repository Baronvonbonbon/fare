#!/usr/bin/env node
// Swap PAS -> a real Asset Hub asset (USDC) on Asset Hub's OWN asset-conversion
// DEX, submitted from an EVM key. No XCM hop to another chain, no faucet, no
// mock token.
//
// Why this exists: FARE's escrow token used to be MockUSDC, an EVM-only ERC-20
// with an open `mint`. That is fine for a demo and wrong for anything else — it
// is not a real asset, cannot be XCM'd, and "get some" meant minting yourself
// money. Real Asset Hub USDC (asset 1337) has none of those problems, but it has
// no faucet either, so sourcing a balance needs a swap.
//
// How it reaches the DEX. docs/RELAY-TREASURY.md left this as a TBD: "an
// asset-conversion precompile callable from the EVM relay (TBD — probe the
// precompiles) or a substrate signer". Probing the precompile space finds only
// two contracts with code — the XCM precompile at 0x…0a0000 and 0x…0900 — so
// there is NO asset-conversion precompile and the direct call does not exist.
//
// The XCM precompile is the way in. XCM has an `ExchangeAsset` instruction, and
// Asset Hub wires its AssetExchanger to asset-conversion, so a locally-executed
// XCM program does the swap on the same chain:
//
//     WithdrawAsset(PAS)  ->  ExchangeAsset{give PAS, want USDC}  ->  DepositAsset
//
// executed via `execute(bytes,Weight)` under the caller's own origin. pallet-revive
// maps the EVM address H160 to AccountId32 as `H160 ++ 0xEE*12`, which is both
// where the PAS comes from and where the USDC lands — so the ERC-20 precompile
// view of asset 1337 shows the proceeds at the same EVM address immediately.
//
// The chain requires XCM **v5** ("Only XCM version 5 and onwards are supported"),
// and `execute` takes a Weight STRUCT (refTime, proofSize), not a bare uint64 —
// passing one encodes wrong and reverts as OUT_OF_MEMORY, which is a decode
// failure wearing a confusing name.
//
// Usage:
//   node scripts/swap-local-dex.mjs            # swap for the default 25 USDC
//   WANT_USDC=40 node scripts/swap-local-dex.mjs
//   DRY_RUN=1 node scripts/swap-local-dex.mjs  # quote + simulate, send nothing
import { ApiPromise, WsProvider } from "@polkadot/api";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const AH_WSS = process.env.AH_WSS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
const XCM_PRECOMPILE = "0x00000000000000000000000000000000000a0000";

const ASSET_ID = BigInt(process.env.ASSET_ID ?? 1337);        // 1337 = USDC, 1984 = USDt
const TOKEN_DP = Number(process.env.TOKEN_DP ?? 6);
const WANT = BigInt(Math.round(Number(process.env.WANT_USDC ?? 25) * 10 ** TOKEN_DP));
// Slippage headroom on the PAS side: quote, then allow this much more in.
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? 500); // 5%
const DRY_RUN = process.env.DRY_RUN === "1";

/// The ERC-20 precompile view of an Asset Hub asset: 4-byte asset id, then the
/// `0x0120_0000` marker. This is how the EVM sees a pallet-assets balance.
const erc20For = (assetId) =>
  ethers.getAddress("0x" + assetId.toString(16).padStart(8, "0") + "0".repeat(24) + "01200000".padStart(8, "0"));

const log = (...a) => console.log(...a);

async function main() {
  const prov = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const key = process.env.DEPLOYER_PRIVATE_KEY
    ?? fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m)[1].trim();
  const me = new ethers.Wallet(key, prov);
  // pallet-revive's H160 -> AccountId32 mapping. Both the source of the PAS and
  // the beneficiary of the USDC.
  const mapped = me.address.toLowerCase() + "ee".repeat(12);

  const token = erc20For(ASSET_ID);
  const erc = new ethers.Contract(token, [
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ], prov);
  const sym = await erc.symbol().catch(() => `asset ${ASSET_ID}`);
  const before = await erc.balanceOf(me.address);
  const fmtT = (v) => (Number(v) / 10 ** TOKEN_DP).toFixed(TOKEN_DP);

  log(`account   ${me.address}`);
  log(`mapped    0x${mapped.replace(/^0x/, "")}`);
  log(`token     ${token}  (${sym}, asset ${ASSET_ID}, ${TOKEN_DP}dp)`);
  log(`balance   ${fmtT(before)} ${sym}  ·  ${ethers.formatEther(await prov.getBalance(me.address))} PAS\n`);

  // ── quote on the local DEX ────────────────────────────────────────────────
  const api = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
  let givePas;
  try {
    const nativeDp = api.registry.chainDecimals[0]; // PAS is 10dp on substrate, 18 in the EVM
    const PAS_LOC = { parents: 1, interior: "Here" };
    const TOKEN_LOC = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: ASSET_ID }] } };
    const q = await api.call.assetConversionApi.quotePriceTokensForExactTokens(
      PAS_LOC, TOKEN_LOC, WANT.toString(), true
    );
    const quoted = BigInt(q.toJSON() ?? 0);
    if (quoted <= 0n) throw new Error(`no pool/liquidity for asset ${ASSET_ID}`);
    givePas = (quoted * (10_000n + SLIPPAGE_BPS)) / 10_000n;
    log(`quote     ${fmtT(WANT)} ${sym} costs ${Number(quoted) / 10 ** nativeDp} PAS`);
    log(`offering  ${Number(givePas) / 10 ** nativeDp} PAS (+${SLIPPAGE_BPS}bps slippage)\n`);
  } finally { await api.disconnect().catch(() => {}); }

  // ── build the XCM (v5 — the chain rejects v4 and below) ───────────────────
  const api2 = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
  let hex;
  try {
    const PAS_LOC = { parents: 1, interior: "Here" };
    const TOKEN_LOC = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: ASSET_ID }] } };
    hex = api2.registry.createType("XcmVersionedXcm", {
      V5: [
        { WithdrawAsset: [{ id: PAS_LOC, fun: { Fungible: givePas } }] },
        // maximal:false → take exactly `want` and refund the rest of the PAS,
        // so an over-offer is returned rather than swallowed by the pool.
        { ExchangeAsset: {
            give: { Definite: [{ id: PAS_LOC, fun: { Fungible: givePas } }] },
            want: [{ id: TOKEN_LOC, fun: { Fungible: WANT } }],
            maximal: false,
        } },
        { DepositAsset: {
            assets: { Wild: "All" },
            beneficiary: { parents: 0, interior: { X1: [{ AccountId32: { network: null, id: mapped } }] } },
        } },
      ],
    }).toHex();
  } finally { await api2.disconnect().catch(() => {}); }

  const iface = new ethers.Interface([
    "function weighMessage(bytes message) view returns (uint64 refTime, uint64 proofSize)",
    "function execute(bytes message, (uint64 refTime, uint64 proofSize) weight)",
  ]);

  const w = iface.decodeFunctionResult(
    "weighMessage",
    await prov.call({ to: XCM_PRECOMPILE, data: iface.encodeFunctionData("weighMessage", [hex]) })
  );
  const weight = [w[0], w[1]];
  log(`weight    refTime=${w[0]} proofSize=${w[1]}`);

  const data = iface.encodeFunctionData("execute", [hex, weight]);
  await prov.call({ to: XCM_PRECOMPILE, data, from: me.address }); // reverts here if it would fail
  log(`simulated OK`);

  if (DRY_RUN) { log("\nDRY_RUN=1 — nothing sent."); return; }

  const tx = await me.sendTransaction({ to: XCM_PRECOMPILE, data, gasLimit: 2_000_000n });
  log(`\nswap tx   ${tx.hash}`);
  await tx.wait();

  const after = await erc.balanceOf(me.address);
  log(`balance   ${fmtT(before)} → ${fmtT(after)} ${sym}  (+${fmtT(after - before)})`);
  if (after <= before) throw new Error("swap mined but the token balance did not increase");
  log(`\nSwapped on Asset Hub's own asset-conversion DEX. No mock, no faucet, no XCM hop.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
