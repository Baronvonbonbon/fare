// Cloudflare Pages Function — POST /api/menu
//
// Publishes a venue menu JSON to IPFS via the DATUM upload proxy, keeping that
// proxy's Bearer key server-side (never in the browser bundle) — same pattern
// as the drip faucet. Returns { cid }. Menu READS go straight to a public IPFS
// gateway (no auth needed) — see web/src/menu.ts.
//
// Secret setup: Cloudflare Pages -> Settings -> Environment variables:
//   IPFS_ADD_URL  = https://ipfs.datum.javcon.io/add   (the DATUM proxy /add)
//   IPFS_API_KEY  = <the proxy's Bearer token>
// Local dev: web/.dev.vars. Until set, /api/menu returns { configured:false }
// and the client falls back to device-local storage.
interface Env {
  IPFS_ADD_URL?: string;
  IPFS_API_KEY?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.IPFS_ADD_URL || !env.IPFS_API_KEY) {
    return json({ configured: false, error: "ipfs not configured" }, 503);
  }

  let body: string;
  try {
    body = JSON.stringify(await request.json());
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (body.length > 64 * 1024) return json({ error: "menu too large (max 64 KB)" }, 413);

  try {
    const r = await fetch(env.IPFS_ADD_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.IPFS_API_KEY}`, "content-type": "application/json" },
      body,
    });
    const data = (await r.json().catch(() => ({}))) as { cid?: string; error?: string };
    if (!r.ok || !data.cid) return json({ error: data.error ?? "ipfs upload failed" }, 502);
    return json({ cid: data.cid });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
};
