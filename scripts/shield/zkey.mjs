// Rebuild the withdraw proving key from the chunks under web/public/shield/.
//
// The monolithic .zkey can't be published (Cloudflare Pages caps assets at
// 25 MiB; see split-zkey.mjs), so the parts are the source of truth. snarkjs
// takes the reassembled Uint8Array wherever it takes a file path — fastfile's
// readExisting short-circuits on Uint8Array before it ever touches the disk.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIELD_DIR = path.join(ROOT, "web/public/shield");

export const WITHDRAW_WASM = path.join(SHIELD_DIR, "withdraw_v7.wasm");

let cached = null;

/// The v7 withdraw proving key as a Uint8Array, verified against the manifest
/// digest. Cached per-process: reassembly is ~34 MB of copying.
export function loadWithdrawZkey() {
  if (cached) return cached;
  const manifest = JSON.parse(fs.readFileSync(path.join(SHIELD_DIR, "withdraw_v7.zkey.json"), "utf8"));
  const key = Buffer.concat(manifest.parts.map((p) => fs.readFileSync(path.join(SHIELD_DIR, p.name))));
  if (key.length !== manifest.bytes) {
    throw new Error(`zkey reassembly: got ${key.length} bytes, manifest says ${manifest.bytes}`);
  }
  const sha256 = createHash("sha256").update(key).digest("hex");
  if (sha256 !== manifest.sha256) throw new Error(`zkey reassembly: sha256 ${sha256} != ${manifest.sha256}`);
  cached = new Uint8Array(key);
  return cached;
}
