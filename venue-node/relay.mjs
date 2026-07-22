#!/usr/bin/env node
// FARE venue relay — gasless transactions, run by a venue node.
//
// The first component of the venue appliance (see docs/NETWORK-ARCHITECTURE.md).
// Goal: zero gas friction for users in the venue's region, with NO contract
// changes, by doing the two things that are safe to relay:
//
//   POST /fund   — sponsor gas: top up a user's burner so it can transact
//                  (a region-local, decentralized version of /api/drip).
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
import { createHash } from "node:crypto";
import { JsonRpcProvider, Wallet, Contract, Interface, parseEther, formatEther, isAddress } from "ethers";
import { rebateWei, withdrawFeeWei, coversCost, withinBudget, windowSpent } from "./economics.mjs";

const PORT = Number(process.env.RELAY_PORT || 8788);
const RPC = process.env.RELAY_RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const KEY = process.env.RELAY_PRIVATE_KEY;
const FUND_AMOUNT = parseEther(process.env.FUND_AMOUNT_PAS || "5");
const FUND_MIN = parseEther(process.env.FUND_MIN_PAS || "2");
const ADDRESS_BOOK = process.env.ADDRESS_BOOK || "../deployed-addresses.json";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
const GAS_SETTLE = 500_000_000n; // Paseo weight-scale limit for a settlement call
const GAS_FUND = 100_000n; // a plain transfer; keeps the fee reservation small
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 20); // requests / IP / window

// ── Profitability guard (F6/F8 economics) ────────────────────────────────────
// The relay only sponsors what pays off: a reward-bearing action (dropoff
// settlement → F6 rebate; withdrawFor → F8 fee) is relayed only if the reward
// covers the fare's CUMULATIVE relayed gas × margin; no-reward actions (fund /
// bids / pickup / cancels / rate) are sponsored as loss-leaders under a rolling
// gas budget. Set RELAY_PROFIT_GUARD=off to sponsor everything (old behavior).
const PROFIT_GUARD = (process.env.RELAY_PROFIT_GUARD || "on").toLowerCase() !== "off";
const MIN_MARGIN = Number(process.env.RELAY_MIN_MARGIN || 1.25); // reward ≥ cost × this
const GAS_BUDGET = parseEther(process.env.RELAY_GAS_BUDGET_PAS || "50"); // no-reward spend / window
const BUDGET_WINDOW_MS = Number(process.env.RELAY_BUDGET_WINDOW_MS || 86_400_000); // 1 day

if (!KEY) {
  console.error("[relay] RELAY_PRIVATE_KEY not set. Exiting.");
  process.exit(1);
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
];
const vault = vaultAddr ? new Contract(vaultAddr, VAULT_ABI, relay) : null;
const GAS_WITHDRAW = 200_000n;

// ── Reward reads + calldata decoding for the profitability guard ─────────────
const ordersAddr = process.env.ORDERS_ADDRESS || addr.orders;
const ORDERS_READ_ABI = [
  "function orders(uint256) view returns (address customer, uint64 venueId, uint8 status, address driver, uint96 orderValue, uint96 tip, uint96 fare, uint96 maxFare, uint96 escrow, bytes32 dropCommit, uint64 createdAt, uint64 pickupWindowSecs, uint64 deliveryWindowSecs, uint64 pickupDeadline, uint64 deliveryDeadline)",
  "function feeBps() view returns (uint16)",
  "function relayRebateBps() view returns (uint16)",
  // forwardable order actions — used to decode a /forward request's orderId
  "function placeBid(uint256 orderId, uint96 amount)",
  "function withdrawBid(uint256 orderId)",
  "function cancelOpen(uint256 orderId)",
  "function cancelAssigned(uint256 orderId)",
  "function abandonOrder(uint256 orderId)",
];
const orders = ordersAddr ? new Contract(ordersAddr, ORDERS_READ_ABI, provider) : null;
const ordersIface = new Interface(ORDERS_READ_ABI);
const ORDER_ACTIONS = new Set(["placeBid", "withdrawBid", "cancelOpen", "cancelAssigned", "abandonOrder"]);

// ── tx serialization: chain all sends so concurrent requests don't collide on
//    the relay account's nonce ──────────────────────────────────────────────
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn));

// ── profitability-guard state + helpers ──────────────────────────────────────
const gasSpent = new Map(); // orderId(string) → cumulative relayed cost (wei)
const budget = { spent: 0n, start: Date.now() }; // rolling no-reward subsidy window
const recordOrderGas = (orderId, wei) => {
  if (orderId == null || !wei) return;
  const k = String(orderId);
  gasSpent.set(k, (gasSpent.get(k) ?? 0n) + wei);
};
const recordBudget = (wei) => { windowSpent(budget, Date.now(), BUDGET_WINDOW_MS); budget.spent += wei; };
const budgetRoom = (wei) => withinBudget(windowSpent(budget, Date.now(), BUDGET_WINDOW_MS), wei, GAS_BUDGET);

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
async function rebateForOrder(orderId) {
  if (!orders) return 0n;
  try {
    const [o, feeBps, rebBps] = await Promise.all([orders.orders(orderId), orders.feeBps(), orders.relayRebateBps()]);
    return rebateWei(o.fare, feeBps, rebBps);
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

// ── crude per-IP rate limit ──────────────────────────────────────────────────
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) ?? { n: 0, t: now };
  if (now - rec.t > RATE_WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  hits.set(ip, rec);
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
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket.remoteAddress ?? "").trim();
  const url = new URL(req.url, `http://localhost`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const bal = await provider.getBalance(relay.address);
      return send(res, 200, { ok: true, relay: relay.address, balance: formatEther(bal), settlement: settlementAddr, forwarder: forwarderAddr ?? null }, origin);
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
      const bal = await provider.getBalance(address);
      if (bal >= FUND_MIN) return send(res, 200, { funded: false, reason: "sufficient", balance: formatEther(bal) }, origin);
      const relayBal = await provider.getBalance(relay.address);
      if (relayBal < FUND_AMOUNT) return send(res, 503, { error: "relay out of gas budget — operator refill" }, origin);
      // No-reward action → gate on the rolling subsidy budget.
      const cost = await estCostWei(() => provider.estimateGas({ from: relay.address, to: address, value: FUND_AMOUNT }), GAS_FUND);
      if (PROFIT_GUARD && !budgetRoom(cost)) return decline(res, "subsidy budget exhausted", { action: "fund" }, origin);
      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return relay.sendTransaction({ to: address, value: FUND_AMOUNT, nonce, gasLimit: GAS_FUND });
      });
      recordBudget(cost);
      return send(res, 200, { funded: true, txHash: tx.hash, amount: formatEther(FUND_AMOUNT) }, origin);
    }

    // ── Relay a settlement call (gasless for the user) ───────────────────────
    if (req.method === "POST" && url.pathname === "/submit") {
      const { method, args } = await readJson(req);
      if (!RELAYABLE.has(method)) return send(res, 400, { error: `method not relayable: ${method}` }, origin);
      if (!Array.isArray(args)) return send(res, 400, { error: "args must be an array" }, origin);
      const orderId = (() => { try { return BigInt(args[0]?.orderId ?? args[0]?.[0]); } catch { return null; } })();
      const cost = await estCostWei(() => settlement[method].estimateGas(...args), GAS_SETTLE);

      if (method === "confirmDropoffZK") {
        // Reward-bearing: the F6 rebate must cover the fare's CUMULATIVE relayed
        // gas (pickup + bids already recorded, + this dropoff) × margin.
        const cumulative = (gasSpent.get(String(orderId)) ?? 0n) + cost;
        const rebate = await rebateForOrder(orderId);
        if (PROFIT_GUARD && !coversCost(rebate, cumulative, MIN_MARGIN)) {
          return decline(res, "fare reward below relayed cost", {
            action: "settle", rebate: formatEther(rebate), cost: formatEther(cumulative), margin: MIN_MARGIN,
          }, origin);
        }
      } else if (PROFIT_GUARD && !budgetRoom(cost)) {
        // confirmPickup: no reward yet → subsidy-budget gated.
        return decline(res, "subsidy budget exhausted", { action: "pickup" }, origin);
      }

      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return settlement[method](...args, { gasLimit: GAS_SETTLE, nonce });
      });
      if (method === "confirmDropoffZK") gasSpent.delete(String(orderId)); // settled → clear ledger
      else { recordBudget(cost); recordOrderGas(orderId, cost); } // pickup: subsidy + track for dropoff P&L
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
      // dropoff P&L accounts for it (bids/cancels; rate isn't an order action).
      const orderId = forwardOrderId(request);
      const cost = await estCostWei(() => forwarder.execute.estimateGas(request), GAS_FORWARD);
      if (PROFIT_GUARD && !budgetRoom(cost)) return decline(res, "subsidy budget exhausted", { action: "forward" }, origin);
      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return forwarder.execute(request, { gasLimit: GAS_FORWARD, nonce });
      });
      recordBudget(cost);
      recordOrderGas(orderId, cost);
      return send(res, 200, { forwarded: true, txHash: tx.hash, from: request.from }, origin);
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
        const nonce = await provider.getTransactionCount(relay.address);
        return vault.withdrawFor(account, recipient, deadline, signature, { gasLimit: GAS_WITHDRAW, nonce });
      });
      return send(res, 200, { withdrawn: true, txHash: tx.hash, account }, origin);
    }

    return send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    return send(res, 500, { error: e?.shortMessage ?? e?.message ?? String(e) }, origin);
  }
});

server.listen(PORT, () => {
  console.log(`[relay] FARE venue relay on :${PORT}`);
  console.log(`[relay] relay account: ${relay.address}`);
  console.log(`[relay] settlement:    ${settlementAddr}`);
  console.log(`[relay] relayable:     ${[...RELAYABLE].join(", ")}`);
  console.log(`[relay] forwarder:     ${forwarderAddr ?? "(none — /forward disabled)"}`);
  console.log(`[relay] vault:         ${vaultAddr ?? "(none — /withdraw disabled)"}`);
  console.log(`[relay] profit guard:  ${PROFIT_GUARD ? `on (margin ${MIN_MARGIN}×, budget ${formatEther(GAS_BUDGET)} PAS / ${BUDGET_WINDOW_MS / 3_600_000}h)` : "OFF (sponsors everything)"}`);
});
