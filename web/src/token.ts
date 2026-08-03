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
import { ADDRESSES, readProvider, CHAIN_ID } from "./chain";
import { ERC20_ABI } from "./abi";
import { relayForward } from "./relay";

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

/// May a customer still escrow in native PAS when a stablecoin is available?
///
/// **Off by default.** Orders default to the stablecoin, and not only because a
/// customer thinks in dollars: the two assets have different privacy properties
/// in practice. Both have a shielded payout path now, but each asset's notes form
/// their OWN anonymity set — separate note tree, separate pool escrow — so
/// offering a free choice splits an already-thin crowd in two and lets a customer
/// pick the smaller one without knowing they did.
///
/// The contract keeps `createOrder` for compatibility and drain; this only stops
/// the app from offering it. Set `VITE_ALLOW_NATIVE_ORDERS=1` to put the selector
/// back — useful when no USDC can be sourced.
export function nativeOrdersEnabled(): boolean {
  if (!ADDRESSES.stablecoin) return true; // nothing else to pay with
  return ((import.meta as any).env?.VITE_ALLOW_NATIVE_ORDERS as string | undefined)?.trim() === "1";
}

/// The configured stablecoin asset, or null when none is deployed.
export function stablecoinAsset(): Asset | null {
  return stableMeta;
}

/// The Asset Hub asset id behind an ERC-20 PRECOMPILE address, which encodes the
/// id in its first 4 bytes followed by a `0x01200000` marker. Returns null for an
/// ordinary contract — a real ERC-20 has no asset id and cannot be shielded as
/// one. Mirrors `assetIdOf` in venue-node/relay.mjs.
///
/// Which of the two forms you need is a live trap: `depositAsset` takes the ID,
/// while the pool's escrow ledger and the note commitment key on the ADDRESS.
export function assetIdOf(token: string): bigint | null {
  const a = String(token).toLowerCase().replace(/^0x/, "");
  if (a.length !== 40 || !a.endsWith("01200000")) return null;
  if (a.slice(8, 32) !== "0".repeat(24)) return null;
  const id = BigInt("0x" + a.slice(0, 8));
  return id > 0n ? id : null;
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
// There is no `mint`. The escrow token is REAL Asset Hub USDC (asset 1337) seen
// through its ERC-20 precompile, so a balance has to be bought, not printed —
// PAS swaps to USDC on Asset Hub's own asset-conversion DEX
// (scripts/swap-local-dex.mjs). The old MockUSDC had an open mint and a burner
// self-minted its own escrow; that made the demo work and made the amounts
// meaningless, and it is gone.
//
// Consequence for the PWA: a per-order burner cannot conjure USDC. It must be
// funded, which on mainnet is the shielded-funding path (C4) and on testnet
// means transferring from an account that swapped for some.

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

/// Sign an EIP-2612 permit (owner → spender) for a token, so no separate approve
/// tx is needed. Returns the split signature + deadline for a *WithPermit call.
export async function signTokenPermit(
  signer: ethers.Signer,
  token: string,
  spender: string,
  value: bigint,
  ttlSecs = 3600
): Promise<{ v: number; r: string; s: string; deadline: bigint; value: bigint }> {
  const c = new Contract(token, [
    "function name() view returns (string)",
    "function nonces(address) view returns (uint256)",
  ], readProvider);
  const owner = await signer.getAddress();
  const [name, nonce] = await Promise.all([c.name(), c.nonces(owner)]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ttlSecs);
  const sig = await (signer as any).signTypedData(
    { name, version: "1", chainId: CHAIN_ID, verifyingContract: token },
    { Permit: [
      { name: "owner", type: "address" }, { name: "spender", type: "address" },
      { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] },
    { owner, spender, value, nonce, deadline }
  );
  const { v, r, s } = ethers.Signature.from(sig);
  return { v, r, s, deadline, value };
}

/// Gasless stablecoin order (Option C): the customer signs a permit + a
/// ForwardRequest and the relay pays ALL gas — no native PAS needed. `orders` is
/// the burner-signer-bound FareOrders handle. Returns a tx-like object (.wait()).
export async function gaslessCreateOrderERC20(
  orders: any,
  token: string,
  p: { venueId: bigint; dropCommit: string; orderValue: bigint; tip: bigint; maxFare: bigint; pickupWindowSecs?: number; deliveryWindowSecs?: number }
): Promise<{ hash?: string; wait: () => Promise<any> }> {
  const permit = await signTokenPermit(orders.runner, token, ADDRESSES.orders, ethers.MaxUint256);
  const args = [
    token, p.venueId, p.dropCommit, p.orderValue, p.tip, p.maxFare,
    p.pickupWindowSecs ?? 0, p.deliveryWindowSecs ?? 0,
    permit.value, permit.deadline, permit.v, permit.r, permit.s,
  ];
  // relayForward encodes + signs the ForwardRequest and posts /forward; the relay
  // pays gas. (Falls back to a direct call only if no forwarder is configured.)
  return relayForward("orders", orders, "createOrderERC20WithPermit", args);
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
