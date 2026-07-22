// Cloudflare Pages Function — proof-of-delivery photo blob store (B6).
//
// The "authorized submitter → transient storage" step from docs/PHOTOS.md, for
// the demo. The browser sends only the CIPHERTEXT (already sealed under a fresh
// random key by web/src/photo.ts), so the store learns nothing. Content-addressed
// by a SHA-256 of the ciphertext, with a ~2-week TTL that mirrors the Polkadot
// Bulletin Chain's retention — "don't renew" = expiry (crypto-shred handles the
// rest: once the key is discarded the blob is unrecoverable regardless).
//
//   POST /api/photo  { iv, ct }   → { id }   (id = sha256(ct))
//   GET  /api/photo?id=<id>       → { iv, ct }
//
// Setup: bind a KV namespace named PHOTO_KV in Cloudflare Pages. Until bound,
// returns { configured:false } and the client falls back to a venue relay (/photo).
interface PhotoKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  PHOTO_KV?: PhotoKV;
}

const TTL_SECONDS = 14 * 24 * 3600; // ~2 weeks, like Bulletin Chain retention
const MAX_BYTES = 3 * 1024 * 1024; // sealed photo (hex) — driver client downscales first
const isHex = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]*$/.test(s);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" },
  });

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return "0x" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestOptions = async () => json({}, 204);

export const onRequestGet = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.PHOTO_KV) return json({ configured: false }, 503);
  const id = new URL(request.url).searchParams.get("id");
  if (!isHex(id)) return json({ error: "bad id" }, 400);
  const raw = await env.PHOTO_KV.get(`photo:${id}`);
  if (!raw) return json({ error: "not found (expired?)" }, 404);
  return json(JSON.parse(raw));
};

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.PHOTO_KV) return json({ configured: false }, 503);
  let body: { iv?: string; ct?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!isHex(body.iv) || !isHex(body.ct)) return json({ error: "bad sealed photo" }, 400);
  if (body.ct.length > MAX_BYTES) return json({ error: "photo too large (downscale first)" }, 413);
  const id = await sha256Hex(body.ct);
  await env.PHOTO_KV.put(`photo:${id}`, JSON.stringify({ iv: body.iv, ct: body.ct }), { expirationTtl: TTL_SECONDS });
  return json({ id });
};
