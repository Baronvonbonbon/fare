// Cloudflare Pages Function — POST /api/asset
//
// Menu artwork (item photos, venue logo/banner) to IPFS, keeping the upload
// proxy's Bearer key server-side. Returns { cid }. Reads go straight to a public
// gateway — see `imageUrl` in web/src/menu.ts.
//
// Separate from /api/menu because the shapes differ in kind: a menu is JSON
// capped at 64 KB, an image is opaque bytes an order of magnitude larger. Inlining
// artwork into the menu JSON would blow that cap on the third dish, and putting
// the cap up would push the whole catalog through one object that has to be
// re-fetched whenever a single photo changes.
//
// Secret setup mirrors /api/menu — Cloudflare Pages → Settings → Environment:
//   IPFS_ADD_URL  = <an authenticated IPFS add endpoint>
//   IPFS_API_KEY  = <the proxy's Bearer token>
// Local dev: web/.dev.vars. Until set, this returns { configured:false } and the
// client surfaces "IPFS is not configured" rather than pretending to store it.
interface Env {
  IPFS_ADD_URL?: string;
  IPFS_API_KEY?: string;
}

// Comfortably above what `compressImage` produces (long edge 1280, JPEG q0.8)
// and well under a Pages Function's request limit.
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });

export const onRequestOptions = async () => json({}, 204);

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.IPFS_ADD_URL || !env.IPFS_API_KEY) {
    return json({ configured: false, error: "ipfs not configured" }, 503);
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.includes(type)) {
    return json({ error: `unsupported image type '${type}' (use ${ALLOWED.join(", ")})` }, 415);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "empty body" }, 400);
  if (bytes.byteLength > MAX_BYTES) return json({ error: "image too large (downscale first)" }, 413);

  try {
    const r = await fetch(env.IPFS_ADD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.IPFS_API_KEY}`, "content-type": type },
      body: bytes,
    });
    const data = (await r.json().catch(() => ({}))) as { cid?: string; error?: string };
    if (!r.ok || !data.cid) return json({ error: data.error ?? "ipfs upload failed" }, 502);
    return json({ cid: data.cid });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
};
