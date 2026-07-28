#!/usr/bin/env node
// FARE venue relay — gasless transactions, run by a venue node.
//
// The first component of the venue appliance (see docs/NETWORK-ARCHITECTURE.md).
// Goal: zero gas friction for users in the venue's region, with NO contract
// changes, by doing the two things that are safe to relay:
//
//   POST /fund   — sponsor gas: top up a user's burner so it can transact
//                  (region-local and decentralized — this replaced the
//                  central faucet, which has since been deleted).
//   POST /submit — relay a settlement call. confirmPickup / confirmDropoffZK are
//                  the ONLY allowlisted methods: they carry their own signatures
//                  / ZK proof and don't check msg.sender, so the relay can submit
//                  them paying gas → those steps become fully gasless.
//
// Deliberately NOT relayed: createOrder / acceptBid / placeBid / rate / register.
// Those check msg.sender and/or move the user's own value; full gasless for them
// needs an EIP-2771 forwarder (a contract change) — see the README.
//
// Trust: the relay holds a funded venue account and pays gas only. It can never
// move a user's funds — /submit forwards pre-signed settlement payloads, and
// /fund only tops up below a floor. Worst case an abuser drains the relay's gas
// budget; it's balance-gated + rate-limited, and the operator refills.
//
// Run:  node --env-file=.env relay.mjs   (Node 22+)

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { JsonRpcProvider, Wallet, Contract, Interface, parseEther, formatEther, isAddress, keccak256, solidityPacked } from "ethers";
import { rebateWei, withdrawFeeWei, coversCost, withinBudget, windowSpent } from "./economics.mjs";
import { rebateInNative, shouldTopUp, planSwap, assetConversionQuote, priceFraction, cfg as swapCfg } from "./treasury.mjs";
import { executeRecoverySwap } from "./swap.mjs";
import { createStore, runOnce as keeperTick } from "./shieldkeeper.mjs";

const PORT = Number(process.env.RELAY_PORT || 8788);
// Bind address. Defaults to every interface because under docker-compose the
// relay must be reachable from Caddy over the compose network. When the relay
// runs bare on a host behind a Cloudflare tunnel, set RELAY_BIND=127.0.0.1 so
// the only way in is the tunnel — not the LAN.
const BIND = process.env.RELAY_BIND || "0.0.0.0";
// A single-signer relay keeps ONE provider (nonce safety — no fallback quorum on
// getTransactionCount), but prefers a local pine light client when present for
// trust-minimized reads, else the first of a comma-separated RELAY_RPC_URL list.
const RPC = (process.env.PINE_RPC?.trim())
  || (process.env.RELAY_RPC_URL || "https://eth-rpc-testnet.polkadot.io/").split(",")[0].trim();
const KEY = process.env.RELAY_PRIVATE_KEY;
const FUND_AMOUNT = parseEther(process.env.FUND_AMOUNT_PAS || "5");
const FUND_MIN = parseEther(process.env.FUND_MIN_PAS || "2");
const ADDRESS_BOOK = process.env.ADDRESS_BOOK || "../deployed-addresses.json";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
// Paseo prices gas on a weight scale, so a settlement call needs a limit that
// looks absurd on a normal EVM — and Paseo reserves limit × price at
// submission, which is why only the funded relay uses it (see
// web/src/gasbudget.ts). It is configurable because that value is
// chain-specific: any EVM with a standard per-transaction gas cap (hardhat's is
// 2^24) rejects the Paseo default outright, and the relay could not settle at
// all until this could be overridden.
const GAS_SETTLE = BigInt(process.env.RELAY_GAS_SETTLE || 500_000_000);
const GAS_FUND = 100_000n; // a plain transfer; keeps the fee reservation small
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 20); // requests / IP / window

// ── Shielded funding (C4): relay a KS proxy_withdraw that funds a fresh burner ─
// The client builds the withdrawal proof; the relay submits it and pays gas. Two
// modes, selected by whether the proof's recipient is the relay or the burner:
//   • sponsor mode (recipient = burner): the pool pays the burner directly; the
//     relay eats gas (subsidy-budget gated). Trustless — the relay never touches
//     the funds. Use when SHIELD_FEE_PAS = 0.
//   • fee mode (recipient = relay): the pool pays the RELAY, which forwards
//     (withdrawnValue − fee) to the burner and keeps the fee to cover its gas.
//     Requires SHIELD_FEE_PAS > 0. Fee must clear gas × margin. Trust note: in
//     fee mode the relay briefly holds the withdrawal, so it must be forwarded —
//     a stronger trust assumption than sponsor mode (documented in the README).
const SHIELD_POOL = process.env.SHIELD_POOL || "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const SHIELD_FEE = parseEther(process.env.SHIELD_FEE_PAS || "0"); // relayer fee (fee mode)
const GAS_SHIELD = 8_000_000n; // proxy_withdraw is a Groth16 verify + tree insert
const GAS_FORWARD_PAS = 100_000n; // plain transfer of the net to the burner

// ── Sponsored onboarding (POST /onboard) — seed a fresh driver/venue wallet ──
// Opt-in (OFF by default): registration reads msg.sender and isn't meta-
// forwardable, so a region relay can instead SEED a fresh wallet with existential
// deposit + register gas so a new driver/venue can register and immediately begin
// earning. Loss-leader → subsidy-budget + rate-limit + one-per-address gated, and
// (for venues) region-scoped. See docs/RELAY-SPONSORSHIP.md (Route A).
const ONBOARD_ENABLED = (process.env.ONBOARD_ENABLED || "off").toLowerCase() === "on";
const ONBOARD_SEED = parseEther(process.env.ONBOARD_SEED_PAS || "2"); // ≥ ED + register gas
const ONBOARD_LAT = process.env.ONBOARD_LAT ? Number(process.env.ONBOARD_LAT) : null; // µdeg
const ONBOARD_LON = process.env.ONBOARD_LON ? Number(process.env.ONBOARD_LON) : null;
const ONBOARD_RADIUS_KM = Number(process.env.ONBOARD_RADIUS_KM || 60);
const GAS_ONBOARD = 100_000n; // a plain seed transfer
const onboarded = new Set(); // one sponsored seed per address (process-local)

// Haversine (µdeg → meters) for the venue region gate.
function distMeters(latA, lonA, latB, lonB) {
  const R = 6_371_000, rad = Math.PI / 180e6; // µdeg → rad
  const dLat = (latB - latA) * rad, dLon = (lonB - lonA) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── Profitability guard (F6/F8 economics) ────────────────────────────────────
// The relay only sponsors what pays off: a reward-bearing action (dropoff
// settlement → F6 rebate; withdrawFor → F8 fee) is relayed only if the reward
// covers the fare's CUMULATIVE relayed gas × margin; no-reward actions (fund /
// bids / pickup / cancels / rate) are sponsored as loss-leaders under a rolling
// gas budget. Set RELAY_PROFIT_GUARD=off to sponsor everything (old behavior).
const PROFIT_GUARD = (process.env.RELAY_PROFIT_GUARD || "on").toLowerCase() !== "off";
const MIN_MARGIN = Number(process.env.RELAY_MIN_MARGIN || 1.25); // reward ≥ cost × this
// No-reward spend per window. This counts VALUE GIVEN AWAY, not just gas — a
// sponsored burner is 5 PAS of it — so the useful way to read the number is
// "how many burners a window", 50 at the defaults. It was 50 PAS when it
// counted only gas, which bounded nothing (TEST-FINDINGS #19); raising it keeps
// roughly the sponsorship capacity the demo had, now honestly accounted.
const GAS_BUDGET = parseEther(process.env.RELAY_GAS_BUDGET_PAS || "250");
const BUDGET_WINDOW_MS = Number(process.env.RELAY_BUDGET_WINDOW_MS || 86_400_000); // 1 day

// ── Fee-recovery (F6-swap): the relay earns USDC but burns PAS, so when its gas
// dips below the floor it sells accrued USDC → PAS on the local asset-conversion
// DEX (via the RUNTIME_PALLETS_ADDR sentinel, its own EVM key), self-refuelling.
// Thresholds reuse treasury.cfg (GAS_FLOOR_PAS / GAS_TARGET_PAS). Off by default.
const FEE_RECOVERY = (process.env.RELAY_FEE_RECOVERY || "off").toLowerCase() === "on";
const FEE_TOKEN = process.env.RELAY_FEE_TOKEN;                              // USDC to recover (defaults to addr.stablecoin below)
const FEE_ASSET_ID = process.env.RELAY_FEE_ASSET_ID ? Number(process.env.RELAY_FEE_ASSET_ID) : null; // pallet-assets id
const FEE_TOKEN_DECIMALS = Number(process.env.RELAY_FEE_TOKEN_DECIMALS || 6);
const SWAP_POLL_MS = Number(process.env.SWAP_POLL_MS || 300_000);
const GAS_SWAP = 2_000_000n;

// Run-as-a-program vs. imported-by-a-test. The module binds a port and exits the
// process on a missing key, both of which a test importing it must not inherit —
// so every such side effect is gated on this. See relay.test.mjs.
const IS_MAIN = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (!KEY) {
  console.error("[relay] RELAY_PRIVATE_KEY not set. Exiting.");
  if (IS_MAIN) process.exit(1);
  throw new Error("RELAY_PRIVATE_KEY not set");
}

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const relay = new Wallet(KEY, provider);
const settlementAddr = JSON.parse(readFileSync(new URL(ADDRESS_BOOK, import.meta.url), "utf8")).settlement
  ?? JSON.parse(readFileSync(new URL(ADDRESS_BOOK, import.meta.url), "utf8")).addresses?.settlement;

const SETTLEMENT_ABI = [
  "function confirmPickup((uint256 orderId, uint8 phase, address actor, int32 lat, int32 lon, uint64 timestamp) driverAtt, bytes driverSig, (uint256 orderId, uint8 phase, address actor, int32 lat, int32 lon, uint64 timestamp) venueAtt, bytes venueSig)",
  "function confirmDropoffZK((uint256 orderId, uint8 phase, address actor, bytes32 posCommit, uint64 timestamp) driverAtt, bytes driverSig, bytes proof, uint256[5] pubSignals)",
];
const RELAYABLE = new Set(["confirmPickup", "confirmDropoffZK"]);
const settlement = new Contract(settlementAddr, SETTLEMENT_ABI, relay);

// ── EIP-2771 forwarder for gasless user actions (F8) ─────────────────────────
// The client builds + signs a ForwardRequest for a non-value action (placeBid /
// withdrawBid / cancels / rate); the relay submits it and pays gas. The user
// signs, so the relay can't act as them — the forwarder verifies the signature.
const book = JSON.parse(readFileSync(new URL(ADDRESS_BOOK, import.meta.url), "utf8"));
const addr = book.addresses ?? book;
const forwarderAddr = process.env.FORWARDER_ADDRESS || addr.forwarder;
// Only forward to FARE's own metatx-aware contracts, and only value-free calls —
// so the relay never fronts a customer's escrow (value actions stay direct).
const FORWARD_TARGETS = new Set([addr.orders, addr.ratings].filter(Boolean).map((a) => a.toLowerCase()));
const FORWARDER_ABI = [
  "function execute((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) payable",
];
const forwarder = forwarderAddr ? new Contract(forwarderAddr, FORWARDER_ABI, relay) : null;
const GAS_FORWARD = 700_000n; // outer gas for execute(); request.gas caps the inner call

// ── Gasless withdraw (F8): relay submits a driver-signed FareVault.withdrawFor ─
// The relay is msg.sender, so a configured withdrawFeeBps reimburses its gas.
const vaultAddr = process.env.VAULT_ADDRESS || addr.vault;
const VAULT_ABI = [
  "function withdrawFor(address account, address recipient, uint256 deadline, bytes signature)",
  "function balanceOf(address) view returns (uint256)", // reward read for the withdraw guard
  "function withdrawFeeBps() view returns (uint16)",
  "function tokenBalanceOf(address token, address account) view returns (uint256)", // relay's accrued fee (F6-swap)
  "function withdrawToken(address token)",              // sweep the relay's own token balance out
  // shielded payouts (privacy phase 1)
  "function queueShieldCreditFor(address account, uint96 bucket, uint256 deadline, bytes signature)",
  "function sealShieldBatch(uint96 bucket, uint64 count)",
  "function depositShieldBatch(uint96 bucket, bytes32[] commitments)",
  "function shieldPending(uint96 bucket) view returns (uint64)",
  "function shieldScanned(uint96 bucket) view returns (uint64)",
  "function shieldTicket(uint96 bucket, uint64 ticket) view returns (address owner, uint64 queuedAt, bool reclaimed)",
  "function shieldMinBatch() view returns (uint16)",
  "function shieldMinDwell() view returns (uint32)",
  // shield notes (privacy phase 3)
  "function insertShieldNoteFor(address account, uint96 bucket, uint256 commitment, uint256 deadline, bytes signature)",
  "function depositShieldNoteZK(bytes proof, uint256 root, uint256 nullifierHash, uint96 bucket, bytes32 ksCommitment)",
  "function isKnownNoteRoot(uint256 root) view returns (bool)",
];
const vault = vaultAddr ? new Contract(vaultAddr, VAULT_ABI, relay) : null;
const GAS_WITHDRAW = 200_000n;

// ── Shielded payouts (privacy phase 1) ───────────────────────────────────────
// The relay plays two roles here, deliberately split across two transactions so
// neither one carries both an account and a pool commitment (PRIVACY-TIERS §3):
//   POST /shield-queue — submit a driver's EIP-712 authorization. The commitment
//                        travels in the request BODY and is held off-chain; it
//                        must never reach this transaction's calldata.
//   keeper tick        — once minBatch commitments are held for a bucket and the
//                        oldest ticket has dwelled, SEAL them in one transaction
//                        (that seal size is the anonymity set) and then deposit
//                        them in chain-sized chunks that name no account.
// Trust: a keeper holds the pairing and could substitute its own commitments for
// the drivers' (PRIVACY-TIERS §4). Only run this on a relay the payees trust.
const SHIELD_KEEPER = process.env.SHIELD_KEEPER === "1";
const SHIELD_KEEPER_STORE = process.env.SHIELD_KEEPER_STORE || "./shield-keeper.json";
const SHIELD_KEEPER_POLL_MS = Number(process.env.SHIELD_KEEPER_POLL_MS || 60_000);
// Paseo rejects more than 2 pool deposits in one transaction (proof size, not
// gas — docs/E2E-PRIVACY-LIVE.md §2). Splitting costs no privacy.
const SHIELD_MAX_PER_TX = Number(process.env.SHIELD_MAX_PER_TX || 2);
const GAS_SHIELD_BATCH = 3_000_000n;
// A note insert is ~16 Poseidon precompile calls; a spend adds a Groth16
// pairing plus the pool deposit.
const GAS_NOTE = 3_000_000n;
const GAS_NOTE_SPEND = 5_000_000n;
const GAS_BID = 500_000n;

// Sealed-bid box: orderId → ciphertext the customer opens. Held in memory with a
// TTL, because it is delivery buffer, not storage — and because a relay that
// keeps bid traffic around is exactly what phase 4 is trying to avoid.
const BID_TTL_MS = Number(process.env.BID_TTL_MS || 24 * 3_600_000);
const bidBox = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of bidBox) if (v.exp < now) bidBox.delete(k); }, 3_600_000).unref?.();
const keeperStore = SHIELD_KEEPER ? createStore(SHIELD_KEEPER_STORE) : null;

// ── Kusama Shield pool (C4 shielded funding) ─────────────────────────────────
const SHIELD_ABI = [
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  // Tree reads + insert events for the batch keeper's pre-batch snapshot.
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
  "event NewCommitment(bytes32 commitment)",
];
const shieldPool = new Contract(SHIELD_POOL, SHIELD_ABI, relay);

// Registry reads for the onboarding anti-double-seed check.
const driversAddr = addr.drivers;
const drivers = driversAddr ? new Contract(driversAddr, ["function drivers(address) view returns (bool registered, bool banned, uint96 stake, uint64 unstakeRequestedAt, uint32 delivered, uint32 failed, string metadataURI)"], provider) : null;
// context binds the recipient into the proof: context = pubSignals[5] =
// keccak256(packed recipient address) mod r. The relay recomputes this to verify
// who the pool will actually pay before it submits (defends fee mode).
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const contextFor = (addr) => BigInt(keccak256(solidityPacked(["address"], [addr]))) % BN254_R;

// ── Reward reads + calldata decoding for the profitability guard ─────────────
const ordersAddr = process.env.ORDERS_ADDRESS || addr.orders;
const ORDERS_READ_ABI = [
  "function orders(uint256) view returns (address customer, uint64 venueId, uint8 status, address driver, uint96 orderValue, uint96 tip, uint96 fare, uint96 maxFare, uint96 escrow, bytes32 dropCommit, uint64 createdAt, uint64 pickupWindowSecs, uint64 deliveryWindowSecs, uint64 pickupDeadline, uint64 deliveryDeadline, address token, uint96 serviceFee)",
  "function feeBps() view returns (uint16)",
  "function relayRebateBps() view returns (uint16)",
  // forwardable order actions — used to decode a /forward request's orderId
  "function placeBid(uint256 orderId, uint96 amount)",
  "function withdrawBid(uint256 orderId)",
  "function cancelOpen(uint256 orderId)",
  "function cancelAssigned(uint256 orderId)",
  "function abandonOrder(uint256 orderId)",
  // gasless TOKEN value actions (Option C) — safe to forward (transferFrom pulls
  // from the customer's own balance, relay never fronts value)
  "function createOrderERC20(address token, uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pw, uint64 dw)",
  "function createOrderERC20WithPermit(address token, uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pw, uint64 dw, uint256 permitValue, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)",
  "function acceptBidERC20(uint256 orderId, address driver)",
  "function increaseTipERC20(uint256 orderId, uint96 amount)",
  "event OrderCreated(uint256 indexed orderId, address indexed customer, uint64 indexed venueId, uint96 orderValue, uint96 tip, uint96 maxFare, bytes32 dropCommit)",
];
const orders = ordersAddr ? new Contract(ordersAddr, ORDERS_READ_ABI, provider) : null;
// Signer-bound, for the two calls the relay makes on a bidder's behalf. The
// relay is msg.sender for these BY DESIGN: a driver-signed commitBid would name
// them on-chain, which is the whole thing sealed bids remove (phase 4).
const ORDERS_BID_ABI = [
  "function commitBid(uint256 orderId, bytes32 bidHash, bytes32 revokeHash)",
  "function revokeBid(uint256 orderId, bytes32 bidHash, bytes32 revokeSecret)",
];
const ordersW = ordersAddr ? new Contract(ordersAddr, ORDERS_BID_ABI, relay) : null;
const ordersIface = new Interface(ORDERS_READ_ABI);
// Actions whose orderId is arg[0] (known at forward time).
const ORDER_ACTIONS = new Set(["placeBid", "withdrawBid", "cancelOpen", "cancelAssigned", "abandonOrder", "acceptBidERC20", "increaseTipERC20"]);
// Create actions have NO orderId yet — attributed to the order after the tx
// mines, by parsing OrderCreated (so the relay's per-order P&L covers the
// gasless-order creation gas too → the F6 rebate must cover it before settling).
const CREATE_ACTIONS = new Set(["createOrderERC20", "createOrderERC20WithPermit"]);
function forwardFnName(request) {
  try { return ordersIface.parseTransaction({ data: request.data })?.name ?? null; } catch { return null; }
}
function orderIdFromReceipt(rc) {
  for (const log of rc?.logs ?? []) {
    try { const p = ordersIface.parseLog(log); if (p?.name === "OrderCreated") return p.args[0]; } catch { /* not ours */ }
  }
  return null;
}

// ── tx serialization: chain all sends so concurrent requests don't collide on
//    the relay account's nonce ──────────────────────────────────────────────
let chain = Promise.resolve();
const serialize = (fn) =>
  (chain = chain.then(fn, fn).catch((e) => { resyncNonce(); throw e; }));

// ── nonce allocation ─────────────────────────────────────────────────────────
// Serializing the sends orders them but does NOT give them distinct nonces.
// Asking the chain per send fails two ways at once: getTransactionCount
// defaults to "latest", which excludes a submitted-but-unmined transaction,
// and ethers caches that read for ~250 ms on top. Two requests inside the same
// block window therefore drew the SAME nonce and the node rejected the second —
// not a narrow race on a chain with multi-second blocks, but anything from two
// users arriving together (test/relay-endpoints.test.ts pins it).
//
// Track it here instead: seed once from the chain — "pending", so a transaction
// already in the mempool is counted — then hand out increments. Every allocation
// happens inside `serialize`, so there is exactly one in flight and no lock is
// needed. On any failure the counter is dropped and re-seeded next time: a send
// that never landed must not leave a gap, because the node would then queue
// every later transaction behind a nonce that never arrives.
let nextNonce = null;
const resyncNonce = () => { nextNonce = null; };
async function allocNonce() {
  if (nextNonce === null) nextNonce = await provider.getTransactionCount(relay.address, "pending");
  return nextNonce++;
}

// ── profitability-guard state + helpers ──────────────────────────────────────
const gasSpent = new Map(); // orderId(string) → cumulative relayed cost (wei)
const budget = { spent: 0n, start: Date.now() }; // rolling no-reward subsidy window
const recordOrderGas = (orderId, wei) => {
  if (orderId == null || !wei) return;
  const k = String(orderId);
  gasSpent.set(k, (gasSpent.get(k) ?? 0n) + wei);
};
/// Check the rolling window and take the reservation in ONE synchronous step.
///
/// The submission sits between the check and the accounting and is awaited, so
/// checking first and recording afterwards lets every request already in flight
/// pass the same test — the window then overshoots by however many arrived
/// together (TEST-FINDINGS #20). Nothing here needs a lock: the check and the
/// `+=` are adjacent with no await between them, which on one thread is atomic.
///
/// `ok` reports whether there was room; the reservation is taken either way, so
/// the bookkeeping stays complete when the guard is off — PROFIT_GUARD has
/// always gated the refusal, not the accounting.
///
/// `release()` gives the reservation back when the send never landed, so a
/// failed submission cannot permanently consume a window. It is idempotent, and
/// a no-op once the window has rolled (that spend was already reset to zero).
function reserveBudget(wei) {
  const ok = withinBudget(windowSpent(budget, Date.now(), BUDGET_WINDOW_MS), wei, GAS_BUDGET);
  const takenIn = budget.start;
  budget.spent += wei;
  let settled = false;
  return {
    ok,
    release() {
      if (settled) return;
      settled = true;
      if (budget.start !== takenIn) return;
      budget.spent -= budget.spent < wei ? budget.spent : wei;
    },
  };
}

async function feePerGasWei() {
  try { const fd = await provider.getFeeData(); return fd.maxFeePerGas ?? fd.gasPrice ?? 0n; }
  catch { return 0n; }
}
/// Estimated cost (wei) of a call; falls open to fallbackGas if estimation fails
/// (a transient RPC issue shouldn't hard-block a relay).
async function estCostWei(estimateFn, fallbackGas) {
  let gas;
  try { gas = await estimateFn(); } catch { gas = fallbackGas; }
  return gas * (await feePerGasWei());
}
// token decimals cache (for currency-aware rebate valuation)
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_DECIMALS = 18;
const _dec = new Map();
async function tokenDecimals(token) {
  if (_dec.has(token)) return _dec.get(token);
  let d = 18;
  try { d = Number(await new Contract(token, ["function decimals() view returns (uint8)"], provider).decimals()); } catch {}
  _dec.set(token, d); return d;
}
/// The relay's TOTAL compensation for settling an order, valued in NATIVE wei (so
/// it can be compared to native gas): the flat service fee (F6-flat, sized to
/// cover the whole per-order cost) PLUS any bps rebate carved from the protocol
/// fee. Native orders: already native. TOKEN orders (gasless): the comp is in the
/// order token — value it in native via the price (RELAY_TOKEN_PRICE / a live
/// asset-conversion quote). Returns null when a token order has no price → the
/// caller must DECLINE (it can't prove the comp covers gas).
async function relayCompForOrder(orderId) {
  if (!orders) return 0n;
  try {
    const [o, feeBps, rebBps] = await Promise.all([orders.orders(orderId), orders.feeBps(), orders.relayRebateBps()]);
    const comp = rebateWei(o.fare, feeBps, rebBps) + BigInt(o.serviceFee ?? 0n); // rebate + flat service fee
    if (!o.token || o.token === ZERO) return comp; // native — same currency as gas
    const dec = await tokenDecimals(o.token);
    return rebateInNative(comp, dec, NATIVE_DECIMALS, null); // null price → config RELAY_TOKEN_PRICE
  } catch { return 0n; }
}
async function withdrawFeeForAccount(account) {
  if (!vault) return 0n;
  try {
    const [bal, bps] = await Promise.all([vault.balanceOf(account), vault.withdrawFeeBps()]);
    return withdrawFeeWei(bal, bps);
  } catch { return 0n; }
}
/// Decode a /forward request's target orderId (null if it's not an order action).
function forwardOrderId(request) {
  if (String(request.to).toLowerCase() !== String(ordersAddr).toLowerCase()) return null;
  try {
    const p = ordersIface.parseTransaction({ data: request.data });
    return p && ORDER_ACTIONS.has(p.name) ? p.args[0] : null;
  } catch { return null; }
}
const decline = (res, reason, detail, origin) =>
  send(res, 402, { declined: true, error: reason, ...detail }, origin);

// Coalesces concurrent /fund calls for one address. Both callers read the same
// pre-send balance, so both would see `bal < FUND_MIN` and each send FUND_AMOUNT
// — the burner gets funded twice out of the subsidy budget (TEST-FINDINGS #2).
// Keyed by address: a second caller awaits the first's result and reports it,
// which keeps the client's `{funded, reason}` contract identical to a lone call.
const fundInFlight = new Map(); // address (lowercased) → Promise<{status, body}>

// ── order-scoped message relay (B3/B2/B6 channel, P2) ────────────────────────
// In-memory store-and-forward for E2E-sealed, order-scoped envelopes — the
// decentralized alternative to the shared /api/msg (docs/MESSAGING.md). Content
// is sealed client-side, so this only ever holds ciphertext. Ephemeral: threads
// live in memory with a TTL (a venue relay is region-local, not a durable store).
const threads = new Map(); // topic → { msgs: [], exp }
const MSG_TTL_MS = 86_400_000; // 1 day
const MSG_THREAD_MAX = 200;
const okTopic = (t) => typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t);
function threadOf(topic) {
  const now = Date.now();
  let t = threads.get(topic);
  if (!t || t.exp < now) { t = { msgs: [], exp: now + MSG_TTL_MS }; threads.set(topic, t); }
  return t;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of threads) if (v.exp < now) threads.delete(k); }, 3_600_000).unref?.();

// ── proof-of-delivery photo blob store (B6, P2) — in-memory, TTL ─────────────
// Holds only ciphertext (sealed client-side by photo.ts). Content-addressed by
// sha256(ct); expires with a TTL (crypto-shred handles the rest).
const photos = new Map(); // id → { iv, ct, exp }
const PHOTO_TTL_MS = 14 * 24 * 3_600_000; // ~2 weeks
const isHex = (s) => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);
const sha256Hex = (s) => "0x" + createHash("sha256").update(s).digest("hex");
setInterval(() => { const now = Date.now(); for (const [k, v] of photos) if (v.exp < now) photos.delete(k); }, 3_600_000).unref?.();

// ── crude per-client rate limit, without holding client IPs ──────────────────
// Privacy phase 3b: the relay is in the threat model (docs/PRIVACY-TIERS.md §1),
// so it should not keep a table of who is talking to it. Rate limiting only
// needs to tell clients APART, not identify them — so key on a keyed hash of the
// address under a secret that rotates every window. After a rotation the old
// keys are unrecoverable even from a memory dump, and nothing on this node ever
// held a raw address beyond the length of one request.
let rateSalt = randomBytes(16);
let rateSaltAt = Date.now();
const hits = new Map();
function clientKey(ip) {
  if (Date.now() - rateSaltAt > RATE_WINDOW_MS * 10) {
    rateSalt = randomBytes(16);
    rateSaltAt = Date.now();
    hits.clear(); // old keys are meaningless under the new salt
  }
  return createHash("sha256").update(rateSalt).update(ip).digest("base64").slice(0, 16);
}
/// Read-only view of the limiter's keys, for the privacy test that asserts this
/// node holds no table of client addresses (docs/PRIVACY-STATUS.md "Relay
/// metadata"). Exposed rather than inferred: the claim is about what is IN
/// memory, so the test has to look.
const rateLimitKeys = () => [...hits.keys()];

function rateLimited(ip) {
  if (!ip) return false;
  const key = clientKey(ip);
  const now = Date.now();
  const rec = hits.get(key) ?? { n: 0, t: now };
  if (now - rec.t > RATE_WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(key, rec);
  return rec.n > RATE_MAX;
}

function send(res, status, body, origin) {
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allow ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw Object.assign(new Error("body too large"), { httpStatus: 413 });
    chunks.push(c);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  // Clients pad request bodies to fixed blocks so their SIZE carries no
  // information (web/src/relaypick.ts). The padding is not data — drop it before
  // anything downstream sees it.
  if (body && typeof body === "object") delete body._pad;
  return body;
}

async function handler(req, res) {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  // Read once, use for rate limiting, never store: `clientKey` hashes it under a
  // rotating salt so this node keeps no table of who called (phase 3b).
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket.remoteAddress ?? "").trim();
  const url = new URL(req.url, `http://localhost`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const bal = await provider.getBalance(relay.address);
      return send(res, 200, { ok: true, relay: relay.address, balance: formatEther(bal), settlement: settlementAddr, forwarder: forwarderAddr ?? null, shieldPool: SHIELD_POOL, shieldFeePAS: formatEther(SHIELD_FEE), shieldMode: SHIELD_FEE > 0n ? "fee" : "sponsor", onboarding: ONBOARD_ENABLED ? { seedPAS: formatEther(ONBOARD_SEED), region: ONBOARD_LAT != null ? { lat: ONBOARD_LAT, lon: ONBOARD_LON, radiusKm: ONBOARD_RADIUS_KM } : null } : null }, origin);
    }

    // ── Message channel: fetch a thread (cheap read, not rate-limited) ───────
    if (req.method === "GET" && url.pathname === "/msg") {
      const topic = url.searchParams.get("topic");
      const since = Number(url.searchParams.get("since") ?? 0);
      if (!okTopic(topic)) return send(res, 400, { error: "bad topic" }, origin);
      return send(res, 200, { messages: threadOf(topic).msgs.filter((m) => m.ts > since) }, origin);
    }

    // ── Photo store: fetch a sealed blob by id (cheap read) ──────────────────
    if (req.method === "GET" && url.pathname === "/photo") {
      const id = url.searchParams.get("id");
      if (!isHex(id)) return send(res, 400, { error: "bad id" }, origin);
      const p = photos.get(id);
      if (!p || p.exp < Date.now()) return send(res, 404, { error: "not found (expired?)" }, origin);
      return send(res, 200, { iv: p.iv, ct: p.ct }, origin);
    }

    if (rateLimited(ip)) return send(res, 429, { error: "rate limited" }, origin);

    // ── Message channel: append an envelope (idempotent by from+seq+kind) ────
    if (req.method === "POST" && url.pathname === "/msg") {
      const { topic, msg } = await readJson(req);
      if (!okTopic(topic)) return send(res, 400, { error: "bad topic" }, origin);
      if (!msg || typeof msg.from !== "string" || typeof msg.seq !== "number" || typeof msg.kind !== "string") {
        return send(res, 400, { error: "bad envelope" }, origin);
      }
      if (JSON.stringify(msg).length > 16 * 1024) return send(res, 413, { error: "message too large" }, origin);
      const t = threadOf(topic);
      const i = t.msgs.findIndex((m) => m.from === msg.from && m.seq === msg.seq && m.kind === msg.kind);
      if (i >= 0) t.msgs[i] = msg; else t.msgs.push(msg);
      t.msgs.sort((a, b) => a.ts - b.ts);
      if (t.msgs.length > MSG_THREAD_MAX) t.msgs = t.msgs.slice(-MSG_THREAD_MAX);
      t.exp = Date.now() + MSG_TTL_MS;
      return send(res, 200, { ok: true, seq: msg.seq }, origin);
    }

    // ── Photo store: store a sealed blob → content id ────────────────────────
    if (req.method === "POST" && url.pathname === "/photo") {
      const { iv, ct } = await readJson(req);
      if (!isHex(iv) || !isHex(ct)) return send(res, 400, { error: "bad sealed photo" }, origin);
      if (ct.length > 3 * 1024 * 1024) return send(res, 413, { error: "photo too large" }, origin);
      const id = sha256Hex(ct);
      photos.set(id, { iv, ct, exp: Date.now() + PHOTO_TTL_MS });
      return send(res, 200, { id }, origin);
    }

    // ── Sponsor gas ──────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/fund") {
      const { address } = await readJson(req);
      if (!isAddress(address)) return send(res, 400, { error: "invalid address" }, origin);

      const key = address.toLowerCase();
      const pending = fundInFlight.get(key);
      if (pending) { const r = await pending; return send(res, r.status, r.body, origin); }

      const work = (async () => {
        const bal = await provider.getBalance(address);
        if (bal >= FUND_MIN) return { status: 200, body: { funded: false, reason: "sufficient", balance: formatEther(bal) } };
        const relayBal = await provider.getBalance(relay.address);
        if (relayBal < FUND_AMOUNT) return { status: 503, body: { error: "relay out of gas budget — operator refill" } };
        // No-reward action → gate on the rolling subsidy budget.
        const cost = await estCostWei(() => provider.estimateGas({ from: relay.address, to: address, value: FUND_AMOUNT }), GAS_FUND);
        // The 5 PAS being sent is the subsidy; the gas to send it is rounding.
        // Counting only the gas made the window bound the postage and not the
        // parcel — see TEST-FINDINGS #19.
        const hold = reserveBudget(cost + FUND_AMOUNT);
        if (PROFIT_GUARD && !hold.ok) { hold.release(); return { status: 402, body: { declined: true, error: "subsidy budget exhausted", action: "fund" } }; }
        let tx;
        try {
          tx = await serialize(async () => {
            const nonce = await allocNonce();
            return relay.sendTransaction({ to: address, value: FUND_AMOUNT, nonce, gasLimit: GAS_FUND });
          });
        } catch (e) { hold.release(); throw e; }
        return { status: 200, body: { funded: true, txHash: tx.hash, amount: formatEther(FUND_AMOUNT) } };
      })();

      fundInFlight.set(key, work);
      try { const r = await work; return send(res, r.status, r.body, origin); }
      finally { fundInFlight.delete(key); }
    }

    // ── Sponsored onboarding: seed a fresh driver/venue wallet (Route A) ──────
    if (req.method === "POST" && url.pathname === "/onboard") {
      if (!ONBOARD_ENABLED) return send(res, 503, { error: "onboarding sponsorship disabled (set ONBOARD_ENABLED=on)" }, origin);
      const { address, role, lat, lon } = await readJson(req);
      if (!isAddress(address)) return send(res, 400, { error: "invalid address" }, origin);
      if (role !== "driver" && role !== "venue") return send(res, 400, { error: "role must be driver|venue" }, origin);
      // One sponsored seed per address (process-local) + never seed an address
      // that already has funds (a fresh onboarding wallet starts empty).
      if (onboarded.has(address.toLowerCase())) return send(res, 429, { error: "already onboarded this address" }, origin);
      const bal = await provider.getBalance(address);
      if (bal >= ONBOARD_SEED) return send(res, 200, { seeded: false, reason: "already funded", balance: formatEther(bal) }, origin);
      // Don't re-seed an already-registered driver.
      if (role === "driver" && drivers) {
        try { if ((await drivers.drivers(address))[0]) return send(res, 409, { error: "driver already registered" }, origin); } catch { /* read failed → allow */ }
      }
      // Region gate for venues (if the relay declares a home region).
      if (role === "venue" && ONBOARD_LAT != null && ONBOARD_LON != null) {
        if (typeof lat !== "number" || typeof lon !== "number") return send(res, 400, { error: "venue onboarding needs lat/lon (µdeg)" }, origin);
        const d = distMeters(ONBOARD_LAT, ONBOARD_LON, lat, lon);
        if (d > ONBOARD_RADIUS_KM * 1000) return send(res, 403, { error: `outside sponsored region (${Math.round(d / 1000)} km > ${ONBOARD_RADIUS_KM} km)` }, origin);
      }
      // Loss-leader → subsidy-budget gated.
      const relayBal = await provider.getBalance(relay.address);
      if (relayBal < ONBOARD_SEED) return send(res, 503, { error: "relay out of onboarding budget — operator refill" }, origin);
      const cost = await estCostWei(() => provider.estimateGas({ from: relay.address, to: address, value: ONBOARD_SEED }), GAS_ONBOARD);
      const hold = reserveBudget(cost + ONBOARD_SEED); // the seed itself is the subsidy, not just gas
      if (PROFIT_GUARD && !hold.ok) { hold.release(); return decline(res, "onboarding budget exhausted", { action: "onboard" }, origin); }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return relay.sendTransaction({ to: address, value: ONBOARD_SEED, nonce, gasLimit: GAS_ONBOARD });
        });
      } catch (e) { hold.release(); throw e; }
      onboarded.add(address.toLowerCase());
      return send(res, 200, { seeded: true, txHash: tx.hash, amount: formatEther(ONBOARD_SEED), role }, origin);
    }

    // ── Relay a settlement call (gasless for the user) ───────────────────────
    if (req.method === "POST" && url.pathname === "/submit") {
      const { method, args } = await readJson(req);
      if (!RELAYABLE.has(method)) return send(res, 400, { error: `method not relayable: ${method}` }, origin);
      if (!Array.isArray(args)) return send(res, 400, { error: "args must be an array" }, origin);
      const orderId = (() => { try { return BigInt(args[0]?.orderId ?? args[0]?.[0]); } catch { return null; } })();
      const cost = await estCostWei(() => settlement[method].estimateGas(...args), GAS_SETTLE);

      let hold = null; // only the unrewarded half (pickup) draws on the subsidy
      if (method === "confirmDropoffZK") {
        // Reward-bearing: the relay's comp (flat service fee + any rebate) must
        // cover the order's CUMULATIVE relayed gas (pickup + bids/forwards already
        // recorded, + this dropoff) × margin.
        const cumulative = (gasSpent.get(String(orderId)) ?? 0n) + cost;
        const comp = await relayCompForOrder(orderId); // valued in NATIVE (null = token order w/ no price)
        if (PROFIT_GUARD && comp === null) {
          return decline(res, "no price to value the relay comp in native", {
            action: "settle", hint: "set RELAY_TOKEN_PRICE (native per token) or enable the asset-conversion quote",
          }, origin);
        }
        if (PROFIT_GUARD && !coversCost(comp, cumulative, MIN_MARGIN)) {
          return decline(res, "relay comp below relayed cost", {
            action: "settle", comp: formatEther(comp), cost: formatEther(cumulative), margin: MIN_MARGIN,
          }, origin);
        }
      } else {
        // confirmPickup: no reward yet → subsidy-budget gated.
        hold = reserveBudget(cost);
        if (PROFIT_GUARD && !hold.ok) { hold.release(); return decline(res, "subsidy budget exhausted", { action: "pickup" }, origin); }
      }

      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return settlement[method](...args, { gasLimit: GAS_SETTLE, nonce });
        });
      } catch (e) { hold?.release(); throw e; }
      if (method === "confirmDropoffZK") gasSpent.delete(String(orderId)); // settled → clear ledger
      else recordOrderGas(orderId, cost); // pickup: track for the dropoff P&L (the subsidy is already held)
      return send(res, 200, { submitted: true, txHash: tx.hash, method }, origin);
    }

    // ── Relay a gasless user action via the EIP-2771 forwarder (F8) ──────────
    if (req.method === "POST" && url.pathname === "/forward") {
      if (!forwarder) return send(res, 503, { error: "forwarder not configured" }, origin);
      const { request } = await readJson(req);
      if (!request || !isAddress(request.to)) return send(res, 400, { error: "bad request" }, origin);
      // Never front value, and only forward to FARE's metatx-aware contracts.
      if (BigInt(request.value ?? 0) !== 0n) return send(res, 400, { error: "value must be 0 (relay never fronts escrow)" }, origin);
      if (!FORWARD_TARGETS.has(String(request.to).toLowerCase())) return send(res, 400, { error: "target not allowlisted" }, origin);
      // No-reward action → subsidy-budget gated; track per-order so the eventual
      // dropoff P&L accounts for it (bids/cancels/accept/tip; rate isn't an order
      // action; a create's order id is learned from the receipt below).
      const fnName = forwardFnName(request);
      const orderId = forwardOrderId(request);
      const cost = await estCostWei(() => forwarder.execute.estimateGas(request), GAS_FORWARD);
      const hold = reserveBudget(cost);
      if (PROFIT_GUARD && !hold.ok) { hold.release(); return decline(res, "subsidy budget exhausted", { action: "forward" }, origin); }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return forwarder.execute(request, { gasLimit: GAS_FORWARD, nonce });
        });
      } catch (e) { hold.release(); throw e; }
      if (orderId != null) recordOrderGas(orderId, cost);
      else if (CREATE_ACTIONS.has(fnName)) {
        // attribute the creation gas once the order id is known (non-blocking)
        tx.wait?.().then((rc) => recordOrderGas(orderIdFromReceipt(rc), cost)).catch(() => {});
      }
      return send(res, 200, { forwarded: true, txHash: tx.hash, from: request.from, fn: fnName }, origin);
    }

    // ── Relay a gasless withdrawal (F8) ──────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/withdraw") {
      if (!vault) return send(res, 503, { error: "vault not configured" }, origin);
      const { account, recipient, deadline, signature } = await readJson(req);
      if (!isAddress(account) || !isAddress(recipient)) return send(res, 400, { error: "bad address" }, origin);
      if (typeof signature !== "string") return send(res, 400, { error: "missing signature" }, origin);
      // Reward-bearing: the withdraw fee must cover this tx's gas × margin.
      const cost = await estCostWei(() => vault.withdrawFor.estimateGas(account, recipient, deadline, signature), GAS_WITHDRAW);
      const fee = await withdrawFeeForAccount(account);
      if (PROFIT_GUARD && !coversCost(fee, cost, MIN_MARGIN)) {
        return decline(res, "withdraw fee below gas cost", {
          action: "withdraw", fee: formatEther(fee), cost: formatEther(cost), margin: MIN_MARGIN,
        }, origin);
      }
      const tx = await serialize(async () => {
        const nonce = await allocNonce();
        return vault.withdrawFor(account, recipient, deadline, signature, { gasLimit: GAS_WITHDRAW, nonce });
      });
      return send(res, 200, { withdrawn: true, txHash: tx.hash, account }, origin);
    }

    // ── Queue a shielded PAYOUT (privacy phase 1) ────────────────────────────
    // Body: { account, bucket, deadline, signature, commitment }
    // The signature authorizes moving `bucket` out of the account's vault
    // balance; the commitment is held here and deposited later in a batch. The
    // two must never share a transaction — see docs/PRIVACY-TIERS.md §3.
    if (req.method === "POST" && url.pathname === "/shield-queue") {
      if (!vault) return send(res, 503, { error: "vault not configured" }, origin);
      if (!keeperStore) return send(res, 503, { error: "this relay does not keep shielded payouts" }, origin);
      const { account, bucket, deadline, signature, commitment } = await readJson(req);
      if (!isAddress(account)) return send(res, 400, { error: "bad account" }, origin);
      if (typeof signature !== "string") return send(res, 400, { error: "missing signature" }, origin);
      if (typeof commitment !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(commitment))
        return send(res, 400, { error: "commitment must be a 32-byte hex string" }, origin);
      let bucketWei;
      try { bucketWei = BigInt(bucket); } catch { return send(res, 400, { error: "bad bucket" }, origin); }

      // Hold the commitment BEFORE spending the ticket. If the queue tx lands and
      // we have not recorded the commitment, the payout is destroyed — the ticket
      // is spent and nothing on-chain says who was owed a note.
      if (!keeperStore.addPending(bucketWei, commitment))
        return send(res, 409, { error: "commitment already queued" }, origin);

      // Unrewarded like sponsor-mode shielded funding: the vault takes no fee on
      // queueing, so this is a subsidy and belongs under the same budget.
      const cost = await estCostWei(
        () => vault.queueShieldCreditFor.estimateGas(account, bucketWei, deadline, signature), GAS_WITHDRAW
      );
      const hold = reserveBudget(cost);
      if (PROFIT_GUARD && !hold.ok) {
        hold.release();
        keeperStore.dropPending(commitment);
        return decline(res, "subsidy budget exhausted", { action: "shield-queue" }, origin);
      }

      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return vault.queueShieldCreditFor(account, bucketWei, deadline, signature, { gasLimit: GAS_WITHDRAW, nonce });
        });
      } catch (e) {
        hold.release();
        keeperStore.dropPending(commitment); // the ticket was never taken
        const msg = e?.shortMessage ?? e?.reason ?? e?.message ?? String(e);
        return send(res, 502, { error: msg }, origin);
      }
      return send(res, 200, { queued: true, txHash: tx.hash, bucket: String(bucketWei) }, origin);
    }

    // ── Sealed bids (privacy phase 4) ────────────────────────────────────────
    // The relay submits the commitment so the CHAIN never sees the bidder, and
    // stores the sealed terms so the CUSTOMER can read them. The terms are
    // sealed to the customer under an ephemeral key, so this node holds
    // ciphertext with no sender — it cannot learn the bid graph either.
    if (req.method === "POST" && url.pathname === "/commit-bid") {
      if (!ordersW) return send(res, 503, { error: "orders not configured" }, origin);
      const { orderId, bidHash, revokeHash, sealed } = await readJson(req);
      if (!/^0x[0-9a-fA-F]{64}$/.test(bidHash ?? "")) return send(res, 400, { error: "bad bidHash" }, origin);
      if (!/^0x[0-9a-fA-F]{64}$/.test(revokeHash ?? "")) return send(res, 400, { error: "bad revokeHash" }, origin);
      if (!sealed?.epk || !sealed?.iv || !sealed?.ct) return send(res, 400, { error: "bad sealed terms" }, origin);
      let id;
      try { id = BigInt(orderId); } catch { return send(res, 400, { error: "bad orderId" }, origin); }

      const cost = await estCostWei(
        () => ordersW.commitBid.estimateGas(id, bidHash, revokeHash), GAS_BID
      );
      const hold = reserveBudget(cost);
      if (PROFIT_GUARD && !hold.ok) {
        hold.release();
        return decline(res, "subsidy budget exhausted", { action: "commit-bid" }, origin);
      }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return ordersW.commitBid(id, bidHash, revokeHash, { gasLimit: GAS_BID, nonce });
        });
      } catch (e) {
        hold.release();
        return send(res, 502, { error: e?.shortMessage ?? e?.reason ?? e?.message ?? String(e) }, origin);
      }

      const key = String(id);
      const box = bidBox.get(key) ?? { bids: [], exp: Date.now() + BID_TTL_MS };
      box.bids.push(sealed);
      box.exp = Date.now() + BID_TTL_MS;
      bidBox.set(key, box);
      return send(res, 200, { committed: true, txHash: tx.hash }, origin);
    }

    // The bid box: opaque to this node, and to anyone who fetches it without the
    // customer's key.
    if (req.method === "GET" && url.pathname === "/bidbox") {
      const key = url.searchParams.get("orderId") ?? "";
      return send(res, 200, { bids: bidBox.get(key)?.bids ?? [] }, origin);
    }

    if (req.method === "POST" && url.pathname === "/revoke-bid") {
      if (!ordersW) return send(res, 503, { error: "orders not configured" }, origin);
      const { orderId, bidHash, revokeSecret } = await readJson(req);
      if (!/^0x[0-9a-fA-F]{64}$/.test(bidHash ?? "")) return send(res, 400, { error: "bad bidHash" }, origin);
      if (!/^0x[0-9a-fA-F]{64}$/.test(revokeSecret ?? "")) return send(res, 400, { error: "bad secret" }, origin);
      let id;
      try { id = BigInt(orderId); } catch { return send(res, 400, { error: "bad orderId" }, origin); }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return ordersW.revokeBid(id, bidHash, revokeSecret, { gasLimit: GAS_BID, nonce });
        });
      } catch (e) {
        return send(res, 502, { error: e?.shortMessage ?? e?.reason ?? e?.message ?? String(e) }, origin);
      }
      return send(res, 200, { revoked: true, txHash: tx.hash }, origin);
    }

    // ── Shield notes (privacy phase 3) ───────────────────────────────────────
    // Insert: the payee's balance becomes a note. The signature covers the
    // commitment, so this relay cannot substitute a note of its own.
    if (req.method === "POST" && url.pathname === "/shield-note") {
      if (!vault) return send(res, 503, { error: "vault not configured" }, origin);
      const { account, bucket, commitment, deadline, signature } = await readJson(req);
      if (!isAddress(account)) return send(res, 400, { error: "bad account" }, origin);
      if (typeof signature !== "string") return send(res, 400, { error: "missing signature" }, origin);
      let bucketWei, commit;
      try { bucketWei = BigInt(bucket); commit = BigInt(commitment); }
      catch { return send(res, 400, { error: "bad bucket/commitment" }, origin); }
      if (commit === 0n) return send(res, 400, { error: "zero commitment" }, origin);

      const cost = await estCostWei(
        () => vault.insertShieldNoteFor.estimateGas(account, bucketWei, commit, deadline, signature), GAS_NOTE
      );
      const hold = reserveBudget(cost);
      if (PROFIT_GUARD && !hold.ok) {
        hold.release();
        return decline(res, "subsidy budget exhausted", { action: "shield-note" }, origin);
      }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return vault.insertShieldNoteFor(account, bucketWei, commit, deadline, signature, { gasLimit: GAS_NOTE, nonce });
        });
      } catch (e) {
        hold.release();
        return send(res, 502, { error: e?.shortMessage ?? e?.reason ?? e?.message ?? String(e) }, origin);
      }
      return send(res, 200, { inserted: true, txHash: tx.hash }, origin);
    }

    // Spend: submit a note's ZK proof. Deliberately unauthenticated — the proof
    // binds the destination commitment, so the relay (or anyone) can pay the gas
    // without being able to redirect the deposit. That is the whole point of
    // phase 3: no keeper trust, no account named.
    if (req.method === "POST" && url.pathname === "/shield-note-spend") {
      if (!vault) return send(res, 503, { error: "vault not configured" }, origin);
      const { proof, root, nullifierHash, bucket, ksCommitment } = await readJson(req);
      if (typeof proof !== "string" || !/^0x[0-9a-fA-F]+$/.test(proof))
        return send(res, 400, { error: "bad proof" }, origin);
      if (typeof ksCommitment !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(ksCommitment))
        return send(res, 400, { error: "ksCommitment must be a 32-byte hex string" }, origin);
      let rootN, nh, bucketWei;
      try { rootN = BigInt(root); nh = BigInt(nullifierHash); bucketWei = BigInt(bucket); }
      catch { return send(res, 400, { error: "bad numeric field" }, origin); }

      // A stale root is the common failure (the tree moves while the payee
      // proves), and it is recoverable client-side — say so rather than burning
      // gas on a revert.
      if (!(await vault.isKnownNoteRoot(rootN)))
        return send(res, 409, { error: "unknown root", retry: true, detail: "rebuild the proof against a current root" }, origin);

      const cost = await estCostWei(
        () => vault.depositShieldNoteZK.estimateGas(proof, rootN, nh, bucketWei, ksCommitment), GAS_NOTE_SPEND
      );
      const hold = reserveBudget(cost);
      if (PROFIT_GUARD && !hold.ok) {
        hold.release();
        return decline(res, "subsidy budget exhausted", { action: "shield-note-spend" }, origin);
      }
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return vault.depositShieldNoteZK(proof, rootN, nh, bucketWei, ksCommitment, { gasLimit: GAS_NOTE_SPEND, nonce });
        });
      } catch (e) {
        hold.release();
        return send(res, 502, { error: e?.shortMessage ?? e?.reason ?? e?.message ?? String(e) }, origin);
      }
      return send(res, 200, { spent: true, txHash: tx.hash }, origin);
    }

    // ── Claim a queued shielded payout's tree position ───────────────────────
    // Public chain state only: where the batch landed and the tree state before
    // it. The recipient replays the insertions locally to derive its own left
    // path, so the note's secrets never leave their device.
    if (req.method === "GET" && url.pathname === "/shield-claim") {
      if (!keeperStore) return send(res, 503, { error: "this relay does not keep shielded payouts" }, origin);
      const commitment = url.searchParams.get("commitment") || "";
      const receipt = keeperStore.receiptFor(commitment);
      if (receipt) return send(res, 200, { deposited: true, ...receipt }, origin);
      if (keeperStore.isPending(commitment)) return send(res, 200, { deposited: false, pending: true }, origin);
      return send(res, 404, { error: "unknown commitment" }, origin);
    }

    // ── Relay a shielded-pool withdrawal that funds a fresh burner (C4) ───────
    // Body: { pA:[2], pB:[2][2], pC:[2], pubSignals:[8], recipient, burner? }
    //   sponsor mode  (SHIELD_FEE==0): recipient must be the burner; pool pays it
    //                  directly, relay eats gas (subsidy-budget gated).
    //   fee mode      (SHIELD_FEE>0):  recipient must be the RELAY; pool pays the
    //                  relay, which forwards (withdrawnValue − fee) to `burner`.
    if (req.method === "POST" && url.pathname === "/shield-withdraw") {
      const { pA, pB, pC, pubSignals, recipient, burner } = await readJson(req);
      if (!Array.isArray(pA) || !Array.isArray(pB) || !Array.isArray(pC) || !Array.isArray(pubSignals) || pubSignals.length !== 8)
        return send(res, 400, { error: "malformed proof" }, origin);
      if (!isAddress(recipient)) return send(res, 400, { error: "bad recipient" }, origin);

      // The proof binds the recipient via context; recompute and require it match
      // pubSignals[5], so we never submit a proof whose payout target we can't see.
      if (contextFor(recipient) !== BigInt(pubSignals[5]))
        return send(res, 400, { error: "recipient does not match proof context" }, origin);

      const feeMode = SHIELD_FEE > 0n;
      const withdrawnValue = BigInt(pubSignals[3]);
      if (feeMode) {
        if (recipient.toLowerCase() !== relay.address.toLowerCase())
          return send(res, 400, { error: "fee mode: proof recipient must be the relay" }, origin);
        if (!isAddress(burner)) return send(res, 400, { error: "fee mode needs a burner destination" }, origin);
        if (withdrawnValue <= SHIELD_FEE) return send(res, 400, { error: "withdrawnValue below fee" }, origin);
      }

      // Economics: fee mode must clear (submit+forward gas) × margin from the fee;
      // sponsor mode is a loss-leader gated on the subsidy budget.
      const submitCost = await estCostWei(() => shieldPool.proxy_withdraw.estimateGas(pA, pB, pC, pubSignals, recipient), GAS_SHIELD);
      let hold = null; // sponsor mode draws on the subsidy; fee mode pays its own way
      if (feeMode) {
        const forwardCost = await estCostWei(async () => GAS_FORWARD_PAS, GAS_FORWARD_PAS);
        if (PROFIT_GUARD && !coversCost(SHIELD_FEE, submitCost + forwardCost, MIN_MARGIN))
          return decline(res, "shield fee below relayed cost", { action: "shield-withdraw", fee: formatEther(SHIELD_FEE), cost: formatEther(submitCost + forwardCost), margin: MIN_MARGIN }, origin);
      } else {
        hold = reserveBudget(submitCost);
        if (PROFIT_GUARD && !hold.ok) { hold.release(); return decline(res, "subsidy budget exhausted", { action: "shield-withdraw" }, origin); }
      }

      // Submit. On "Unknown root" (KS Issue 4: the proof's root fell out of the
      // 16-entry window before mining) return 409 so the client rebuilds against
      // a fresh root and resubmits — the relay can't fix a baked-in root itself.
      let tx;
      try {
        tx = await serialize(async () => {
          const nonce = await allocNonce();
          return shieldPool.proxy_withdraw(pA, pB, pC, pubSignals, recipient, { gasLimit: GAS_SHIELD, nonce });
        });
      } catch (e) {
        hold?.release();
        const msg = e?.shortMessage ?? e?.reason ?? e?.message ?? String(e);
        if (/unknown root/i.test(msg)) return send(res, 409, { error: "unknown root", retry: true, detail: "root evicted (KS Issue 4) — rebuild proof against a fresh root" }, origin);
        return send(res, 502, { error: msg }, origin);
      }
      await tx.wait?.().catch(() => {});
      if (!feeMode) return send(res, 200, { submitted: true, txHash: tx.hash, mode: "sponsor", recipient }, origin);

      // Fee mode: forward (withdrawnValue − fee) to the burner; keep the fee.
      const net = withdrawnValue - SHIELD_FEE;
      const ftx = await serialize(async () => {
        const nonce = await allocNonce();
        return relay.sendTransaction({ to: burner, value: net, nonce, gasLimit: GAS_FORWARD_PAS });
      });
      return send(res, 200, { submitted: true, txHash: tx.hash, forwardTxHash: ftx.hash, mode: "fee", burner, net: formatEther(net), fee: formatEther(SHIELD_FEE) }, origin);
    }

    return send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    // A rejected request is the client's fault, not ours — carry the status the
    // thrower chose (e.g. readJson's 413) instead of flattening it to a 500,
    // which would tell a caller to retry a body that will never be accepted.
    return send(res, e?.httpStatus ?? 500, { error: e?.shortMessage ?? e?.message ?? String(e) }, origin);
  }
}

const server = http.createServer(handler);

// ── Fee-recovery loop (F6-swap): sell accrued USDC → PAS when gas dips ────────
// When the relay's native gas falls below treasury.cfg.floorWei, sweep its accrued
// fee-token balance out of the vault and swap it to PAS on the local DEX (up to
// cfg.targetWei), refuelling itself. Same sentinel rail as the burner coverage
// swap; the relay's own EVM key signs. Gated by RELAY_FEE_RECOVERY=on.
const feeTokenAddr = FEE_TOKEN || addr.stablecoin;
async function feeRecoveryTick() {
  if (FEE_ASSET_ID == null) return; // need the pallet-assets id to swap
  try {
    const gasWei = await provider.getBalance(relay.address);
    if (!shouldTopUp(gasWei, swapCfg.floorWei)) return;
    // 1. sweep the relay's accrued vault USDC to its own balance (so it's swappable)
    if (vault) {
      const vBal = await vault.tokenBalanceOf(feeTokenAddr, relay.address).catch(() => 0n);
      if (vBal > 0n) await serialize(async () => {
        const nonce = await allocNonce();
        const tx = await vault.withdrawToken(feeTokenAddr, { gasLimit: GAS_WITHDRAW, nonce });
        await tx.wait?.(); return tx;
      });
    }
    // 2. price + plan (reuse treasury.planSwap) + swap USDC → PAS
    const token = new Contract(feeTokenAddr, ["function balanceOf(address) view returns (uint256)"], provider);
    const feeTokenWei = await token.balanceOf(relay.address);
    const price = await assetConversionQuote(FEE_ASSET_ID, FEE_TOKEN_DECIMALS).catch(() => priceFraction());
    const plan = planSwap({ gasWei, feeTokenWei, tokenDecimals: FEE_TOKEN_DECIMALS, nativeDecimals: 18, price });
    if (!plan) return; // no price / nothing to swap / below min
    const res = await serialize(() => executeRecoverySwap(plan, { signer: relay, assetId: FEE_ASSET_ID, gasLimit: GAS_SWAP }));
    console.log(`[relay] fee-recovery: gas ${formatEther(gasWei)} < floor → swapped ${plan.swapTokenWei} fee-units → PAS (${res.txHash})`);
  } catch (e) { console.error("[relay] fee-recovery error:", e?.shortMessage ?? e?.message ?? e); }
}
if (FEE_RECOVERY && FEE_ASSET_ID != null) setInterval(feeRecoveryTick, SWAP_POLL_MS).unref?.();

// ── shielded-payout keeper tick ──────────────────────────────────────────────
// Deposits held commitments once a bucket has minBatch of them AND the oldest
// ticket has cleared the contract's dwell. Both floors are enforced on-chain
// too; checking here only saves a guaranteed-revert transaction.
async function shieldKeeperTick() {
  if (!vault || !keeperStore) return;
  try {
    await keeperTick({
      vault, pool: shieldPool, provider, store: keeperStore, maxPerTx: SHIELD_MAX_PER_TX,
      submit: (call) => serialize(async () => {
        const nonce = await allocNonce();
        return call({ gasLimit: GAS_SHIELD_BATCH, nonce });
      }),
      log: (m) => console.log(`[relay] ${m}`),
    });
  } catch (e) { console.error("[relay] shield-keeper error:", e?.shortMessage ?? e?.message ?? e); }
}
if (SHIELD_KEEPER) setInterval(shieldKeeperTick, SHIELD_KEEPER_POLL_MS).unref?.();

// Exported for tests: they listen on an ephemeral port themselves. Importing
// this module must never bind PORT or the suite collides with a running relay.
export { server, handler, relay, provider, clientKey, rateLimitKeys };

if (IS_MAIN) server.listen(PORT, BIND, () => {
  console.log(`[relay] FARE venue relay on ${BIND}:${PORT}`);
  console.log(`[relay] relay account: ${relay.address}`);
  console.log(`[relay] settlement:    ${settlementAddr}`);
  console.log(`[relay] relayable:     ${[...RELAYABLE].join(", ")}`);
  console.log(`[relay] forwarder:     ${forwarderAddr ?? "(none — /forward disabled)"}`);
  console.log(`[relay] vault:         ${vaultAddr ?? "(none — /withdraw disabled)"}`);
  console.log(`[relay] shield pool:   ${SHIELD_POOL}  (${SHIELD_FEE > 0n ? `fee mode, ${formatEther(SHIELD_FEE)} PAS` : "sponsor mode"})`);
  console.log(`[relay] onboarding:    ${ONBOARD_ENABLED ? `on (seed ${formatEther(ONBOARD_SEED)} PAS${ONBOARD_LAT != null ? `, region ${ONBOARD_RADIUS_KM}km` : ""})` : "off"}`);
  console.log(`[relay] profit guard:  ${PROFIT_GUARD ? `on (margin ${MIN_MARGIN}×, budget ${formatEther(GAS_BUDGET)} PAS / ${BUDGET_WINDOW_MS / 3_600_000}h)` : "OFF (sponsors everything)"}`);
  console.log(`[relay] fee-recovery:  ${FEE_RECOVERY ? (FEE_ASSET_ID != null ? `on (USDC→PAS, asset ${FEE_ASSET_ID}, floor ${formatEther(swapCfg.floorWei)}/target ${formatEther(swapCfg.targetWei)} PAS, every ${SWAP_POLL_MS / 1000}s)` : "ON but RELAY_FEE_ASSET_ID unset — disabled") : "off"}`);
});
