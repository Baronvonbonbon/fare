#!/usr/bin/env node
// Deploy ONE resolc-built contract to Paseo and exercise it.
//
// scripts/build-pvm.mjs proves the contracts compile to PolkaVM and fit. That
// is a compile-time result and says nothing about whether the native path
// actually runs: whether eth-rpc accepts a PVM blob as init code at all, and
// whether the precompiles the contracts lean on behave the same under native
// execution as under the EVM interpreter.
//
// FareLocationVerifier is the contract worth testing: no constructor
// arguments, and it is the contract whose real work (Groth16/BN254 through the
// precompiles at 0x06/0x07/0x08) is most likely to differ between the two
// execution modes. This probe gets as far as deploy + constructor + dispatch;
// exercising the precompiles themselves needs setVerifyingKey and a real proof,
// which is the obvious next step rather than something this covers.
//
//   node scripts/deploy-pvm-probe.mjs            # deploy + call
//   node scripts/deploy-pvm-probe.mjs --dry-run  # report, spend nothing
//
// Spends PAS. Needs DEPLOYER_PRIVATE_KEY in .env.

import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const ROOT = path.resolve(import.meta.dirname, "..");
const NAME = "FareLocationVerifier";
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const DRY = process.argv.includes("--dry-run");

const artifactPath = path.join(ROOT, "artifacts-pvm", `${NAME}.json`);
if (!fs.existsSync(artifactPath)) {
  console.error(`✗ no PVM artifact for ${NAME}. Run: npm run build:pvm`);
  process.exit(2);
}
const pvm = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const evmPath = path.join(ROOT, "artifacts", "contracts", `${NAME}.sol`, `${NAME}.json`);
const evm = JSON.parse(fs.readFileSync(evmPath, "utf8"));

console.log(`\nPolkaVM runtime probe — ${NAME}\n`);
console.log(`  resolc      ${pvm.resolc}`);
console.log(`  evm-version ${pvm.evmVersion}`);
console.log(`  PVM blob    ${pvm.bytes} bytes`);
console.log(`  EVM code    ${evm.deployedBytecode.length / 2 - 1} bytes  (what we ship today)`);
console.log(`  rpc         ${RPC}`);

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

const main = async () => {
  const bal = await provider.getBalance(wallet.address);
  console.log(`  deployer    ${wallet.address}  (${ethers.formatEther(bal)} PAS)\n`);
  if (bal === 0n) {
    console.error("✗ deployer has no PAS — fund it at https://faucet.polkadot.io");
    process.exit(1);
  }

  console.log("DEPLOY (PVM blob as init code)");
  let address;
  try {
    // Deliberately raw rather than ContractFactory: the question is whether
    // eth-rpc will take a PolkaVM blob where it normally sees EVM init code.
    const nonce = await provider.getTransactionCount(wallet.address);
    const tx = await wallet.sendTransaction({ data: pvm.bytecode, nonce });
    console.log(`  tx          ${tx.hash}`);

    // Receipts can come back null for confirmed txs on Paseo (the same
    // eth-rpc quirk scripts/deploy.ts works around), so fall back to deriving
    // the address from the nonce and confirming code landed there.
    const receipt = await tx.wait(1).catch(() => null);
    address = receipt?.contractAddress ?? ethers.getCreateAddress({ from: wallet.address, nonce });
    console.log(`  address     ${address}`);
  } catch (e) {
    console.error(`\n✗ deploy rejected: ${(e.shortMessage ?? e.message).slice(0, 300)}`);
    console.error(
      "\n  If eth-rpc will not accept a PVM blob as init code, native deploys need\n" +
        "  the revive-specific path (pallet_revive.instantiate_with_code) rather than\n" +
        "  eth_sendTransaction. That is a toolchain finding, not a contract problem.\n",
    );
    process.exit(1);
  }

  const code = await provider.getCode(address).catch(() => "0x");
  console.log(`  code at addr ${code === "0x" ? "NONE — nothing deployed" : `${code.length / 2 - 1} bytes`}`);
  if (code === "0x") process.exit(1);

  // NOTE: getVK/owner are storage reads. They prove the constructor ran and
  // that calls dispatch under native PVM — they do NOT touch the BN254
  // precompiles. Validating those needs setVerifyingKey plus a real Groth16
  // proof through verifyProximity, which is a separate exercise.
  console.log("\nCALL (constructor + dispatch under native PVM)");
  const c = new ethers.Contract(address, evm.abi, wallet);
  try {
    const vk = await c.getVK();
    console.log(`  getVK()     returned ${Array.isArray(vk) ? `${vk.length} fields` : typeof vk}`);
    const owner = await c.owner();
    console.log(`  owner()     ${owner}`);
    console.log(
      `  ${owner.toLowerCase() === wallet.address.toLowerCase() ? "✓" : "✗"} constructor ran under native PVM (Ownable set msg.sender)`,
    );
  } catch (e) {
    console.error(`  ✗ call failed: ${(e.shortMessage ?? e.message).slice(0, 200)}`);
    process.exit(1);
  }

  console.log(`\n✓ ${NAME} deployed and callable as native PolkaVM at ${address}\n`);
};

main().catch((e) => {
  console.error("\nprobe failed:", e.shortMessage ?? e.message);
  process.exit(1);
});
