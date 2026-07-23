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

// ─────────────────────────────────────────────────────────────────────────────
// Concrete backend: Kusama Shield pool (C4). Registered by initShieldedFunder()
// only when a pool is configured (VITE_SHIELD_POOL) — otherwise the registry
// stays empty and callers fall back to the faucet/relay drip (unchanged).
// ─────────────────────────────────────────────────────────────────────────────
import { Wallet, parseEther, formatEther, type Provider, type Signer } from "ethers";
import { readProvider, sendProvider, type DripResult as _Drip } from "./chain";
import {
  depositAndSnapshot, buildWithdrawal, recordChangeNote, commitmentOf,
  type NoteRecord,
} from "./shieldpool";

const NOTES_KEY = "fare.shield.notes"; // device-local spendable notes (secrets!)
const loadNotes = (): NoteRecord[] => { try { return JSON.parse(localStorage.getItem(NOTES_KEY) || "[]"); } catch { return []; } };
const saveNotes = (n: NoteRecord[]) => localStorage.setItem(NOTES_KEY, JSON.stringify(n));
function upsertNote(rec: NoteRecord) { const n = loadNotes(); n.push(rec); saveNotes(n); }
function markSpent(nullifier: string) { saveNotes(loadNotes().map((r) => (r.nullifier === nullifier ? { ...r, spent: true } : r))); }
function pickSpendable(minValueWei: bigint): NoteRecord | null {
  return loadNotes().filter((r) => !r.spent && BigInt(r.value) >= minValueWei).sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))[0] ?? null;
}

class KusamaShieldFunder implements ShieldedFunder {
  constructor(
    private poolAddr: string,
    private provider: Provider,
    private mainSigner: () => Signer | null, // customer's main wallet (deposits only)
    private relayUrl: () => string | undefined,
  ) {}

  async available(): Promise<boolean> {
    return !!this.poolAddr && loadNotes().some((r) => !r.spent && BigInt(r.value) > 0n);
  }

  async deposit(amountWei: bigint): Promise<ShieldedNote> {
    const signer = this.mainSigner();
    if (!signer) throw new Error("connect the main wallet to deposit into the shielded pool");
    const { record } = await depositAndSnapshot(this.poolAddr, signer, this.provider, amountWei);
    upsertNote(record);
    return { commitment: "0x" + commitmentOf(record).toString(16).padStart(64, "0"), denominationWei: amountWei.toString(), createdAt: Date.now() };
  }

  async fundBurner(burner: string, amountWei: bigint): Promise<DripResult> {
    const url = this.relayUrl();
    if (!url) throw new Error("shielded funding needs a relay to submit the withdrawal");
    const health = await (await fetch(`${url}/health`)).json();
    const fee = (() => { try { return parseEther(String(health.shieldFeePAS ?? "0")); } catch { return 0n; } })();
    const feeMode = fee > 0n;
    const withdrawnValue = amountWei + (feeMode ? fee : 0n); // burner receives amountWei either way
    const recipient = feeMode ? (health.relay as string) : burner;
    const note = pickSpendable(withdrawnValue);
    if (!note) throw new Error(`no shielded note ≥ ${formatEther(withdrawnValue)} PAS — deposit into the pool first`);

    // KS Issue 4: on "unknown root" the relay 409s → rebuild against a fresh root.
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await buildWithdrawal(this.provider, this.poolAddr, note, recipient, withdrawnValue);
      const res = await fetch(`${url}/shield-withdraw`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pA: p.pA, pB: p.pB, pC: p.pC, pubSignals: p.pubSignals, recipient, burner }),
      });
      if (res.status === 409) { lastErr = await res.json(); continue; } // root evicted → retry
      const j = await res.json();
      if (!res.ok || !j.txHash) throw new Error(`shield-withdraw failed: ${JSON.stringify(j)}`);
      markSpent(note.nullifier);
      if (BigInt(p.change.value) > 0n) {
        try { upsertNote(await recordChangeNote(this.provider, this.poolAddr, p.change, await this.provider.getBlockNumber())); } catch { /* re-derivable later */ }
      }
      // Confirm by EFFECT, not by the returned hash (R1): the load-balanced RPC
      // may not resolve the relay's tx hash, but the burner's balance rising is
      // ground truth. Poll ~24s; return funded once the escrow lands.
      const before = await this.provider.getBalance(burner);
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if ((await this.provider.getBalance(burner)) > before) return { funded: true, txHash: j.txHash };
      }
      return { funded: true, txHash: j.txHash, reason: "submitted; balance not yet observed" };
    }
    throw new Error(`shield-withdraw kept hitting an evicted root: ${JSON.stringify(lastErr)}`);
  }

  /// Shielded refund: deposit a burner's leftover back into the pool instead of
  /// sweeping to main in the clear (the un-linking sibling of sweepToMain).
  async shieldedReturn(burnerKey: string): Promise<void> {
    const w = new Wallet(burnerKey, sendProvider as any);
    const bal = await this.provider.getBalance(w.address);
    const reserve = parseEther("1.0"); // value + gasLimit×gasPrice must fit (see venue-node README)
    const usable = bal - reserve;
    if (usable <= 0n) return;
    const dep = (usable / parseEther("0.001")) * parseEther("0.001"); // clean value (Paseo payable quirk)
    if (dep <= 0n) return;
    const { record } = await depositAndSnapshot(this.poolAddr, w, this.provider, dep, 800_000n);
    upsertNote(record);
  }
}

/// Install the Kusama Shield funder if a pool is configured. Called once at app
/// init (from relay.ts, which already owns the relay URL — avoids a cycle).
/// `mainSigner` yields the connected main wallet for deposits.
export function initShieldedFunder(mainSigner: () => Signer | null, relayUrl: () => string | undefined): void {
  const pool = ((import.meta as any).env?.VITE_SHIELD_POOL as string | undefined)?.trim();
  if (!pool) return; // not configured → faucet fallback stays the behavior
  registerShieldedFunder(new KusamaShieldFunder(pool, readProvider as unknown as Provider, mainSigner, relayUrl));
}
