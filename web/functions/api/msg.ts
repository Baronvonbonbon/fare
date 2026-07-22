// Cloudflare Pages Function — order-scoped message relay (B3/B2/B6 channel).
//
// Store-and-forward for E2E-encrypted, order-scoped messages (docs/MESSAGING.md
// P1). The relay is trusted only for AVAILABILITY — content is sealed client-side
// (web/src/msg.ts), so it never sees plaintext. Threads are keyed by an opaque
// per-order `topic` (a hash of the orderId), so the relay can't group a user's
// threads or read who-said-what beyond timing.
//
//   POST /api/msg  { topic, msg }         → append an envelope (idempotent by from+seq)
//   GET  /api/msg?topic=…&since=<ms>      → { messages: [...] } newer than `since`
//
// Secret setup: bind a KV namespace named MSG_KV in Cloudflare Pages
// (Settings → Functions → KV bindings). Until bound, returns { configured:false }
// and the client falls back to a venue-node relay (P2) or the QR floor.
// Minimal shape of the KV binding we use (avoids depending on
// @cloudflare/workers-types; Pages injects the real KVNamespace at runtime).
interface MsgKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  MSG_KV?: MsgKV;
}

interface Envelope {
  from: string; // sender (per-order burner address)
  seq: number; // sender's own monotonic seq — (from,seq) dedupes idempotently
  kind: string; // "hello" | "chat" | "loc" | "photo"
  ts: number; // client timestamp (ms)
  pub?: string; // sender's secp256k1 pubkey (cleartext; public anyway) for key bootstrap
  iv?: string; // sealed content (chat/photo): AES-GCM iv
  ct?: string; // sealed content ciphertext
  data?: unknown; // small cleartext payload (e.g. coarse driver location for B2)
}

const THREAD_MAX = 200; // cap thread length (anti-spam)
const TTL_SECONDS = 86_400; // threads expire a day after last write (metadata hygiene)
const MSG_MAX_BYTES = 16 * 1024;
const key = (topic: string) => `thread:${topic}`;
const okTopic = (t: unknown): t is string => typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" },
  });

export const onRequestOptions = async () => json({}, 204);

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.MSG_KV) return json({ configured: false, messages: [] }, 503);
  const url = new URL(request.url);
  const topic = url.searchParams.get("topic");
  const since = Number(url.searchParams.get("since") ?? 0);
  if (!okTopic(topic)) return json({ error: "bad topic" }, 400);
  const raw = await env.MSG_KV.get(key(topic));
  const thread: Envelope[] = raw ? JSON.parse(raw) : [];
  return json({ messages: thread.filter((m) => m.ts > since) });
};

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.MSG_KV) return json({ configured: false }, 503);
  let body: { topic?: string; msg?: Envelope };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const { topic, msg } = body;
  if (!okTopic(topic)) return json({ error: "bad topic" }, 400);
  if (!msg || typeof msg.from !== "string" || typeof msg.seq !== "number" || typeof msg.kind !== "string") {
    return json({ error: "bad envelope" }, 400);
  }
  if (JSON.stringify(msg).length > MSG_MAX_BYTES) return json({ error: "message too large" }, 413);

  const raw = await env.MSG_KV.get(key(topic));
  const thread: Envelope[] = raw ? JSON.parse(raw) : [];
  // Idempotent append: (from, seq) is the message identity — a retry replaces.
  const i = thread.findIndex((m) => m.from === msg.from && m.seq === msg.seq && m.kind === msg.kind);
  if (i >= 0) thread[i] = msg;
  else thread.push(msg);
  thread.sort((a, b) => a.ts - b.ts);
  const capped = thread.slice(-THREAD_MAX);
  await env.MSG_KV.put(key(topic), JSON.stringify(capped), { expirationTtl: TTL_SECONDS });
  return json({ ok: true, seq: msg.seq });
};
