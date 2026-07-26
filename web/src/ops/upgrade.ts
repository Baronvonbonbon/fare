// Upgrade-console addressing, extracted from UpgradeConsole (TEST-PLAN C5).
//
// The router keys a contract by `encodeBytes32String(name)`, and so does
// scripts/deploy.ts. Nothing enforces that those two agree: a name that drifts
// on one side does not error, it silently addresses a DIFFERENT registry slot —
// so a promotion would appear to succeed while re-pointing nothing, or register
// a duplicate entry no client resolves. test/ops-governance.test.ts checks the
// console's names against a router the deploy path populated.

import { ethers } from "ethers";

/// The registry entries the console manages, mirroring scripts/deploy.ts.
///
/// `pauseRegistry` is registered for discovery only — it is not FareUpgradable,
/// so it has no freeze state and can only be re-pointed with `register()`,
/// never `upgradeContract()`. Calling the wrong one is the mistake this flag
/// exists to prevent.
export const REGISTERED: { name: string; upgradable: boolean }[] = [
  { name: "orders", upgradable: true },
  { name: "settlement", upgradable: true },
  { name: "disputes", upgradable: true },
  { name: "drivers", upgradable: true },
  { name: "venues", upgradable: true },
  { name: "vault", upgradable: true },
  { name: "ratings", upgradable: true },
  { name: "pauseRegistry", upgradable: false },
];

/// The router's bytes32 key for a registered name.
export const routerKey = (name: string): string => ethers.encodeBytes32String(name);

export type PromotionCheck = {
  valid: boolean;         // a well-formed address
  sameAsCurrent: boolean; // pointing at what is already registered
  canSubmit: boolean;
  reason: string | null;
};

/// Whether a promotion / re-point may be submitted.
///
/// `sameAsCurrent` is blocked rather than merely warned about: re-registering
/// the live address would burn a version bump and, with `freezeOld`, freeze the
/// contract it just promoted — an outage caused by a no-op.
export function checkPromotion(newAddr: string, currentAddr: string, authorized: boolean): PromotionCheck {
  const valid = ethers.isAddress(newAddr);
  const sameAsCurrent = valid && newAddr.toLowerCase() === currentAddr.toLowerCase();
  const reason = !valid
    ? "Not a valid address."
    : sameAsCurrent
      ? "That is already the current address."
      : !authorized
        ? "Connect the router owner to enable this."
        : null;
  return { valid, sameAsCurrent, canSubmit: valid && !sameAsCurrent && authorized, reason };
}
