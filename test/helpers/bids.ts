// Sealed-bid helpers for tests.
//
// The open-bid path (placeBid → acceptBid) was removed: it published every
// driver's price and availability on-chain forever, including the losers'.
// Sealed bids are now the only way to reach Assigned, and they take four
// arguments instead of two, so most tests want a one-liner rather than the
// commit/accept dance spelled out. Tests that are ABOUT the sealed mechanics
// (test/sealed-bids.test.ts) drive it directly and do not use these.
import { ethers } from "hardhat";

/// Deterministic per-tag salt, so a test that needs two distinct bids on one
/// order can just pass different tags and still be reproducible.
export const bidSalt = (tag = "bid") => ethers.keccak256(ethers.toUtf8Bytes(tag));

/// A revoke hash whose secret is `keccak256(tag)`. Matches the contract's
/// `keccak256(abi.encode(revokeSecret))`.
export const revokeHashFor = (tag = "bid") =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [bidSalt(tag)]));

/// Commit a sealed bid. `submitter` defaults to the caller's signer — in
/// production a relay submits this precisely so the chain never sees the bidder.
export async function commitSealed(orders: any, orderId: bigint, driver: any, amount: bigint, tag = "bid", submitter?: any) {
  const salt = bidSalt(tag);
  const hash = await orders.bidHashOf(orderId, driver.address ?? driver, amount, salt);
  await (submitter ? orders.connect(submitter) : orders).commitBid(orderId, hash, revokeHashFor(tag));
  return { hash, salt, amount };
}

/// Commit + accept in one step: the common "get this order to Assigned" move.
/// Native escrow — the customer sends `amount` with the accept.
export async function assignSealed(
  orders: any, orderId: bigint, driver: any, customer: any, amount: bigint, tag = "bid"
) {
  const { salt } = await commitSealed(orders, orderId, driver, amount, tag);
  return orders.connect(customer).acceptSealedBid(orderId, driver.address ?? driver, amount, salt, { value: amount });
}

/// As `assignSealed`, for a stablecoin order: the fare is pulled with
/// transferFrom, so the customer must have approved the orders contract.
export async function assignSealedERC20(
  orders: any, orderId: bigint, driver: any, customer: any, amount: bigint, tag = "bid"
) {
  const { salt } = await commitSealed(orders, orderId, driver, amount, tag);
  return orders.connect(customer).acceptSealedBidERC20(orderId, driver.address ?? driver, amount, salt);
}
