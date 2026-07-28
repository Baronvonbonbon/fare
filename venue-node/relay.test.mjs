// Relay HTTP surface (TEST-PLAN C1, first chunk). Run: npm test (node --test).
//
// relay.mjs is the one network-facing service in the system and it holds a
// funded key, so until now the largest untested surface in the repo was also
// the most exposed. This covers the part that needs no chain: routing, CORS,
// input validation, the rate limiter, and the two in-memory stores.
//
// The RPC endpoint below is deliberately unroutable. Every assertion in this
// file therefore doubles as proof that the path under test never reached for
// the chain — a validation branch that fell through to a provider call would
// hang or throw instead of returning its status.
//
// Still uncovered, and needing a local chain: the authorization / replay /
// signature matrix on /submit, /forward, /withdraw, /shield-* (TEST-PLAN C1
// second chunk) and the profitability guard's decline paths (C2).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Hardhat's well-known account #1. Public knowledge, funded nowhere real — the
// relay only needs a syntactically valid key to construct its Wallet.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// PINE_RPC takes priority over RELAY_RPC_URL inside relay.mjs, so an operator
// with one exported would otherwise point these tests at a real node.
delete process.env.PINE_RPC;
process.env.RELAY_PRIVATE_KEY = TEST_KEY;
process.env.RELAY_RPC_URL = "http://127.0.0.1:1"; // unroutable, on purpose (see above)
process.env.RATE_MAX = "10000";                   // the limiter gets its own instance below
process.env.ALLOWED_ORIGINS = "https://fare.example";

const { server } = await import("./relay.mjs");

const base = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
after(() => server.close());

const get = (path, init) => fetch(`${base}${path}`, init);
const post = (path, body, init = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

const topicA = "0x" + "a1".repeat(32);
const topicB = "0x" + "b2".repeat(32);
const envelope = (over = {}) => ({ from: "0xcafe", seq: 1, kind: "text", ts: 1000, ct: "0xdead", ...over });

// ── routing + CORS ───────────────────────────────────────────────────────────

test("unknown routes 404 as JSON rather than hanging or crashing", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
});

test("OPTIONS preflight is answered without reaching a handler", async () => {
  const res = await get("/msg", { method: "OPTIONS", headers: { origin: "https://fare.example" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://fare.example");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
});

test("an origin outside ALLOWED_ORIGINS is not echoed back", async () => {
  // The allowlist is configured to one origin, so a foreign one must not be
  // reflected — reflecting it would defeat having a list at all.
  const res = await get("/nope", { headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), "https://fare.example");
  assert.equal(res.headers.get("vary"), "Origin");
});

// ── /msg: the order-scoped channel (in-memory, ciphertext only) ──────────────

test("GET /msg rejects a malformed topic", async () => {
  for (const t of ["", "abc", "0x123", "0x" + "zz".repeat(32), "0x" + "a1".repeat(31)]) {
    const res = await get(`/msg?topic=${encodeURIComponent(t)}`);
    assert.equal(res.status, 400, `topic ${JSON.stringify(t)} should be rejected`);
    assert.deepEqual(await res.json(), { error: "bad topic" });
  }
});

test("GET /msg on an unseen topic is an empty thread, not a 404", async () => {
  const res = await get(`/msg?topic=${topicA}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { messages: [] });
});

test("POST /msg appends, and GET returns it on that topic only", async () => {
  assert.equal((await post("/msg", { topic: topicA, msg: envelope() })).status, 200);

  const mine = await (await get(`/msg?topic=${topicA}`)).json();
  assert.equal(mine.messages.length, 1);
  assert.equal(mine.messages[0].ct, "0xdead");

  // Topics are independent — a leak across them would cross orders.
  assert.deepEqual(await (await get(`/msg?topic=${topicB}`)).json(), { messages: [] });
});

test("POST /msg is idempotent on (from, seq, kind) — a retry replaces, never duplicates", async () => {
  const t = "0x" + "c3".repeat(32);
  await post("/msg", { topic: t, msg: envelope({ ct: "0x01" }) });
  await post("/msg", { topic: t, msg: envelope({ ct: "0x02" }) }); // same from/seq/kind
  const { messages } = await (await get(`/msg?topic=${t}`)).json();
  assert.equal(messages.length, 1, "a retried envelope must not append twice");
  assert.equal(messages[0].ct, "0x02", "the retry should win");
});

test("GET /msg?since filters by timestamp", async () => {
  const t = "0x" + "d4".repeat(32);
  await post("/msg", { topic: t, msg: envelope({ seq: 1, ts: 100 }) });
  await post("/msg", { topic: t, msg: envelope({ seq: 2, ts: 300 }) });
  const { messages } = await (await get(`/msg?topic=${t}&since=200`)).json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].seq, 2);
});

test("POST /msg rejects envelopes missing the fields dedupe depends on", async () => {
  for (const msg of [null, {}, { from: "0x1" }, { from: "0x1", seq: "1", kind: "text" }, { from: 1, seq: 1, kind: "text" }]) {
    const res = await post("/msg", { topic: topicA, msg });
    assert.equal(res.status, 400, `envelope ${JSON.stringify(msg)} should be rejected`);
    assert.deepEqual(await res.json(), { error: "bad envelope" });
  }
});

test("POST /msg caps envelope size at 16 KiB", async () => {
  const res = await post("/msg", { topic: topicA, msg: envelope({ ct: "0x" + "ab".repeat(9000) }) });
  assert.equal(res.status, 413);
});

test("client padding is transparent — any block size behaves identically", async () => {
  // web/src/relaypick.ts pads bodies to fixed 512-byte blocks so their SIZE
  // carries no information about which request this is. That defense is only
  // real if the relay accepts a padded body exactly like an unpadded one, so
  // this pins the compatibility rather than the (unobservable) delete: adding
  // strict unknown-key rejection here would silently break the client's
  // metadata protection, and this test is what would catch it.
  const results = [];
  for (const [i, pad] of [null, 0, 600, 4096].entries()) {
    const t = `0x${"e5".repeat(31)}${(i + 16).toString(16)}`;
    const body = { topic: t, msg: envelope() };
    if (pad !== null) body._pad = "0".repeat(pad);
    const res = await post("/msg", body);
    const { messages } = await (await get(`/msg?topic=${t}`)).json();
    results.push({ status: res.status, count: messages.length, ct: messages[0]?.ct });
  }
  // Every padding size must produce the same accepted, stored outcome.
  for (const r of results) assert.deepEqual(r, { status: 200, count: 1, ct: "0xdead" });
});

// ── /photo: sealed proof-of-delivery blobs (in-memory, ciphertext only) ──────

test("POST /photo is content-addressed by sha256(ct) and round-trips", async () => {
  const blob = { iv: "0x" + "11".repeat(12), ct: "0x" + "22".repeat(64) };
  const { id } = await (await post("/photo", blob)).json();
  assert.equal(id, "0x" + createHash("sha256").update(blob.ct).digest("hex"));

  const got = await (await get(`/photo?id=${id}`)).json();
  assert.deepEqual(got, blob);

  // Same ciphertext → same id, so a re-upload cannot fork the store.
  const again = await (await post("/photo", blob)).json();
  assert.equal(again.id, id);
});

test("POST /photo rejects non-hex iv or ct", async () => {
  for (const b of [{ iv: "zz", ct: "0x11" }, { iv: "0x11", ct: "nothex" }, { iv: null, ct: "0x11" }, {}]) {
    assert.equal((await post("/photo", b)).status, 400, `${JSON.stringify(b)} should be rejected`);
  }
});

test("GET /photo 400s a malformed id and 404s an unknown one", async () => {
  assert.equal((await get("/photo?id=notahexid")).status, 400);
  assert.equal((await get(`/photo?id=0x${"99".repeat(32)}`)).status, 404);
});

// ── input validation on the money endpoints (pre-chain branches) ─────────────

test("POST /fund rejects a malformed address before touching the chain", async () => {
  for (const address of ["", "0x", "not-an-address", "0x1234", null, 42]) {
    const res = await post("/fund", { address });
    assert.equal(res.status, 400, `${JSON.stringify(address)} should be rejected`);
    assert.deepEqual(await res.json(), { error: "invalid address" });
  }
});

test("POST /submit relays only the two allowlisted settlement methods", async () => {
  // The allowlist is the whole safety argument for /submit: these two carry
  // their own signatures and ignore msg.sender. Anything else must bounce.
  for (const method of ["transfer", "withdraw", "confirmDropoff", "", null, "__proto__"]) {
    const res = await post("/submit", { method, args: [] });
    assert.equal(res.status, 400, `method ${JSON.stringify(method)} must not be relayable`);
    assert.match((await res.json()).error, /not relayable/);
  }
});

test("POST /submit requires args to be an array", async () => {
  const res = await post("/submit", { method: "confirmPickup", args: { orderId: 1 } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "args must be an array" });
});

test("POST /onboard is refused while sponsorship is off (the default)", async () => {
  const res = await post("/onboard", { address: "0x" + "11".repeat(20), role: "driver" });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /disabled/);
});

// ── malformed transport ──────────────────────────────────────────────────────

test("malformed JSON is an error status, not a crashed process", async () => {
  const res = await post("/msg", "{not json");
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  // The process must still be serving afterwards — that is the real assertion.
  assert.equal((await get("/nope")).status, 404);
});

test("an oversized body is rejected and the server survives", async () => {
  // readJson caps at 256 KiB. It throws, so this currently surfaces as a 500
  // rather than a 413 — asserted as "an error status" so the test pins the
  // property that matters (no crash, no silent accept) without cementing the
  // exact code. See the note in TEST-PLAN C1.
  const res = await post("/photo", { iv: "0x11", ct: "0x" + "ab".repeat(200_000) });
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  assert.equal((await get("/nope")).status, 404);
});

// ── the rate limiter, on its own instance ────────────────────────────────────

test("the rate limiter cuts a caller off without keeping any address table", async () => {
  // A second module instance so a low RATE_MAX cannot starve the tests above.
  // Re-importing under a fresh query re-evaluates module scope, which is how
  // this file reaches config branches that are read once at import.
  process.env.RATE_MAX = "3";
  const { server: limited } = await import("./relay.mjs?rate-limit");
  const url = await new Promise((r) =>
    limited.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${limited.address().port}`)));
  after(() => limited.close());

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await fetch(`${url}/bidbox?orderId=1`)).status);
  assert.ok(codes.includes(429), `expected a 429 within 6 calls, saw ${codes.join(",")}`);

  // Cheap reads are answered before the limiter, so chat and photo fetches
  // keep working for everyone else while an abuser is being throttled.
  assert.equal((await fetch(`${url}/msg?topic=${topicA}`)).status, 200);
});

test("sponsored onboarding validates role and address once enabled", async () => {
  process.env.RATE_MAX = "10000";
  process.env.ONBOARD_ENABLED = "on";
  const { server: onboarding } = await import("./relay.mjs?onboard");
  const url = await new Promise((r) =>
    onboarding.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${onboarding.address().port}`)));
  after(() => onboarding.close());

  const send = (body) => fetch(`${url}/onboard`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  assert.equal((await send({ address: "nope", role: "driver" })).status, 400);

  const bad = await send({ address: "0x" + "11".repeat(20), role: "arbiter" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /role must be driver\|venue/);
});

// ── TEST-FINDINGS #3: an oversized body is the caller's fault ────────────────

test("an oversized body is refused as 413, not reported as a server error", async () => {
  // readJson caps the body at 256 KB. That rejection used to fall through the
  // handler's catch-all and surface as a 500, which tells a client the server
  // broke and the request is worth retrying — it is neither.
  const res = await post("/msg", JSON.stringify({ topic: topicA, msg: { pad: "x".repeat(300 * 1024) } }));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
});

// ── TEST-FINDINGS #2: concurrent /fund must not double-fund ─────────────────

test("two concurrent /fund calls for one address send exactly one transaction", async () => {
  process.env.RATE_MAX = "10000";
  const mod = await import("./relay.mjs?fundrace");
  const url = await new Promise((r) =>
    mod.server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${mod.server.address().port}`)));
  after(() => mod.server.close());

  const burner = "0x" + "cd".repeat(20);
  const relayAddr = mod.relay.address.toLowerCase();

  // Both callers read the burner as empty — the interleaving that made each of
  // them decide, independently, that it had to fund.
  let released;
  const gate = new Promise((r) => { released = r; });
  mod.provider.getBalance = async (addr) => {
    if (String(addr).toLowerCase() === relayAddr) return 10n ** 21n; // relay is solvent
    await gate;                                                      // hold caller 1 inside the check
    return 0n;                                                       // burner is empty
  };
  mod.provider.getTransactionCount = async () => 0;
  mod.provider.getFeeData = async () => ({ maxFeePerGas: 1n });
  mod.provider.estimateGas = async () => 21_000n;

  let sends = 0;
  mod.relay.sendTransaction = async () => { sends++; return { hash: "0x" + "ab".repeat(32) }; };

  const fund = () => fetch(`${url}/fund`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: burner }),
  });

  const both = Promise.all([fund(), fund()]);
  setTimeout(released, 50); // let the second request arrive while the first is mid-check
  const [a, b] = await both;

  assert.equal(sends, 1, "the second caller must not send its own funding transaction");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // The coalesced caller reports the same outcome, so the client contract is
  // indistinguishable from having made a single call.
  assert.deepEqual(await a.json(), await b.json());
});
