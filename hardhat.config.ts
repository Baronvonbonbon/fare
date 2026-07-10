// hardhat.config.ts — FARE protocol build config.
// Mirrors the DATUM alpha-core EVM-only toolchain: solc 0.8.24, cancun,
// viaIR. Pallet-revive on Polkadot Hub runs EVM bytecode directly, so a
// single build target covers local hardhat, a local revive dev node, and
// Paseo.
// Usage: npx hardhat compile / npx hardhat test /
//        npx hardhat run scripts/deploy.ts --network polkadotTestnet
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      blockGasLimit: 1_000_000_000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    polkadotTestnet: {
      // Paseo testnet — EVM bytecode on pallet-revive.
      // Quirks inherited from the DATUM deploy experience:
      //  - eth-rpc rejects payable values where value % 10^6 >= 500_000
      //    (contracts inherit PaseoSafeSender to defeat this on sends)
      //  - getTransactionReceipt can return null for confirmed txs
      //    (deploy script uses nonce polling + getCreateAddress)
      url: process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [
            process.env.DEPLOYER_PRIVATE_KEY,
            ...(process.env.TESTNET_ACCOUNTS ?? "").split(",").filter(Boolean),
          ]
        : [],
    },
  },
  mocha: {
    timeout: 300000,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
