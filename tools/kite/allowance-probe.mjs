#!/usr/bin/env node
// Allowance + QR-pairing — the Node half of kite.
//
// @parity/product-sdk-terminal is explicitly the "CLI/terminal apps" surface:
// it pairs to the mobile Polkadot App over a QR code and gives you a signer
// without the key ever touching this machine. That is interesting to FARE twice
// over:
//
//   1. It answers spikes S1 and S3 directly. hasBulletinAllowance and
//      hasStatementStoreAllowance are exactly the two questions blocking the
//      storage migration (plan §4.6) and the Statement Store work (§4.3).
//   2. It is the replacement for DEPLOYER_PRIVATE_KEY in scripts/deploy.ts and
//      the upgrade-*.ts scripts, which currently read a raw key from .env.
//
// Usage:  node allowance-probe.mjs [--product kite] [--index 1]
//
// Scan the printed QR with the Polkadot App. Nothing is written on-chain — this
// only reads allowance state and derives public keys.

import {
  createTerminalAdapter,
  createNodeStorageAdapter,
  waitForSessions,
  renderQrCode,
  hasBulletinAllowance,
  hasStatementStoreAllowance,
  deriveProductPublicKey,
  sessionRootPublicKey,
} from "@parity/product-sdk-terminal";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PRODUCT_ID = arg("--product", "kite");
const ALT_INDEX = Number(arg("--index", "1"));
const PAIR_TIMEOUT_MS = 180_000;

const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);

async function main() {
  console.log(`\nFARE allowance probe — product "${PRODUCT_ID}"\n`);

  const adapter = await createTerminalAdapter({
    appId: PRODUCT_ID,
    storage: createNodeStorageAdapter(PRODUCT_ID),
  });

  // A stored session means we already paired on a previous run.
  let sessions = await waitForSessions(adapter, 1_000).catch(() => []);
  if (!sessions?.length) {
    const uri = await adapter.getPairingUri?.();
    if (!uri) {
      console.error("Adapter exposed no pairing URI — check @parity/product-sdk-terminal's version.");
      process.exit(2);
    }
    console.log(await renderQrCode(uri));
    console.log("\nScan with the Polkadot App to pair. Waiting up to 3 minutes…\n");
    sessions = await waitForSessions(adapter, PAIR_TIMEOUT_MS);
  }

  if (!sessions?.length) {
    console.error("No session established — pairing timed out.");
    process.exit(1);
  }

  const session = sessions[0];
  console.log("Paired ✓\n");
  console.log("SESSION");
  line("root public key", hex(sessionRootPublicKey(session)));

  // Per-product, per-index derivation. Plan §4.1 wants a fresh index per order
  // so burners are reproducible without a seed backup; §4.3 needs to know
  // whether such an index can hold its OWN statement-store allowance, which is
  // what makes per-order unlinkability survive the move off the relay.
  console.log("\nPRODUCT ACCOUNTS  (ProductAccountRef = { productId, derivationIndex })");
  for (const derivationIndex of [0, ALT_INDEX]) {
    try {
      const pk = deriveProductPublicKey(session, { productId: PRODUCT_ID, derivationIndex });
      line(`index ${derivationIndex}`, hex(pk));
    } catch (e) {
      line(`index ${derivationIndex}`, `FAILED: ${e.message}`);
    }
  }
  console.log(
    "  → distinct keys per index means per-order accounts are derivable (plan §4.1).\n" +
      "    Whether each can hold its own allowance is the S3 question below."
  );

  console.log("\nALLOWANCES");
  for (const [label, fn, spike] of [
    ["Bulletin", hasBulletinAllowance, "S1 — gates the whole storage migration"],
    ["Statement Store", hasStatementStoreAllowance, "S3 — gates chat/auction on Statement Store"],
  ]) {
    try {
      const has = await fn(adapter, PRODUCT_ID);
      line(`${label} allowance`, `${has ? "YES" : "no"}   (${spike})`);
    } catch (e) {
      line(`${label} allowance`, `ERROR: ${e.message}`);
    }
  }

  console.log(
    "\nNOTE  AutoSigning reports NotAvailable on both Android and iOS wallets\n" +
      "      (documented in @parity/product-sdk-terminal's own types). Every host-routed\n" +
      "      signature therefore needs a user tap — which is independent corroboration of\n" +
      "      plan §4.1: GPS attestations cannot go through the host signer.\n"
  );

  await adapter.close?.();
}

main().catch((e) => {
  console.error("\nprobe failed:", e);
  process.exit(1);
});
