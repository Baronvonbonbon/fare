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
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther, isAddress } from "ethers";

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
];
const vault = vaultAddr ? new Contract(vaultAddr, VAULT_ABI, relay) : null;
const GAS_WITHDRAW = 200_000n;

// ── tx serialization: chain all sends so concurrent requests don't collide on
//    the relay account's nonce ──────────────────────────────────────────────
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn));

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

    if (rateLimited(ip)) return send(res, 429, { error: "rate limited" }, origin);

    // ── Sponsor gas ──────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/fund") {
      const { address } = await readJson(req);
      if (!isAddress(address)) return send(res, 400, { error: "invalid address" }, origin);
      const bal = await provider.getBalance(address);
      if (bal >= FUND_MIN) return send(res, 200, { funded: false, reason: "sufficient", balance: formatEther(bal) }, origin);
      const relayBal = await provider.getBalance(relay.address);
      if (relayBal < FUND_AMOUNT) return send(res, 503, { error: "relay out of gas budget — operator refill" }, origin);
      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return relay.sendTransaction({ to: address, value: FUND_AMOUNT, nonce, gasLimit: GAS_FUND });
      });
      return send(res, 200, { funded: true, txHash: tx.hash, amount: formatEther(FUND_AMOUNT) }, origin);
    }

    // ── Relay a settlement call (gasless for the user) ───────────────────────
    if (req.method === "POST" && url.pathname === "/submit") {
      const { method, args } = await readJson(req);
      if (!RELAYABLE.has(method)) return send(res, 400, { error: `method not relayable: ${method}` }, origin);
      if (!Array.isArray(args)) return send(res, 400, { error: "args must be an array" }, origin);
      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return settlement[method](...args, { gasLimit: GAS_SETTLE, nonce });
      });
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
      const tx = await serialize(async () => {
        const nonce = await provider.getTransactionCount(relay.address);
        return forwarder.execute(request, { gasLimit: GAS_FORWARD, nonce });
      });
      return send(res, 200, { forwarded: true, txHash: tx.hash, from: request.from }, origin);
    }

    // ── Relay a gasless withdrawal (F8) ──────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/withdraw") {
      if (!vault) return send(res, 503, { error: "vault not configured" }, origin);
      const { account, recipient, deadline, signature } = await readJson(req);
      if (!isAddress(account) || !isAddress(recipient)) return send(res, 400, { error: "bad address" }, origin);
      if (typeof signature !== "string") return send(res, 400, { error: "missing signature" }, origin);
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
});
