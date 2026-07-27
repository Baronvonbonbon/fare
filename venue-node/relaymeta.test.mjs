// Relay metadata defences (TEST-PLAN B5). Run: npm test (node --test).
//
// Phase 3b puts the relay itself in the threat model (PRIVACY-TIERS §1): the
// chain-side work makes a payout unlinkable, and the transport can hand that
// back. The client half — spreading requests across the pool, keeping the two
// halves of a shield-note flow on different relays, padding bodies to fixed
// blocks — is covered in web/src/relaypick.test.ts.
//
// This is the relay half, and specifically the claim in PRIVACY-STATUS that
// "client addresses are hashed under a rotating salt so no table of callers is
// kept". That is a statement about what is IN MEMORY, so the test looks: it
// drives real requests through the real handler and then inspects the limiter's
// keys.

import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
delete process.env.PINE_RPC;
process.env.RELAY_PRIVATE_KEY = TEST_KEY;
process.env.RELAY_RPC_URL = "http://127.0.0.1:1"; // unroutable; nothing here needs a chain
process.env.RATE_MAX = "3";

const { server, clientKey, rateLimitKeys } = await import("./relay.mjs");

const base = await new Promise((r) =>
  server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
after(() => server.close());

const IPS = ["203.0.113.7", "198.51.100.42", "2001:db8::1"];
/// /bidbox sits AFTER the limiter (unlike /health and the cheap reads), so it is
/// the endpoint that exercises it.
const call = (ip) => fetch(`${base}/bidbox?orderId=1`, { headers: { "x-forwarded-for": ip } });

const realNow = Date.now;
after(() => { Date.now = realNow; });

// ── the key is a keyed hash, not the address ────────────────────────────────

test("clientKey never returns, contains, or is derivable from the address", () => {
  for (const ip of IPS) {
    const k = clientKey(ip);
    assert.notEqual(k, ip);
    assert.ok(!k.includes(ip), `key for ${ip} contains the address`);
    // Fixed width regardless of input length, so the key leaks nothing about
    // the address's shape either — an IPv6 caller must not be distinguishable
    // from an IPv4 one by key length alone.
    assert.equal(k.length, 16, `key for ${ip} is not fixed-width`);
    assert.match(k, /^[A-Za-z0-9+/]{16}$/);
  }
  const lengths = new Set(IPS.map((ip) => clientKey(ip).length));
  assert.equal(lengths.size, 1, "key length varies with the address");
});

test("clientKey is stable within a window and distinct between callers", () => {
  // Rate limiting only needs to tell callers APART, not identify them — both
  // halves of that matter, so both are asserted.
  for (const ip of IPS) assert.equal(clientKey(ip), clientKey(ip));
  const keys = IPS.map(clientKey);
  assert.equal(new Set(keys).size, IPS.length, "two callers collided");
});

// ── nothing durable is kept ─────────────────────────────────────────────────

test("the limiter's table holds no client address, only digests", async () => {
  for (const ip of IPS) await call(ip);

  const keys = rateLimitKeys();
  assert.ok(keys.length >= IPS.length, "callers were not distinguished at all");
  for (const ip of IPS) {
    assert.ok(!keys.includes(ip), `the table contains the raw address ${ip}`);
    for (const k of keys) {
      assert.ok(!k.includes(ip), `key ${k} embeds ${ip}`);
      // Also reject a partial: an IP's leading octets would be enough to
      // locate a caller's network.
      assert.ok(!k.includes(ip.split(".")[0] + "." + (ip.split(".")[1] ?? "")), `key ${k} embeds part of ${ip}`);
    }
  }
});

test("rotating the salt makes the previous window's keys unrecoverable", () => {
  // The salt rotates every RATE_WINDOW_MS × 10 (10 minutes). After it turns,
  // the same caller hashes differently and the old table is dropped — so even a
  // memory dump taken later cannot re-derive who was talking before.
  const ip = IPS[0];
  const before = clientKey(ip);
  assert.ok(rateLimitKeys().length > 0, "nothing to rotate away");

  const t0 = realNow();
  Date.now = () => t0 + 11 * 60_000; // past the rotation threshold

  const after_ = clientKey(ip);
  assert.notEqual(after_, before, "the salt did not rotate");
  // The old keys are gone, not merely unreachable.
  assert.ok(!rateLimitKeys().includes(before), "a pre-rotation key survived");

  Date.now = realNow;
});

// ── the limiter still works, without knowing who anyone is ──────────────────

test("one caller is throttled without affecting another", async () => {
  Date.now = realNow;
  const noisy = "192.0.2.99";
  const quiet = "192.0.2.100";

  let throttled = false;
  for (let i = 0; i < 8 && !throttled; i++) throttled = (await call(noisy)).status === 429;
  assert.ok(throttled, "the noisy caller was never limited");

  // The quiet caller is unaffected — the limiter distinguishes them purely by
  // digest, with no address retained on either side.
  assert.equal((await call(quiet)).status, 200, "an unrelated caller was throttled too");
});

test("a throttled caller is released once its own window elapses", async () => {
  // Deliberately advanced past RATE_WINDOW_MS but NOT past the salt rotation
  // (10 windows), so this tests the per-caller counter reset on its own. An
  // earlier version jumped 11 minutes and therefore proved nothing about
  // either mechanism in particular — disabling salt rotation entirely left it
  // green, because the counter reset carried it.
  const ip = "192.0.2.123";
  let throttled = false;
  for (let i = 0; i < 8 && !throttled; i++) throttled = (await call(ip)).status === 429;
  assert.ok(throttled);

  const t0 = realNow();
  Date.now = () => t0 + 61_000; // one window on, nine short of a rotation
  assert.equal((await call(ip)).status, 200, "the counter did not reset with the window");
  Date.now = realNow;
});

// ── the cross-tier padding contract ─────────────────────────────────────────

test("the relay strips exactly the padding field the client emits", async () => {
  // web/src/relaypick.ts pads to 512-byte blocks under the key `_pad`; the relay
  // knows nothing about the block size and only has to drop that field. The
  // field NAME is therefore the entire contract between the two, and it is
  // pinned on both sides — here, and in relaypick.test.ts.
  Date.now = realNow;
  const topic = "0x" + "ab".repeat(32);
  const msg = { from: "0xcafe", seq: 1, kind: "text", ts: 1, ct: "0xdead" };

  const send = (extra) =>
    fetch(`${base}/msg`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.200" },
      body: JSON.stringify({ topic, msg, ...extra }),
    });

  assert.equal((await send({ _pad: "0".repeat(400) })).status, 200);
  const { messages } = await (await fetch(`${base}/msg?topic=${topic}`)).json();
  assert.equal(messages.length, 1);
  assert.equal(Object.hasOwn(messages[0], "_pad"), false);
});
