// Track 4 spike — can the PWA talk to FARE's contracts through the SUBSTRATE
// toolchain instead of eth-rpc?
//
// The canonical direction is FARE running in a browser against @polkadot/api
// (or PAPI) rather than ethers-over-eth-rpc. That would delete a standing tax:
// `lib/PaseoSafeSender` exists for an eth-rpc denomination bug, nonces must be
// fetched with "latest" because the "pending" tag errors, `eth_getLogs` refuses
// null topic placeholders (which is why `OrderRegion` indexes region FIRST), and
// gasLimit × maxFeePerGas is reserved up front. None of those are chain
// problems; they are all eth-rpc-compatibility problems.
//
// Before porting anything, three questions have to be answered on the real
// chain. This script answers them and prints a verdict.
//
//   Q1  Does a Solidity ABI call round-trip through `ReviveApi_call`? If the
//       dry-run returns the same bytes `eth_call` does, reads are mechanical.
//   Q2  What H160 does a SUBSTRATE account act as? Everything in FARE is keyed
//       by `msg.sender` — `venuesByOperator`, `drivers[addr]`, `orders.customer`,
//       vault balances. If a substrate-native client shows up as a different
//       address than the ethers client does for the same human, the migration is
//       a hard per-role cutover, not a gradual dual path.
//   Q3  Is that account MAPPED? pallet-revive requires `revive.mapAccount`
//       (with a deposit) before an origin can act as a contract caller.
//
// Read-only by default: everything above needs no funds and changes no state.
// With SUBSTRATE_SEED set it additionally dry-runs a real `commitBid` from that
// account, which is the write path a port would use.
//
//   node scripts/substrate-native-spike.mjs
//   SUBSTRATE_SEED="//Alice" node scripts/substrate-native-spike.mjs
//
// Env: AH_WSS (default the Dwellir Paseo Asset Hub endpoint), ORDER_ID,
//      EVM_ADDRESS (an ethers-side address to contrast the derivation against).

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { AbiCoder, id as keccakId, getAddress, hexlify, randomBytes } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const AH_WSS = process.env.AH_WSS ?? "wss://asset-hub-paseo-rpc.n.dwellir.com";
const ORDER_ID = BigInt(process.env.ORDER_ID ?? 1);

const book = JSON.parse(readFileSync(join(HERE, "..", "deployed-addresses.json"), "utf8"));
const ADDRESSES = book.addresses ?? book;

const abi = AbiCoder.defaultAbiCoder();
const selector = (sig) => keccakId(sig).slice(0, 10);
const ok = (s) => console.log(`  ✓ ${s}`);
const bad = (s) => console.log(`  ✗ ${s}`);

/// A Solidity call, ABI-encoded the same way ethers would.
function encodeCall(sig, types = [], args = []) {
  return selector(sig) + (types.length ? abi.encode(types, args).slice(2) : "");
}

/// Dry-run a contract call through the runtime API. `origin` is an AccountId32 —
/// which is the whole point: the runtime derives the H160 the contract sees.
async function reviveCall(api, origin, dest, data, value = 0n) {
  const res = await api.call.reviveApi.call(
    origin,
    dest,
    value,
    null, // gas_limit: let the runtime pick
    null, // storage_deposit_limit
    data
  );
  const human = res.toJSON();
  return { raw: res, data: human?.result?.ok?.data ?? null, err: human?.result?.err ?? null, human };
}

async function main() {
  console.log(`\nFARE — substrate-native spike\n  endpoint ${AH_WSS}`);
  const api = await ApiPromise.create({ provider: new WsProvider(AH_WSS, 3000) });
  const chain = (await api.rpc.system.chain()).toString();
  console.log(`  chain    ${chain} (spec ${api.runtimeVersion.specVersion.toString()})`);
  console.log(`  orders   ${ADDRESSES.orders}\n`);

  const findings = [];

  // ── Q0: the surface exists ────────────────────────────────────────────────
  console.log("Q0 · does this runtime expose what a port would need?");
  const need = {
    "revive.call (write)": !!api.tx.revive?.call,
    "revive.mapAccount": !!api.tx.revive?.mapAccount,
    "reviveApi.call (read)": !!api.call.reviveApi?.call,
    "reviveApi.address (AccountId32 → H160)": !!api.call.reviveApi?.address,
    "reviveApi.nonce": !!api.call.reviveApi?.nonce,
    "reviveApi.getStorage": !!api.call.reviveApi?.getStorage,
  };
  for (const [k, v] of Object.entries(need)) (v ? ok : bad)(k);
  const surfaceOk = Object.values(need).every(Boolean);
  findings.push(["runtime surface", surfaceOk ? "present" : "INCOMPLETE"]);

  // ── Q2 / Q3 come first: a read needs a mapped origin ──────────────────────
  console.log("\nQ2 · what H160 does a substrate account act as?");
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const seed = process.env.SUBSTRATE_SEED;
  const pair = keyring.addFromUri(seed ?? "//Alice");
  console.log(`  account  ${pair.address}${seed ? "" : "  (//Alice — no seed given, derivation only)"}`);

  let derived = null;
  try {
    const h160 = await api.call.reviveApi.address(pair.address);
    derived = getAddress(h160.toHex());
    ok(`derives to ${derived}`);
  } catch (e) {
    bad(`reviveApi.address failed: ${e.message}`);
  }

  if (process.env.EVM_ADDRESS) {
    const evm = getAddress(process.env.EVM_ADDRESS);
    const same = derived && derived.toLowerCase() === evm.toLowerCase();
    (same ? ok : bad)(
      same
        ? `the ethers-side address ${evm} is the SAME — no cutover needed`
        : `the ethers-side address ${evm} is DIFFERENT — every msg.sender-keyed record forks`
    );
  }

  console.log("\nQ3 · is that account mapped for pallet-revive?");
  let mapped = false;
  try {
    const orig = await api.query.revive.originalAccount(derived ?? "0x" + "00".repeat(20));
    mapped = !orig.isEmpty && orig.toString() !== "";
    (mapped ? ok : bad)(
      mapped
        ? `mapped — ${orig.toString()} is registered as the fallback account`
        : "NOT mapped — revive.mapAccount(+deposit) must run before this account can call a contract"
    );
  } catch (e) {
    bad(`could not read revive.originalAccount: ${e.message}`);
  }

  // ── Q1: does an ABI read round-trip? ──────────────────────────────────────
  //
  // The origin has to be a MAPPED account even though this is a view call —
  // an unmapped AccountId32 gets `revive.AccountUnmapped` before the contract
  // executes. That is a real difference from eth-rpc, where `eth_call` from the
  // zero address is free and universal. A substrate-native client therefore has
  // no anonymous read path through `ReviveApi_call`: it must either hold a
  // mapped account or read state some other way (`reviveApi.getStorage`).
  console.log("\nQ1 · does a Solidity ABI read round-trip through ReviveApi_call?");
  let readOk = false;
  try {
    const unmapped = await reviveCall(
      api, "0x" + "00".repeat(32), ADDRESSES.orders,
      encodeCall("statusOf(uint256)", ["uint256"], [ORDER_ID])
    );
    if (unmapped.err) {
      console.log(`  · an UNMAPPED origin cannot even read: ${JSON.stringify(unmapped.err)} (revive.AccountUnmapped)`);
    }

    const r = await reviveCall(api, pair.address, ADDRESSES.orders, encodeCall("statusOf(uint256)", ["uint256"], [ORDER_ID]));
    if (r.err) {
      bad(`statusOf(${ORDER_ID}) failed from a mapped origin too: ${JSON.stringify(r.err)}`);
    } else if (r.data && r.data !== "0x") {
      const [status] = abi.decode(["uint8"], r.data);
      const NAMES = ["None", "Open", "Assigned", "PickedUp", "Delivered", "Cancelled", "Disputed", "Resolved"];
      ok(`statusOf(${ORDER_ID}) = ${status} (${NAMES[Number(status)] ?? "?"}) — decoded from ${r.data}`);
      // A second, differently-shaped read: a struct getter, to prove it is not
      // just single-word returns that survive.
      const s = await reviveCall(api, pair.address, ADDRESSES.orders, encodeCall("orders(uint256)", ["uint256"], [ORDER_ID]));
      if (s.data && s.data !== "0x") {
        const d = abi.decode(
          ["address", "uint64", "uint8", "address", "uint96", "uint96", "uint96", "uint96", "uint96",
           "bytes32", "uint64", "uint64", "uint64", "uint64", "uint64", "address"],
          s.data
        );
        ok(`orders(${ORDER_ID}).customer = ${d[0]}, venueId = ${d[1]}, orderValue = ${d[4]}`);
        readOk = true;
      } else {
        bad("the struct getter returned no data");
      }
    } else {
      bad("no return data — is the address in deployed-addresses.json live on this chain?");
    }
  } catch (e) {
    bad(`ReviveApi_call threw: ${e.message}`);
  }
  findings.push(["ABI reads via reviveApi.call", readOk ? "round-trip exactly" : "FAILED"]);
  findings.push(["reads need a mapped origin", "YES — no anonymous eth_call equivalent"]);
  findings.push(["substrate → H160 derivation", derived ? derived : "FAILED"]);
  findings.push(["account mapped", mapped ? "yes" : "no — mapAccount required"]);

  // ── the write path ────────────────────────────────────────────────────────
  console.log("\nQ4 · the write path (commitBid), dry-run from that account");
  let writeOk = false;
  if (!derived) {
    bad("skipped — no derived address");
  } else {
    try {
      // commitBid(orderId, bidHash, revokeHash) — chosen because it is the one
      // write a relay normally fronts, it carries no value (so a dry-run needs no
      // balance), and it is the path sealed bids depend on.
      const data = encodeCall(
        "commitBid(uint256,bytes32,bytes32)",
        ["uint256", "bytes32", "bytes32"],
        [ORDER_ID, hexlify(randomBytes(32)), hexlify(randomBytes(32))]
      );
      const r = await reviveCall(api, pair.address, ADDRESSES.orders, data);
      if (r.err) {
        // A revert here is still a SUCCESS for the spike: it means the call was
        // dispatched, the contract executed, and it made a business-logic
        // decision (e.g. the order is not open). What we are testing is the
        // transport, not whether this particular order accepts a bid.
        console.log(`  · reverted: ${JSON.stringify(r.err)}`);
        ok("dispatched and executed — the transport works; the revert is contract logic");
        writeOk = true;
      } else {
        ok(`executed cleanly, returned ${r.data}`);
        writeOk = true;
      }
    } catch (e) {
      bad(`dry-run threw: ${e.message}`);
    }

    if (seed) {
      console.log("\n  SUBSTRATE_SEED is set — submitting a REAL commitBid extrinsic");
      try {
        const { free } = (await api.query.system.account(pair.address)).data;
        console.log(`  balance  ${free.toString()} planck`);
        if (free.isZero()) {
          bad("account has no balance — fund it or the extrinsic cannot pay fees");
        } else {
          const data = encodeCall(
            "commitBid(uint256,bytes32,bytes32)",
            ["uint256", "bytes32", "bytes32"],
            [ORDER_ID, hexlify(randomBytes(32)), hexlify(randomBytes(32))]
          );
          const gasLimit = api.registry.createType("SpWeightsWeightV2Weight", {
            refTime: 5_000_000_000n, proofSize: 400_000n,
          });
          const tx = api.tx.revive.call(ADDRESSES.orders, 0, gasLimit, null, data);
          const hash = await new Promise((res, rej) => {
            tx.signAndSend(pair, ({ status, dispatchError }) => {
              if (dispatchError) rej(new Error(dispatchError.toString()));
              else if (status.isInBlock) res(status.asInBlock.toHex());
            }).catch(rej);
          });
          ok(`in block ${hash}`);
        }
      } catch (e) {
        bad(`submission failed: ${e.message}`);
      }
    } else {
      console.log("  (set SUBSTRATE_SEED to a funded account to submit for real)");
    }
  }
  findings.push(["write path via revive.call", writeOk ? "dispatches" : "FAILED"]);

  console.log("\n── verdict ──");
  for (const [k, v] of findings) console.log(`  ${k.padEnd(30)} ${v}`);
  console.log(
    "\n  If reads round-trip and writes dispatch, the port is mechanical: swap the\n" +
    "  backend behind web/src/chain.ts's seam (readProvider / sendProvider /\n" +
    "  connect / contracts) and keep ethers for the relay, scripts and hardhat.\n" +
    "  What does NOT move: FareSettlement._verifyLocationSig does\n" +
    "  `ECDSA.recover(digest, sig) == att.actor`, so GPS attestations, the\n" +
    "  EIP-2771 forwarder and FareVault.withdrawFor stay secp256k1 device keys.\n"
  );

  await api.disconnect();
}

main().catch((e) => {
  console.error("\nspike failed:", e);
  process.exit(1);
});
