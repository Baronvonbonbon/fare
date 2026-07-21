#!/usr/bin/env node
/**
 * setup-zk.mjs — FARE drop-proximity ZK trusted setup + fixture generator.
 *
 * Produces everything the on-chain verifier and the browser prover need:
 *   1. Compile circuits/proximity.circom            (requires circom ≥ 2.1)
 *   2. Groth16 setup over Hermez powers-of-tau lvl 12 (4096 constraints;
 *      the circuit uses ~1,240 — comfortable headroom)
 *   3. circuits/build/proximity.zkey                — proving key
 *   4. circuits/build/proximity_js/proximity.wasm   — witness calculator
 *   5. circuits/build/vk.json                       — verification key
 *   6. circuits/build/setVK-calldata.json           — FareLocationVerifier.setVerifyingKey() args
 *   7. web/public/zk/proximity.wasm + proximity.zkey — served to the PWA prover
 *   8. test/fixtures/zk-proximity.json              — a real proof for the Solidity verifier test
 *
 * Prerequisites (in the repo root):
 *   npm install --save-dev snarkjs circomlib circomlibjs
 *   circom on PATH (or place the binary at ./circom)
 *
 * Usage:
 *   node scripts/setup-zk.mjs
 *
 * NOTE: this single-party contribution is NOT a production ceremony. It is fine
 * for testnet/demo. A mainnet deploy must run a real multi-party ceremony and
 * publish the transcript before calling setVerifyingKey (which is lock-once).
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CIRCUITS = path.join(ROOT, "circuits");
const BUILD = path.join(CIRCUITS, "build");
const WEB_ZK = path.join(ROOT, "web", "public", "zk");
const FIXTURES = path.join(ROOT, "test", "fixtures");

// Circuit uses ~1,240 constraints → ptau12 (4,096) is plenty.
const PTAU_URL = "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau";
const PTAU_PATH = path.join(CIRCUITS, "ptau12.ptau");
const CIRCOM_SRC = path.join(CIRCUITS, "proximity.circom");
const R1CS = path.join(BUILD, "proximity.r1cs");
const WASM = path.join(BUILD, "proximity_js", "proximity.wasm");
const ZKEY0 = path.join(BUILD, "proximity_0000.zkey");
const ZKEY = path.join(BUILD, "proximity.zkey");
const VK_PATH = path.join(BUILD, "vk.json");

const OFF_LAT = 90_000_000n; // lat  + 90e6
const OFF_LON = 180_000_000n; // lon + 180e6

for (const d of [BUILD, WEB_ZK, FIXTURES]) mkdirSync(d, { recursive: true });

// ── Step 1: compile ────────────────────────────────────────────────────
const CIRCOM_BIN = (() => {
  try {
    execSync("circom --version", { stdio: "pipe" });
    return "circom";
  } catch {}
  const local = path.join(ROOT, "circom");
  if (existsSync(local)) return local;
  throw new Error("circom not found — install it (https://docs.circom.io) or place the binary at ./circom");
})();

// circomlib includes: resolve from node_modules via the -l include path.
const LIB = path.join(ROOT, "node_modules");
if (!existsSync(path.join(LIB, "circomlib"))) {
  throw new Error("circomlib not installed — run: npm install --save-dev circomlib circomlibjs snarkjs");
}
console.log("→ Compiling proximity.circom ...");
execSync(`${CIRCOM_BIN} ${CIRCOM_SRC} --r1cs --wasm --sym -o ${BUILD} -l ${LIB}`, { stdio: "inherit" });

// ── Step 2: ptau ────────────────────────────────────────────────────────
if (!existsSync(PTAU_PATH)) {
  console.log("→ Downloading powers-of-tau level 12 (~4.8 MB) ...");
  execSync(`curl -L "${PTAU_URL}" -o "${PTAU_PATH}"`, { stdio: "inherit" });
} else {
  console.log("✓ ptau12 present");
}

// ── Step 3: groth16 setup ───────────────────────────────────────────────
const snarkjs = await import("snarkjs");
console.log("→ groth16 setup ...");
await snarkjs.zKey.newZKey(R1CS, PTAU_PATH, ZKEY0);
const entropy = createHash("sha256").update(Date.now().toString()).digest("hex");
await snarkjs.zKey.contribute(ZKEY0, ZKEY, "fare-proximity-testnet", entropy);
console.log("✓ proximity.zkey written");

// ── Step 4: export VK + setVerifyingKey calldata ────────────────────────
const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
writeFileSync(VK_PATH, JSON.stringify(vk, null, 2));

const g1 = (p) => [p[0], p[1]];
// snarkjs G2: [[x_real, x_imag], [y_real, y_imag]]; EIP-197 wants [x_imag, x_real, y_imag, y_real].
const g2 = (p) => [p[0][1], p[0][0], p[1][1], p[1][0]];
const vkCalldata = {
  alpha1: g1(vk.vk_alpha_1),
  beta2: g2(vk.vk_beta_2),
  gamma2: g2(vk.vk_gamma_2),
  delta2: g2(vk.vk_delta_2),
  IC0: g1(vk.IC[0]), // constant
  IC1: g1(vk.IC[1]), // orderId
  IC2: g1(vk.IC[2]), // dropCommit
  IC3: g1(vk.IC[3]), // driverCommit
  IC4: g1(vk.IC[4]), // radiusMeters
  IC5: g1(vk.IC[5]), // nullifier
};
writeFileSync(path.join(BUILD, "setVK-calldata.json"), JSON.stringify(vkCalldata, null, 2));
console.log("✓ vk.json + setVK-calldata.json written");

// ── Step 5: publish prover artifacts to the PWA ─────────────────────────
copyFileSync(WASM, path.join(WEB_ZK, "proximity.wasm"));
copyFileSync(ZKEY, path.join(WEB_ZK, "proximity.zkey"));
console.log("✓ web/public/zk/{proximity.wasm,proximity.zkey} updated");

// ── Step 6: sample proof fixture for the Solidity verifier test ─────────
const { buildPoseidon } = await import("circomlibjs");
const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (arr) => F.toObject(poseidon(arr)).toString();

// Customer 40.700000,-74.000000 ; driver ~33 m north — inside the 100 m fence.
const custLatEnc = 40_700_000n + OFF_LAT;
const custLonEnc = -74_000_000n + OFF_LON;
const drvLatEnc = 40_700_300n + OFF_LAT;
const drvLonEnc = -74_000_000n + OFF_LON;
const salt = 111_111_111_111n;
const drvSalt = 222_222_222_222n;
const orderId = 1n;
const radiusMeters = 100n;

const input = {
  orderId: orderId.toString(),
  dropCommit: H([custLatEnc, custLonEnc, salt]),
  driverCommit: H([drvLatEnc, drvLonEnc, drvSalt]),
  radiusMeters: radiusMeters.toString(),
  nullifier: H([salt, orderId]),
  custLatEnc: custLatEnc.toString(),
  custLonEnc: custLonEnc.toString(),
  salt: salt.toString(),
  drvLatEnc: drvLatEnc.toString(),
  drvLonEnc: drvLonEnc.toString(),
  drvSalt: drvSalt.toString(),
};

const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) {
  throw new Error("sample proof failed to verify — setup is broken");
}

// Encode the proof exactly as FareLocationVerifier expects (EIP-197 G2 order).
const encodedProof = {
  pi_a: [proof.pi_a[0], proof.pi_a[1]],
  pi_b: [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
  pi_c: [proof.pi_c[0], proof.pi_c[1]],
};
writeFileSync(
  path.join(FIXTURES, "zk-proximity.json"),
  JSON.stringify({ vkCalldata, proof: encodedProof, publicSignals, input }, null, 2)
);
console.log("✓ test/fixtures/zk-proximity.json written");

console.log(`
=============================================================
 ZK setup complete.  Public-signal order (fixed):
   [orderId, dropCommit, driverCommit, radiusMeters, nullifier]

 Deploy: after deploying FareLocationVerifier, call setVerifyingKey(...)
 with the values in circuits/build/setVK-calldata.json, then wire it via
 FareSettlement.setLocationVerifier(verifier). scripts/deploy.ts does this.
=============================================================`);
process.exit(0);
