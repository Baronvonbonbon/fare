#!/usr/bin/env node
// Validate the two runtime assumptions the whole design rests on, under NATIVE
// PolkaVM rather than pallet-revive's EVM interpreter.
//
// scripts/deploy-pvm-probe.mjs got as far as "a PVM blob deploys and dispatches".
// That left the two things that actually matter untested:
//
//   1. BN254 precompiles (0x06 add / 0x07 mul / 0x08 pairing) — the drop-proximity
//      proof is worthless if Groth16 verification behaves differently here.
//   2. ecrecover — every GPS attestation is an EIP-712 signature recovered
//      on-chain. It is also the reason the host signer cannot sign attestations
//      (docs/POLKADOT-PLATFORM-PLAN.md §4.1), so it had better work natively.
//
// Both are checked against the SAME fixtures the hardhat suite uses, so a
// divergence between interpreter and native execution shows up as a
// disagreement rather than a fresh unexplained failure.
//
//   node scripts/pvm-runtime-check.mjs [--dry-run]
//
// Spends PAS. Needs DEPLOYER_PRIVATE_KEY in .env.

import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const DRY = process.argv.includes("--dry-run");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const pvmArtifact = (n) => readJson(path.join(ROOT, "artifacts-pvm", `${n}.json`));
const evmArtifact = (n) => readJson(path.join(ROOT, "artifacts", "contracts", `${n}.sol`, `${n}.json`));

const fixture = readJson(path.join(ROOT, "test", "fixtures", "zk-proximity.json"));
const abi = ethers.AbiCoder.defaultAbiCoder();

/** Same encoding the hardhat suite uses — see test/zk.test.ts. */
const encodeProof = (p) =>
  abi.encode(["uint256[2]", "uint256[4]", "uint256[2]"], [p.pi_a, p.pi_b, p.pi_c]);

console.log("\nPolkaVM runtime check — BN254 precompiles + ecrecover\n");
console.log(`  rpc  ${RPC}`);
for (const n of ["FareLocationVerifier", "FareVault"]) {
  console.log(`  ${n.padEnd(22)} PVM ${String(pvmArtifact(n).bytes).padStart(6)} bytes`);
}

if (DRY) {
  console.log("\n--dry-run: nothing submitted.\n");
  process.exit(0);
}
if (!process.env.DEPLOYER_PRIVATE_KEY) {
  console.error("\n✗ DEPLOYER_PRIVATE_KEY is not set (see .env.example)");
  process.exit(2);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

/** Deploy a PVM blob raw; eth-rpc receipts can be null on Paseo, so derive. */
async function deployPvm(name) {
  const { bytecode } = pvmArtifact(name);
  const nonce = await provider.getTransactionCount(wallet.address);
  const tx = await wallet.sendTransaction({ data: bytecode, nonce });
  await tx.wait(1).catch(() => null);
  const address = ethers.getCreateAddress({ from: wallet.address, nonce });
  const code = await provider.getCode(address).catch(() => "0x");
  if (code === "0x") throw new Error(`${name}: nothing deployed at ${address}`);
  return new ethers.Contract(address, evmArtifact(name).abi, wallet);
}

const results = [];
const record = (what, ok, detail) => {
  results.push({ what, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(46)} ${detail ?? ""}`);
};

async function checkBn254() {
  console.log("\nBN254 / Groth16 — the drop-proximity proof");
  const verifier = await deployPvm("FareLocationVerifier");
  console.log(`  deployed at ${await verifier.getAddress()}`);

  const proof = encodeProof(fixture.proof);
  const pubSignals = fixture.publicSignals.map((s) => BigInt(s));

  // Before the VK is set the verifier must refuse, not accept-by-default.
  // Getting this wrong in the other direction would be a silent catastrophe.
  record("fails safe before the VK is set", (await verifier.verifyProximity(proof, pubSignals)) === false);

  const vk = fixture.vkCalldata;
  const tx = await verifier.setVerifyingKey(
    vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
    vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5,
  );
  await tx.wait(1).catch(() => null);

  // The real question: does the pairing check agree with the interpreter?
  record(
    "accepts the real proof (pairing over 0x06/0x07/0x08)",
    (await verifier.verifyProximity(proof, pubSignals)) === true,
  );

  // Soundness, not just liveness — a verifier that accepts everything passes
  // the test above and is worthless.
  const tampered = [...pubSignals];
  tampered[1] = tampered[1] + 1n; // dropCommit
  record("rejects a tampered public signal", (await verifier.verifyProximity(proof, tampered)) === false);
}

async function checkEcrecover() {
  console.log("\necrecover — EIP-712 signature recovery");
  // FareVault.withdrawFor, not the forwarder: OpenZeppelin's ERC2771Forwarder
  // checks target-trust BEFORE the signer, so its verify()/execute() can never
  // isolate recovery. withdrawFor recovers first and then reverts on the
  // balance, which gives two distinguishable outcomes:
  //
  //   revert "bad-sig"       → recovery FAILED
  //   revert "zero-balance"  → recovery SUCCEEDED (it got past the check)
  //
  // A fresh vault has no balances, so "zero-balance" is the pass condition.
  const vault = await deployPvm("FareVault");
  const address = await vault.getAddress();
  console.log(`  deployed at ${address}`);

  const net = await provider.getNetwork();
  const domain = { name: "FareVault", version: "1", chainId: Number(net.chainId), verifyingContract: address };
  const types = {
    Withdraw: [
      { name: "account", type: "address" },
      { name: "recipient", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const account = ethers.Wallet.createRandom();
  const msg = {
    account: account.address,
    recipient: wallet.address,
    nonce: await vault.withdrawNonce(account.address),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const signature = await account.signTypedData(domain, types, msg);

  const reasonOf = async (sig) => {
    try {
      await vault.withdrawFor.staticCall(msg.account, msg.recipient, msg.deadline, sig);
      return "no-revert";
    } catch (e) {
      return (e.reason ?? e.shortMessage ?? e.message ?? "").toString();
    }
  };

  const good = await reasonOf(signature);
  record(
    "recovers a valid EIP-712 signature",
    good.includes("zero-balance"),
    good.includes("zero-balance") ? "reached the balance check" : `got: ${good.slice(0, 60)}`,
  );

  // Soundness: a mangled signature must not recover to the same account.
  const bad = signature.slice(0, -2) + (signature.slice(-2) === "ff" ? "ee" : "ff");
  const badReason = await reasonOf(bad);
  record(
    "rejects a mangled signature",
    !badReason.includes("zero-balance") && badReason !== "no-revert",
    `got: ${badReason.slice(0, 40)}`,
  );
}

const main = async () => {
  const bal = await provider.getBalance(wallet.address);
  console.log(`  deployer ${wallet.address} (${ethers.formatEther(bal)} PAS)`);
  if (bal === 0n) {
    console.error("✗ deployer has no PAS — https://faucet.polkadot.io");
    process.exit(1);
  }

  await checkBn254();
  await checkEcrecover();

  const failed = results.filter((r) => !r.ok);
  console.log();
  if (failed.length) {
    console.error(`✗ ${failed.length}/${results.length} checks failed under native PolkaVM`);
    console.error("  A disagreement with the hardhat suite means native and interpreted");
    console.error("  execution diverge — that blocks the resolc target, not the contracts.");
    process.exit(1);
  }
  console.log(`✓ ${results.length}/${results.length} — BN254 and ecrecover behave natively as they do under the interpreter\n`);
};

main().catch((e) => {
  console.error("\nruntime check failed:", e.shortMessage ?? e.message);
  process.exit(1);
});
