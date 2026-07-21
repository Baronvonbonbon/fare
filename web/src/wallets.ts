// Per-order customer burner wallets — the linkability mitigation
// (docs/PRIVACY.md risk #3). Every order the customer places is created from a
// FRESH wallet, faucet-funded, so consecutive orders share no on-chain identity
// and a home is not derivable from "person X's orders." Drivers and venues do
// NOT rotate — reputation, stake, payouts, and the venue registry are keyed by
// a persistent address.
//
// Scope note: this is unlinkable on TESTNET because the faucet is a shared
// funding source. On mainnet, funding a fresh wallet from your real wallet links
// them on-chain; a shielded funding path would be required (out of scope).
//
// The registry is device-local (localStorage). Losing the device loses the
// ability to act on those orders — inherent to throwaway keys.

import { Wallet, Contract, ethers } from "ethers";
import { sendProvider, contracts, ADDRESSES } from "./chain";
import { VAULT_ABI } from "./abi";

const REG_KEY = "fare.customer.wallets";

export interface OrderWalletRec {
  address: string;
  key: string;
  createdAt: number;
}

function load(): OrderWalletRec[] {
  try {
    return JSON.parse(localStorage.getItem(REG_KEY) || "[]");
  } catch {
    return [];
  }
}
function save(list: OrderWalletRec[]) {
  localStorage.setItem(REG_KEY, JSON.stringify(list));
}

/// Mint a fresh per-order customer wallet, persist it, and return a signer bound
/// to the broadcast provider. Each call is a new on-chain identity.
export function newOrderWallet(): Wallet {
  const w = Wallet.createRandom();
  const list = load();
  list.push({ address: w.address, key: w.privateKey, createdAt: Date.now() });
  save(list);
  return new Wallet(w.privateKey, sendProvider);
}

export function orderWallets(): OrderWalletRec[] {
  return load();
}

/// Lowercased address set, for filtering "my orders" out of the OrderCreated
/// stream (the customer's orders now span many addresses, not one).
export function orderWalletAddresses(): Set<string> {
  return new Set(load().map((w) => w.address.toLowerCase()));
}

/// The signer that created a given order (to cancel / tip / accept a bid /
/// confirm delivery — all require msg.sender == the order's customer). Null if
/// the wallet isn't on this device.
export function walletFor(address: string): Wallet | null {
  const hit = load().find((w) => w.address.toLowerCase() === address.toLowerCase());
  return hit ? new Wallet(hit.key, sendProvider) : null;
}

/// Contract handles bound to the wallet that owns `address`, or null.
export function contractsForOrder(customer: string) {
  const w = walletFor(customer);
  return w ? contracts(w) : null;
}

export interface SweepStep {
  wallet: string;
  withdrew?: bigint;
  swept?: bigint;
  error?: string;
}

/// Sweep every order-wallet's refundable balance back to `mainAddress`.
/// For each wallet: withdraw its FareVault balance (payout uses the contract's
/// Paseo-safe path), then forward the native balance (less a gas reserve) to
/// main. WARNING: the forwarding transactions RE-LINK the burners to `main` —
/// this trades privacy for convenience, surfaced in the UI.
export async function sweepToMain(
  mainAddress: string,
  gasReserveWei: bigint = ethers.parseEther("0.2"),
  onStep?: (s: SweepStep) => void
): Promise<SweepStep[]> {
  const steps: SweepStep[] = [];
  for (const rec of load()) {
    if (rec.address.toLowerCase() === mainAddress.toLowerCase()) continue;
    const step: SweepStep = { wallet: rec.address };
    const w = new Wallet(rec.key, sendProvider);
    try {
      const vault = new Contract(ADDRESSES.vault, VAULT_ABI, w);
      const owed: bigint = await vault.balanceOf(rec.address);
      if (owed > 0n) {
        const tx = await vault.withdraw();
        await tx.wait();
        step.withdrew = owed;
      }
      const bal = await sendProvider.getBalance(rec.address);
      let value = bal - gasReserveWei;
      // Paseo eth-rpc rejects sends where value % 1e6 ∈ [5e5, 1e6); round the
      // amount DOWN to a whole micro-PAS so a raw EOA transfer clears the bug.
      value = (value / 1_000_000n) * 1_000_000n;
      if (value > 0n) {
        const tx = await w.sendTransaction({ to: mainAddress, value });
        await tx.wait();
        step.swept = value;
      }
    } catch (e: any) {
      step.error = e?.reason ?? e?.shortMessage ?? e?.message ?? String(e);
    }
    steps.push(step);
    onStep?.(step);
  }
  return steps;
}
