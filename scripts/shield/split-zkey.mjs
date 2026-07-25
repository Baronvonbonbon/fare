#!/usr/bin/env node
// Split a Groth16 proving key into static-host-friendly parts.
//
// Cloudflare Pages rejects any single asset over 25 MiB, and withdraw_v7.zkey
// is 32.8 MiB — so the monolith can never live under web/public/. Instead the
// repo carries CHUNKS plus a manifest; both the PWA (fetch + concat) and the
// node scripts (read + concat) rebuild the key in memory and hand snarkjs a
// Uint8Array, which fastfile accepts exactly like a path or URL.
//
// Re-run this whenever the circuit artifacts are regenerated (e.g. a v8 key):
//   node scripts/shield/split-zkey.mjs path/to/withdraw_v8.zkey
//
// The manifest records the whole-key sha256 so a truncated or half-cached part
// surfaces as an explicit integrity error instead of a baffling invalid proof.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "web/public/shield");
const PART_BYTES = 12 * 1024 * 1024; // 3 parts for v7; comfortably under the 25 MiB cap

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/shield/split-zkey.mjs <withdraw_vN.zkey>");
  process.exit(1);
}

const name = path.basename(src);
const data = fs.readFileSync(src);
const sha256 = createHash("sha256").update(data).digest("hex");

// Drop any parts from a previous split so a shrinking key can't leave orphans
// behind that the manifest no longer lists.
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.startsWith(`${name}.part`)) fs.unlinkSync(path.join(OUT_DIR, f));
}

const parts = [];
for (let off = 0, i = 0; off < data.length; off += PART_BYTES, i++) {
  const part = `${name}.part${i}`;
  const chunk = data.subarray(off, Math.min(off + PART_BYTES, data.length));
  fs.writeFileSync(path.join(OUT_DIR, part), chunk);
  parts.push({ name: part, bytes: chunk.length });
}

const manifest = { name, bytes: data.length, sha256, parts };
fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${name}: ${data.length} bytes → ${parts.length} parts in web/public/shield/`);
for (const p of parts) console.log(`  ${p.name}  ${(p.bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`  sha256 ${sha256}`);
