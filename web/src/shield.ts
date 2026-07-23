// Shielded burner funding (integration-plan C4) — the SEAM, not the feature.
//
// Per-order burners (wallets.ts) are only unlinkable while their funding source
// is anonymous. On testnet a shared faucet provides that; on mainnet, funding a
// burner from the customer's main wallet writes an on-chain edge that collapses
// the scheme. C4 is a funding path that breaks that edge — a shielded pool
// withdrawal, or a confidential-transfer primitive on the target chain. Full
// design + why it's blocked on external infra: docs/SHIELDED-FUNDING.md.
//
// This module defines the integration point so the real implementation drops in
// without touching call sites. Until a pool/precompile exists,
// `shieldedFundingAvailable()` is false and callers fall back to today's
// faucet/relay funding (relay.ts `sponsorGas` / `ensureGas`).

import type { DripResult } from "./chain";

/// A backend that can fund a fresh address without linking it to the funder.
/// Implemented against a shielded pool (deposit-once, withdraw-per-order with a
/// ZK note proof) or a confidential-transfer asset — see the design doc.
export interface ShieldedFunder {
  /// Is this funder usable right now (deployed, and the customer holds a
  /// spendable note / shielded balance)?
  available(): Promise<boolean>;

  /// Amortized deposit from the customer's main wallet INTO the pool. Linkable
  /// to main by design (it only reveals "funded the pool by N"), done rarely;
  /// one deposit funds many later orders. Returns the note handle to persist.
  deposit(amountWei: bigint): Promise<ShieldedNote>;

  /// Fund `burner` with `amountWei` by spending a note — a relayer-submitted
  /// pool withdrawal directed at the burner, so no `main → burner` edge exists
  /// and the burner needs no pre-funding for gas. Returns a drip-shaped result
  /// so it slots in beside `sponsorGas`.
  fundBurner(burner: string, amountWei: bigint): Promise<DripResult>;

  /// Shielded refund return: deposit a burner's leftover balance back into the
  /// pool instead of forwarding to main in the clear (the un-linking sibling of
  /// wallets.ts `sweepToMain`).
  shieldedReturn?(burnerKey: string): Promise<void>;
}

/// Opaque spendable note (secret + nullifier + Merkle position). Persisted
/// client-side like an order-wallet record; never leaves the device in clear.
export interface ShieldedNote {
  commitment: string;
  denominationWei: string;
  createdAt: number;
}

// ── active funder registry ───────────────────────────────────────────────────
// A concrete funder registers here once its backend exists. Nothing does yet,
// so the registry is empty and every guard below reports "unavailable".

let active: ShieldedFunder | null = null;

/// Install the shielded funder (called by the concrete backend at init). Kept as
/// a setter so the pool/precompile implementation lands as an additive module.
export function registerShieldedFunder(funder: ShieldedFunder): void {
  active = funder;
}

/// Synchronous capability check for call-site guards. False until a backend is
/// registered — so `shieldedFundingAvailable() ? fundViaShield() : sponsorGas()`
/// is exactly today's behavior until C4 infra exists.
export function shieldedFundingAvailable(): boolean {
  return active !== null;
}

/// Fund `burner` through the shielded path. Throws if no funder is installed —
/// callers MUST gate on `shieldedFundingAvailable()` and fall back otherwise.
export async function fundViaShield(burner: string, amountWei: bigint): Promise<DripResult> {
  if (!active) throw new Error("shielded funding unavailable — no funder registered (C4; see docs/SHIELDED-FUNDING.md)");
  if (!(await active.available())) throw new Error("shielded funder has no spendable note");
  return active.fundBurner(burner, amountWei);
}
