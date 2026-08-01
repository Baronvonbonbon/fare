#!/usr/bin/env node
// Compile the contracts to native PolkaVM bytecode with `resolc`.
//
// Today `npm run build` emits EVM bytecode and Paseo runs it under
// pallet-revive's *compatibility mode* (an EVM interpreter). Native mode wants
// PVM bytecode instead, which means a different compiler: resolc drives the
// stock solc frontend and then lowers Yul → LLVM → RISC-V.
//
// This is a SECOND target, not a replacement. The EVM build still backs the
// test suite and every existing deploy path; this exists so the native path is
// measured and kept honest rather than assumed.
//
//   node scripts/build-pvm.mjs [--snapshot]
//
// `--snapshot` rewrites pvm-size-snapshot.json. Without it the script only
// builds and reports, so CI can diff against the committed sizes.
//
// Needs `resolc` (RESOLC=/path/to/resolc, or on PATH):
//   https://github.com/paritytech/revive/releases
// solc is taken from hardhat's own compiler cache, so the two builds cannot
// drift onto different frontend versions.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts-pvm");
const SNAPSHOT = path.join(ROOT, "pvm-size-snapshot.json");

// pallet-revive rejects a blob over this ("BlobTooLarge"). Contracts also get
// 1 MB of memory for code+data; the blob ceiling is the one that binds here.
export const BLOB_LIMIT = 256 * 1024;

// Every contract we actually deploy. Mocks and interfaces are excluded — they
// are test scaffolding and would only add noise to the size gate.
const CONTRACTS = [
  "FareOrders",
  "FareVault",
  "FareSettlement",
  "FareVenues",
  "FareDrivers",
  "FareForwarder",
  "FareDisputes",
  "FareLocationVerifier",
  "FareShieldVerifier",
  "FareRatings",
  "FareGovernanceRouter",
  "FarePauseRegistry",
];

function findResolc() {
  if (process.env.RESOLC) {
    if (!fs.existsSync(process.env.RESOLC)) {
      fail(`RESOLC is set to ${process.env.RESOLC} but nothing is there.`);
    }
    return process.env.RESOLC;
  }
  try {
    return execFileSync("which", ["resolc"], { encoding: "utf8" }).trim();
  } catch {
    fail(
      "resolc not found.\n" +
        "  Download a release binary and either put it on PATH or set RESOLC:\n" +
        "    https://github.com/paritytech/revive/releases\n" +
        "    export RESOLC=/path/to/resolc-x86_64-unknown-linux-musl",
    );
  }
}

/** Reuse hardhat's cached solc so both build targets share one frontend. */
function findSolcDir() {
  const version = readSolcVersion();
  const base = path.join(os.homedir(), ".cache", "hardhat-nodejs");
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith("solc-") && e.name.includes(version)) hits.push(p);
    }
  };
  walk(base);
  if (!hits.length) {
    fail(
      `No cached solc ${version} under ${base}.\n` +
        "  Run `npx hardhat compile` once to populate hardhat's compiler cache.",
    );
  }
  // resolc invokes `solc` by name, so hand it a directory with that exact name.
  const shim = path.join(OUT_DIR, ".solc-bin");
  fs.mkdirSync(shim, { recursive: true });
  const dest = path.join(shim, "solc");
  fs.copyFileSync(hits[0], dest);
  fs.chmodSync(dest, 0o755);
  return shim;
}

function readSolcVersion() {
  const cfg = fs.readFileSync(path.join(ROOT, "hardhat.config.ts"), "utf8");
  const m = cfg.match(/version:\s*"([\d.]+)"/);
  if (!m) fail("Could not read the solc version out of hardhat.config.ts.");
  return m[1];
}

/** The evmVersion hardhat compiles with. resolc does NOT default to it. */
function readEvmVersion() {
  const cfg = fs.readFileSync(path.join(ROOT, "hardhat.config.ts"), "utf8");
  const m = cfg.match(/evmVersion:\s*"([a-z]+)"/);
  return m ? m[1] : "cancun";
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function compile(resolc, solcDir, evmVersion, name) {
  const out = execFileSync(
    resolc,
    [
      "--bin",
      "-O",
      "z", // resolc's own default; stated so a change is visible in the diff
      "--evm-version",
      evmVersion,
      "--base-path",
      ".",
      "--include-path",
      "node_modules",
      `contracts/${name}.sol`,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PATH: `${solcDir}:${process.env.PATH}` },
    },
  );

  // Output is a series of "======= file:Contract =======\nBinary:\n<hex>"
  // blocks, one per compiled unit including dependencies. Take ours.
  const marker = `contracts/${name}.sol:${name} =======`;
  const at = out.indexOf(marker);
  if (at === -1) return null;
  const after = out.slice(at);
  const bin = after.match(/Binary:\s*\n([0-9a-fA-F]+)/);
  return bin ? bin[1] : null;
}

function main() {
  const writeSnapshot = process.argv.includes("--snapshot");
  const resolc = findResolc();
  const evmVersion = readEvmVersion();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const solcDir = findSolcDir();

  const version = execFileSync(resolc, ["--version"], { encoding: "utf8" }).trim();
  console.log(`${version}`);
  console.log(`solc: ${readSolcVersion()}   evm-version: ${evmVersion}   opt: -Oz\n`);

  // cancun is not optional: OpenZeppelin 5.x's utils/Bytes.sol uses the mcopy
  // opcode, and without this flag FareVault, FareSettlement and FareForwarder
  // all fail with `DeclarationError: Function "mcopy" not found`.
  if (evmVersion !== "cancun") {
    console.warn(`! evmVersion is "${evmVersion}"; OpenZeppelin needs cancun for mcopy\n`);
  }

  const sizes = {};
  let failed = 0;

  for (const name of CONTRACTS) {
    process.stdout.write(`  ${name.padEnd(24)}`);
    let hex;
    try {
      hex = compile(resolc, solcDir, evmVersion, name);
    } catch (e) {
      const msg = String(e.stderr ?? e.message).split("\n").find((l) => l.trim()) ?? "compile failed";
      console.log(`FAILED — ${msg.slice(0, 90)}`);
      failed++;
      continue;
    }
    if (!hex) {
      console.log("FAILED — no binary in resolc output");
      failed++;
      continue;
    }
    const bytes = hex.length / 2;
    sizes[name] = bytes;
    fs.writeFileSync(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify({ contract: name, resolc: version, evmVersion, bytes, bytecode: `0x${hex}` }, null, 2),
    );
    const pct = ((100 * bytes) / BLOB_LIMIT).toFixed(1);
    console.log(`${String(bytes).padStart(7)} bytes  ${pct.padStart(5)}% of 256 KiB`);
  }

  console.log();
  if (failed) {
    console.error(`✗ ${failed} contract(s) failed to compile`);
    process.exit(1);
  }

  if (writeSnapshot) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(sizes, null, 2) + "\n");
    console.log(`✓ wrote ${path.relative(ROOT, SNAPSHOT)}`);
  }
  console.log(`✓ ${CONTRACTS.length} contracts → ${path.relative(ROOT, OUT_DIR)}/`);
}

main();
