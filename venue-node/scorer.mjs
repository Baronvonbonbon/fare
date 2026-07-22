#!/usr/bin/env node
// FARE data-availability scorer — challenge-response + client reports (F5).
//
// The off-chain, P2 tier of the incentive model (docs/NETWORK-ARCHITECTURE.md §3):
// you can't reward what you can't measure, so before any on-chain DA rewards (F6)
// this measures who is actually serving the region's menus. NOT Filecoin-grade
// proof-of-replication — challenge-response + reputation is the pragmatic tier.
//
// Per monitored node (its Caddy base URL, exposing /agent/ + /ipfs/):
//   1. Read its region manifest (agent status → manifestCid → servedCids).
//   2. Challenge: pick random claimed CIDs; fetch a random BYTE-RANGE from the
//      node and check it byte-for-byte against canonical content (from a trusted
//      reference gateway), within a latency bound. A node that dropped a pin, or
//      serves garbage, fails.
//   3. Blend with client availability reports (POST /report) → a per-node DA
//      score in [0,1]. Publish a leaderboard (GET /leaderboard).
//
// Integrity anchor: content is CID-addressed, so canonical bytes from the
// reference gateway are trustworthy; comparing the node's range against them
// proves the node holds the real content, not just *a* response.
//
// Read-only; holds no keys. Run:  node --env-file=.env scorer.mjs   (Node 22+)

import http from "node:http";

const PORT = Number(process.env.SCORER_PORT || 8790);
// Nodes to monitor: comma-separated Caddy base URLs (…/ exposing /agent + /ipfs).
const NODES = (process.env.SCORER_NODES || "").split(",").map((s) => s.trim()).filter(Boolean);
const REFERENCE_GW = (process.env.REFERENCE_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/?$/, "/");
const SAMPLE = Number(process.env.SCORER_SAMPLE || 5); // CIDs challenged per round
const LATENCY_MS = Number(process.env.SCORER_LATENCY_MS || 8000); // per-challenge bound
const ROUND_MS = Number(process.env.SCORER_ROUND_MS || 300_000); // 5 min between rounds
const CHALLENGE_WEIGHT = Number(process.env.SCORER_CHALLENGE_WEIGHT || 0.7); // vs client reports
const REPORT_HALFLIFE_MS = Number(process.env.SCORER_REPORT_HALFLIFE_MS || 3_600_000); // 1h decay

// ── per-node state ────────────────────────────────────────────────────────────
// challenge EWMA in [0,1]; client reports as decayed weighted good/total.
const nodes = new Map(); // base → { challenge, reports:{good,total,at}, lastRound, manifestCid, servedCids, error }
const state = (base) =>
  nodes.get(base) ??
  (nodes.set(base, { challenge: null, reports: { good: 0, total: 0, at: Date.now() }, lastRound: 0, manifestCid: null, servedCids: 0, error: null }),
  nodes.get(base));
for (const n of NODES) state(n);

const trim = (b) => b.replace(/\/?$/, "/");
async function getJson(url, ms = LATENCY_MS) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function getBytes(url, headers, ms = LATENCY_MS) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!r.ok && r.status !== 206) throw new Error(`${url} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const pick = (arr, k) => {
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [c[i], c[j]] = [c[j], c[i]]; }
  return c.slice(0, k);
};

// ── one challenge round against a node ────────────────────────────────────────
async function challengeNode(base) {
  const st = state(base);
  const gw = `${trim(base)}ipfs/`;
  try {
    const status = await getJson(`${trim(base)}agent/`);
    st.manifestCid = status.manifestCid ?? null;
    if (!st.manifestCid) throw new Error("node has no manifest yet");
    const manifest = await getJson(`${gw}${st.manifestCid}`);
    const cids = Array.isArray(manifest.servedCids) ? manifest.servedCids : [];
    st.servedCids = cids.length;
    if (cids.length === 0) throw new Error("manifest serves no CIDs");

    let pass = 0, attempts = 0;
    for (const cid of pick(cids, Math.min(SAMPLE, cids.length))) {
      attempts += 1;
      try {
        const canonical = await getBytes(`${REFERENCE_GW}${cid}`);
        if (canonical.length === 0) { attempts -= 1; continue; } // can't judge; skip
        // random byte-range within the object
        const a = (Math.random() * canonical.length) | 0;
        const b = Math.min(canonical.length, a + 1 + ((Math.random() * 512) | 0));
        const t0 = performance.now();
        const got = await getBytes(`${gw}${cid}`, { Range: `bytes=${a}-${b - 1}` });
        const ms = performance.now() - t0;
        // Gateways may honor Range (→ exact slice) or return the full object.
        const slice = got.length === b - a ? got : got.subarray(a, b);
        if (ms <= LATENCY_MS && sameBytes(slice, canonical.subarray(a, b))) pass += 1;
      } catch { /* miss counts as a fail */ }
    }
    const roundScore = attempts > 0 ? pass / attempts : null;
    if (roundScore !== null) {
      st.challenge = st.challenge === null ? roundScore : 0.6 * st.challenge + 0.4 * roundScore; // EWMA
    }
    st.error = null;
    st.lastRound = Date.now();
  } catch (e) {
    st.challenge = st.challenge === null ? 0 : 0.6 * st.challenge; // decay toward 0 on failure
    st.error = e?.message ?? String(e);
    st.lastRound = Date.now();
  }
}

async function round() {
  await Promise.all([...nodes.keys()].map(challengeNode));
  setTimeout(round, ROUND_MS);
}

// ── client availability reports ───────────────────────────────────────────────
// Decay the running totals toward now so stale reports fade (half-life).
function decayReports(r) {
  const dt = Date.now() - r.at;
  if (dt <= 0) return;
  const f = Math.pow(0.5, dt / REPORT_HALFLIFE_MS);
  r.good *= f; r.total *= f; r.at = Date.now();
}
function recordReport(base, ok) {
  const st = state(base);
  decayReports(st.reports);
  st.reports.total += 1;
  if (ok) st.reports.good += 1;
}

// ── blended score + leaderboard ───────────────────────────────────────────────
function scoreOf(st) {
  decayReports(st.reports);
  const clientScore = st.reports.total > 0 ? st.reports.good / st.reports.total : null;
  const ch = st.challenge;
  if (ch === null && clientScore === null) return null;
  if (ch === null) return clientScore;
  if (clientScore === null) return ch;
  return CHALLENGE_WEIGHT * ch + (1 - CHALLENGE_WEIGHT) * clientScore;
}
function leaderboard() {
  const rows = [...nodes.entries()].map(([base, st]) => ({
    node: base,
    score: scoreOf(st),
    challenge: st.challenge,
    clientReports: Math.round(st.reports.total),
    servedCids: st.servedCids,
    manifestCid: st.manifestCid,
    lastRound: st.lastRound ? new Date(st.lastRound).toISOString() : null,
    error: st.error,
  }));
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { kind: "fare-da-leaderboard", updatedAt: new Date().toISOString(), nodes: rows };
}

// ── HTTP: GET /leaderboard, POST /report {node, ok}, GET /health ──────────────
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error("body too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
}

// Exposed for unit tests (the scoring math is pure; the network round is not).
export { scoreOf, decayReports, sameBytes, leaderboard, recordReport, state };

// Only boot the server + challenge loop when run directly (not when imported
// by a test). import.meta.filename is absolute, as is process.argv[1].
if (import.meta.filename === process.argv[1]) {
  http
    .createServer(async (req, res) => {
      if (req.method === "OPTIONS") return send(res, 204, {});
      const url = new URL(req.url, "http://localhost");
      try {
        if (req.method === "GET" && (url.pathname === "/leaderboard" || url.pathname === "/")) return send(res, 200, leaderboard());
        if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, monitoring: nodes.size });
        if (req.method === "POST" && url.pathname === "/report") {
          const { node, ok } = await readJson(req);
          if (typeof node !== "string" || !nodes.has(node)) return send(res, 400, { error: "unknown or missing node" });
          recordReport(node, !!ok);
          return send(res, 200, { recorded: true });
        }
        return send(res, 404, { error: "not found" });
      } catch (e) {
        return send(res, 500, { error: e?.message ?? String(e) });
      }
    })
    .listen(PORT, () => {
      console.log(`[scorer] FARE DA scorer on :${PORT}`);
      console.log(`[scorer] monitoring: ${NODES.length ? NODES.join(", ") : "(none — set SCORER_NODES)"}`);
      console.log(`[scorer] reference gateway: ${REFERENCE_GW}`);
      if (NODES.length) round();
    });
}
