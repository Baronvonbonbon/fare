// Gas budgeting for USER transactions (TEST-PLAN A5).
//
// Paseo reserves `gasLimit × gasPrice` at SUBMISSION, not at execution. A
// transaction whose limit is generous therefore needs the sender to be holding
// that much up front, whatever it actually burns. The operator scripts and the
// relay set a 500 M weight-scale limit — fine from a funded deployer, and at
// 1000 gwei it reserves ~500 PAS, which a freshly-shielded burner holding 5 PAS
// cannot come close to.
//
// That already cost a live run (docs/PRIVACY-STATUS.md, "What is actually
// live"). So client-side limits are budgeted here, in one place, against what a
// burner actually holds — and gasbudget.test.ts asserts both the arithmetic and
// that no oversized literal creeps back into web/src.

import { parseEther } from "ethers";

/// What Paseo charges. Used to turn a gas limit into the balance a sender must
/// be holding before the transaction will even be accepted.
export const PASEO_GAS_PRICE_WEI = 1_000n * 10n ** 9n; // 1000 gwei

/// What a fresh per-order burner is funded with out of the shielded pool.
export const BURNER_FUNDING_WEI = parseEther("5");

/// The balance Paseo reserves up front for a transaction at this limit.
export const reservationFor = (gasLimit: bigint, gasPriceWei = PASEO_GAS_PRICE_WEI): bigint =>
  gasLimit * gasPriceWei;

/// Ceiling for anything a BURNER signs. Deliberately well under its funding:
/// the reservation is on top of whatever value the transaction carries, so a
/// limit that consumed the whole balance would leave nothing to actually send.
export const MAX_BURNER_GAS_LIMIT = 3_000_000n; // 3 PAS reserved at 1000 gwei

/// Pool deposit — a Poseidon insert plus the pool's own bookkeeping.
export const DEPOSIT_GAS = 3_000_000n;

/// Shielded return of a burner's leftover. Smaller than a first deposit: the
/// tree is warm and no note is being created for a new depositor.
export const RETURN_GAS = 800_000n;

/// PAS→USDC on the asset-conversion DEX, via the XCM precompile's ExchangeAsset.
/// Larger than a pool deposit because the whole program — WithdrawAsset,
/// ExchangeAsset, DepositAsset — executes inside the one call, and the measured
/// weight on Paseo is ~4.3e10 refTime.
///
/// This is signed by the customer's FUNDED account, not a burner, so it is not
/// bound by MAX_BURNER_GAS_LIMIT: the swap happens pre-shield, before any burner
/// exists. Keep it under the oversized-limit budget all the same.
export const SWAP_GAS = 2_000_000n;

/// Headroom over the bare reservation, so rounding and a gas-price tick do not
/// strand the transaction. Kept explicit because the relationship between this
/// and RETURN_GAS is the thing that must hold.
export const RETURN_MARGIN_WEI = parseEther("0.2");

/// What `shieldedReturn` must hold back from the deposit value: the submission
/// reservation for its own gas limit, plus margin.
export const RETURN_RESERVE_WEI = reservationFor(RETURN_GAS) + RETURN_MARGIN_WEI;
