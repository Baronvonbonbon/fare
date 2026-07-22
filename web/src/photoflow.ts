// Proof-of-delivery photo transport (B6) — capture/compress + blob store/fetch.
// The sealing crypto is photo.ts (fresh-key AES-GCM, crypto-shred); the KEY
// travels E2E over channel.ts (kind:"photo"); the sealed BLOB is stored here.
//
// Store chain: the shared KV store (/api/photo, P1) first, then discovered venue
// relays (/photo, P2). Content-addressed by SHA-256(ct) with a ~2-week TTL —
// storage sees only ciphertext.

import type { SealedPhoto } from "./photo";
import { relayPool } from "./pool";

const PHOTO_PATH = "/api/photo";

/// Downscale + re-encode an image File/Blob to a small JPEG (Uint8Array). The
/// canvas re-encode strips EXIF/GPS by construction; keep the parcel in frame,
/// not the person (docs/PHOTOS.md). Returns compressed JPEG bytes.
export async function compressImage(file: Blob, maxDim = 800, quality = 0.6): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unsupported");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", quality)
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function endpoints(pathAndQuery: string): string[] {
  return [`${PHOTO_PATH}${pathAndQuery}`, ...relayPool().map((b) => `${b}/photo${pathAndQuery}`)];
}

/// Store a sealed photo; returns its content id. Tries the shared KV store, then
/// venue relays.
export async function storeSealed(sealed: SealedPhoto): Promise<string> {
  for (const url of endpoints("")) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sealed) });
      if (!res.ok) continue; // 503 (unconfigured) → next
      const j = (await res.json()) as { id?: string };
      if (j.id) return j.id;
    } catch {
      /* try next */
    }
  }
  throw new Error("photo storage unavailable (bind PHOTO_KV or run a venue relay)");
}

/// Fetch a sealed photo by id (to be opened with photo.ts openPhoto + the key).
export async function fetchSealed(id: string): Promise<SealedPhoto> {
  for (const url of endpoints(`?id=${id}`)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const j = (await res.json()) as { iv?: string; ct?: string };
      if (j.iv && j.ct) return { iv: j.iv, ct: j.ct };
    } catch {
      /* try next */
    }
  }
  throw new Error("photo not found (expired?)");
}

/// Wrap decrypted JPEG bytes as an object URL for an <img>. Revoke when done.
export function photoObjectUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as any], { type: "image/jpeg" }));
}
