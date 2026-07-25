#!/usr/bin/env node
/**
 * setup-shieldnote.mjs — trusted setup for the shield-note circuit (privacy
 * phase 3, docs/PRIVACY-TIERS.md §7).
 *
 * Produces what the on-chain verifier and the browser prover need:
 *   1. Compile circuits/shieldnote.circom              (requires circom ≥ 2.1)
 *   2. Groth16 setup over Hermez powers-of-tau lvl 14  (16,384 constraints).
 *      The circuit has ~4.6k non-linear constraints but ~9.8k TOTAL, and the
 *      Groth16 domain must cover the total — lvl 13 (8,192) is not enough.
 *   3. circuits/build/shieldnote.zkey                  — proving key
 *   4. circuits/build/shieldnote_js/shieldnote.wasm    — witness calculator
 *   5. circuits/build/shieldnote-vk.json               — verification key
 *   6. circuits/build/setShieldVK-calldata.json        — FareShieldVerifier args
 *   7. web/public/shield/shieldnote.{wasm,zkey}        — served to the PWA prover
 *   8. test/fixtures/zk-shieldnote.json                — a real proof for the
 *      Solidity verifier test
 *
 * Prerequisites: circom on PATH (or ./circom), plus circomlib + snarkjs.
 *
 * NOTE: the single-party contribution below is NOT a production ceremony. Fine
 * for testnet/demo; a mainnet deploy must run a real multi-party ceremony and
 * publish the transcript before calling setVerifyingKey (which is lock-once).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poseidon1, poseidon2 } from "poseidon-lite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CIRCUITS = path.join(ROOT, "circuits");
const BUILD = path.join(CIRCUITS, "build");
const WEB_SHIELD = path.join(ROOT, "web", "public", "shield");
const FIXTURES = path.join(ROOT, "test", "fixtures");

export const DEPTH = 16; // 65,536 notes — must match shieldnote.circom and FareVault

const PTAU_URL = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau";
const PTAU_PATH = path.join(CIRCUITS, "ptau14.ptau");
const SRC = path.join(CIRCUITS, "shieldnote.circom");
const R1CS = path.join(BUILD, "shieldnote.r1cs");
const WASM = path.join(BUILD, "shieldnote_js", "shieldnote.wasm");
const ZKEY0 = path.join(BUILD, "shieldnote_0000.zkey");
const ZKEY = path.join(BUILD, "shieldnote.zkey");
const VK_PATH = path.join(BUILD, "shieldnote-vk.json");

// ── the note scheme, shared with the contract and the client ────────────────
// leaf = Poseidon(Poseidon(nullifier, secret), bucket)
export const noteCommitment = (nullifier, secret, bucket) =>
  poseidon2([poseidon2([nullifier, secret]), bucket]);
export const nullifierHashOf = (nullifier) => poseidon1([nullifier]);

/// Empty-subtree roots. The circuit only sees siblings, so these matter to the
/// CONTRACT and the client — and they must agree exactly or every proof fails.
export function zeroHashes(depth = DEPTH) {
  const z = [0n];
  for (let i = 1; i <= depth; i++) z.push(poseidon2([z[i - 1], z[i - 1]]));
  return z;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

async function main() {
  for (const d of [BUILD, WEB_SHIELD, FIXTURES]) mkdirSync(d, { recursive: true });

  const CIRCOM = (() => {
    try { execSync("circom --version", { stdio: "pipe" }); return "circom"; } catch {}
    const local = path.join(ROOT, "circom");
    if (existsSync(local)) return local;
    throw new Error("circom not found — install it (https://docs.circom.io) or place the binary at ./circom");
  })();
  const LIB = path.join(ROOT, "node_modules");
  if (!existsSync(path.join(LIB, "circomlib"))) {
    throw new Error("circomlib not installed — run: npm install --save-dev circomlib circomlibjs snarkjs");
  }

  console.log("→ Compiling shieldnote.circom ...");
  execSync(`${CIRCOM} ${SRC} --r1cs --wasm --sym -o ${BUILD} -l ${LIB}`, { stdio: "inherit" });

  if (!existsSync(PTAU_PATH)) {
    console.log("→ Downloading powers-of-tau level 14 (~18 MB) ...");
    execSync(`curl -L "${PTAU_URL}" -o "${PTAU_PATH}"`, { stdio: "inherit" });
  } else {
    console.log("✓ ptau14 present");
  }

  const snarkjs = await import("snarkjs");
  console.log("→ groth16 setup ...");
  await snarkjs.zKey.newZKey(R1CS, PTAU_PATH, ZKEY0);
  const entropy = createHash("sha256").update(Date.now().toString()).digest("hex");
  await snarkjs.zKey.contribute(ZKEY0, ZKEY, "fare-shieldnote-testnet", entropy);
  console.log(`✓ shieldnote.zkey written (${(statSync(ZKEY).size / 1e6).toFixed(1)} MB)`);

  // ── VK + setVerifyingKey calldata ─────────────────────────────────────────
  const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
  writeFileSync(VK_PATH, JSON.stringify(vk, null, 2));

  const g1 = (p) => [p[0], p[1]];
  // snarkjs G2: [[x_real, x_imag], [y_real, y_imag]]; EIP-197 wants
  // [x_imag, x_real, y_imag, y_real].
  const g2 = (p) => [p[0][1], p[0][0], p[1][1], p[1][0]];
  writeFileSync(
    path.join(BUILD, "setShieldVK-calldata.json"),
    JSON.stringify({
      alpha1: g1(vk.vk_alpha_1),
      beta2: g2(vk.vk_beta_2),
      gamma2: g2(vk.vk_gamma_2),
      delta2: g2(vk.vk_delta_2),
      IC0: g1(vk.IC[0]), // constant
      IC1: g1(vk.IC[1]), // root
      IC2: g1(vk.IC[2]), // nullifierHash
      IC3: g1(vk.IC[3]), // bucket
      IC4: g1(vk.IC[4]), // ksCommitment
    }, null, 2)
  );
  console.log("✓ shieldnote-vk.json + setShieldVK-calldata.json written");

  // ── serve to the PWA ──────────────────────────────────────────────────────
  copyFileSync(WASM, path.join(WEB_SHIELD, "shieldnote.wasm"));
  copyFileSync(ZKEY, path.join(WEB_SHIELD, "shieldnote.zkey"));
  const zkeyMB = statSync(ZKEY).size / 1024 / 1024;
  console.log(`✓ copied to web/public/shield/ (zkey ${zkeyMB.toFixed(1)} MiB)`);
  if (zkeyMB > 25) {
    console.log("  ! over Cloudflare Pages' 25 MiB asset cap — split it:");
    console.log("    node scripts/shield/split-zkey.mjs web/public/shield/shieldnote.zkey");
  }

  // ── fixture: a real proof for the Solidity verifier test ──────────────────
  console.log("→ generating a proof fixture ...");
  const bucket = 10n ** 18n;
  const nullifier = 111222333444555n;
  const secret = 999888777666555n;
  const leaf = noteCommitment(nullifier, secret, bucket);

  // A one-leaf tree: our leaf at index 0, empty siblings all the way up.
  const zeros = zeroHashes();
  const pathElements = [];
  const pathIndices = [];
  let node = leaf;
  for (let i = 0; i < DEPTH; i++) {
    pathElements.push(zeros[i].toString());
    pathIndices.push(0);
    node = poseidon2([node, zeros[i]]);
  }
  const ksCommitment = poseidon2([42n, 43n]); // opaque to the circuit; just bound

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root: node.toString(),
      nullifierHash: nullifierHashOf(nullifier).toString(),
      bucket: bucket.toString(),
      ksCommitment: ksCommitment.toString(),
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      pathElements,
      pathIndices,
    },
    WASM,
    ZKEY
  );
  const ok = await snarkjs.groth16.verify(JSON.parse(readFileSync(VK_PATH, "utf8")), publicSignals, proof);
  if (!ok) throw new Error("generated proof does not verify against its own VK");

  writeFileSync(
    path.join(FIXTURES, "zk-shieldnote.json"),
    JSON.stringify({
      note: { nullifier: nullifier.toString(), secret: secret.toString(), bucket: bucket.toString() },
      leaf: leaf.toString(),
      root: node.toString(),
      publicSignals,
      proof: {
        pi_a: [proof.pi_a[0], proof.pi_a[1]],
        // EIP-197 order, matching FareShieldVerifier's expectation.
        pi_b: [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
        pi_c: [proof.pi_c[0], proof.pi_c[1]],
      },
    }, null, 2)
  );
  console.log("✓ test/fixtures/zk-shieldnote.json written");
  console.log("\nNext: FareShieldVerifier.setVerifyingKey(...) with setShieldVK-calldata.json");
  process.exit(0);
}
