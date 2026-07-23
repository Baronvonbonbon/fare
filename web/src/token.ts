// Stablecoin (ERC-20) escrow support for the PWA (C3). The protocol accepts a
// single owner-approved stablecoin as an alternative to native PAS; an order
// carries its escrow `token` (address(0) = native). This module resolves that
// token's metadata and formats/parses amounts at its decimals, so the same UI
// renders PAS (18-dec) or USDC (6-dec) orders correctly.
//
// Feature-gated on `ADDRESSES.stablecoin` (written by the deploy script): with
// no stablecoin in the address book, token orders are simply hidden — the same
// additive-contract pattern as ratings.

import { Contract, ethers } from "ethers";
import { ADDRESSES, readProvider } from "./chain";
import { ERC20_ABI } from "./abi";

export interface Asset {
  address: string; // address(0) for native
  symbol: string;
  decimals: number;
  isToken: boolean;
}

const NATIVE: Asset = { address: ethers.ZeroAddress, symbol: "PAS", decimals: 18, isToken: false };

// Cached stablecoin metadata. Seeded synchronously from the address book (with a
// USDC/6-dec assumption) and refined by an eager on-chain read of symbol/decimals.
let stableMeta: Asset | null = ADDRESSES.stablecoin
  ? { address: ADDRESSES.stablecoin, symbol: "USDC", decimals: 6, isToken: true }
  : null;

if (ADDRESSES.stablecoin) {
  new Contract(ADDRESSES.stablecoin, ERC20_ABI, readProvider)
    .symbol()
    .then(async (symbol: string) => {
      const decimals = Number(await new Contract(ADDRESSES.stablecoin, ERC20_ABI, readProvider).decimals());
      stableMeta = { address: ADDRESSES.stablecoin, symbol, decimals, isToken: true };
    })
    .catch(() => {/* keep the USDC/6 assumption */});
}

/// Is a stablecoin configured for this deployment (→ show token-order controls)?
export function tokenOrdersEnabled(): boolean {
  return !!ADDRESSES.stablecoin;
}

/// The configured stablecoin asset, or null when none is deployed.
export function stablecoinAsset(): Asset | null {
  return stableMeta;
}

/// Resolve an order's escrow `token` address to its Asset (native or the stablecoin).
export function assetOf(token?: string): Asset {
  if (!token || token === ethers.ZeroAddress) return NATIVE;
  if (stableMeta && token.toLowerCase() === stableMeta.address.toLowerCase()) return stableMeta;
  return { address: token, symbol: "TOKEN", decimals: 18, isToken: true }; // unknown token, safe default
}

/// Format a wei amount at the asset's decimals, with symbol (e.g. "10 USDC").
export function fmtAsset(v: bigint, token?: string): string {
  const a = assetOf(token);
  const s = ethers.formatUnits(v, a.decimals);
  const trimmed = s.includes(".") ? s.replace(/(\.\d{4})\d+$/, "$1").replace(/\.?0+$/, "") || "0" : s;
  return `${trimmed} ${a.symbol}`;
}

/// Parse a decimal string at the asset's decimals ("" → 0).
export function parseAsset(v: string, token?: string): bigint {
  return ethers.parseUnits(v === "" ? "0" : v, assetOf(token).decimals);
}

// ── testnet stablecoin faucet ────────────────────────────────────────────────
// MockUSDC exposes an open `mint`, so a fresh per-order burner can self-mint the
// stablecoin escrow it needs — the token analogue of the PAS gas faucet, with no
// link to the customer's main wallet. On mainnet the real USDC has no such mint;
// funding a burner privately is the shielded-funding path (C4, docs/SHIELDED-FUNDING.md).
const MINT_ABI = ["function mint(address to, uint256 amount)"];

/// Mint `amount` of the stablecoin to `to`, signed by `signer` (the burner).
export async function mintStablecoin(signer: ethers.Signer, to: string, amount: bigint): Promise<void> {
  const c = new Contract(ADDRESSES.stablecoin, MINT_ABI, signer);
  const tx = await c.mint(to, amount);
  await tx.wait();
}

/// Approve `spender` to pull `amount` of `token` from `signer`.
export async function approveToken(
  signer: ethers.Signer,
  token: string,
  spender: string,
  amount: bigint
): Promise<void> {
  const c = new Contract(token, ERC20_ABI, signer);
  const tx = await c.approve(spender, amount);
  await tx.wait();
}

/// A signer-bound stablecoin balance read.
export async function stablecoinBalance(account: string): Promise<bigint> {
  if (!ADDRESSES.stablecoin) return 0n;
  try {
    return await new Contract(ADDRESSES.stablecoin, ERC20_ABI, readProvider).balanceOf(account);
  } catch {
    return 0n;
  }
}
