#!/usr/bin/env node
// Bring up the three-relay lab, run something against it, tear it down.
//
// `measure-costs.mjs` needs three RUNNING relays: phase 3b routes a note's
// insert and its spend to different ones, and the point of the run is that no
// single relay sees both halves. Until now that was three terminals and a
// README — which is precisely why the live cost ledger never ran unattended
// (TEST-PLAN A3, E3).
//
// Usage:
//   node scripts/privacy/relay-lab.mjs                       # just the relays, Ctrl-C to stop
//   node scripts/privacy/relay-lab.mjs measure-costs.mjs     # run it, then tear down
//
// The deployer key comes from DEPLOYER_PRIVATE_KEY (env or .env). Relay keys
// are generated once into e2e-runs/relay-lab/relays.json and topped up from the
// deployer — that file is gitignored and holds real testnet keys.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "e2e-runs", "relay-lab");
const RELAY_MJS = path.join(ROOT, "venue-node", "relay.mjs");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";

const HEALTH_TIMEOUT_MS = Number(process.env.LAB_HEALTH_TIMEOUT_MS || 90_000);

/// Relays hold real PAS, so a relay that came up under-funded fails deep inside
/// the run with an opaque revert. Check it at the door instead.
const MIN_RELAY_PAS = 5n * 10n ** 18n;

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // Funding + key generation is _relaykeys.mjs' job; it is idempotent and skips
  // relays that already hold enough.
  console.log("── funding relays ──");
  await run(process.execPath, [path.join(ROOT, "scripts", "privacy", "_relaykeys.mjs")], { cwd: ROOT });

  const relays = JSON.parse(fs.readFileSync(path.join(OUT, "relays.json"), "utf8"));
  const { JsonRpcProvider, formatEther } = await import("ethers");
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  for (const r of relays) {
    const bal = await provider.getBalance(r.address);
    if (bal < MIN_RELAY_PAS) {
      throw new Error(`relay ${r.id} (${r.address}) holds ${formatEther(bal)} PAS — fund the deployer and re-run`);
    }
  }

  console.log("\n── starting relays ──");
  const procs = [];
  let shuttingDown = false;
  for (const r of relays) {
    const child = spawn(process.execPath, [RELAY_MJS], {
      cwd: path.join(ROOT, "venue-node"),
      env: {
        ...process.env,
        RELAY_PRIVATE_KEY: r.privateKey,
        RELAY_PORT: String(r.port),
        RELAY_RPC_URL: RPC,
        ADDRESS_BOOK: path.join(ROOT, "deployed-addresses.json"),
        // Testnet fares are far below break-even (A2: 183 PAS), so with the
        // guard on every settlement declines and the run measures nothing. The
        // economics are A2's subject; this run is about who pays and how much.
        RELAY_PROFIT_GUARD: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => process.stdout.write(`[${r.id}] ${b}`));
    child.stderr.on("data", (b) => process.stderr.write(`[${r.id}] ${b}`));
    child.on("exit", (code) => {
      if (!shuttingDown) console.error(`[${r.id}] relay exited early (${code})`);
    });
    procs.push({ ...r, child });
  }

  const stopAll = () => {
    shuttingDown = true;
    for (const p of procs) { try { p.child.kill("SIGTERM"); } catch {} }
  };
  process.on("SIGINT", () => { stopAll(); process.exit(130); });
  process.on("SIGTERM", () => { stopAll(); process.exit(143); });

  try {
    await Promise.all(procs.map((p) => waitHealthy(p)));
    console.log(`\n── all ${procs.length} relays healthy ──\n`);

    if (!cmd) {
      console.log("no command given — relays are up. Ctrl-C to stop.");
      await new Promise(() => {}); // hold until signalled
    }

    const script = path.isAbsolute(cmd) ? cmd : path.join(ROOT, "scripts", "privacy", cmd);
    const code = await run(process.execPath, [script, ...rest], { cwd: ROOT, check: false });
    stopAll();
    process.exit(code);
  } catch (e) {
    stopAll();
    throw e;
  }
}

/// Poll /health until the relay answers or we give up. A relay that cannot
/// reach the RPC binds its port and then fails every request, so "the port is
/// open" is not the same as "this relay works" — /health reads the chain.
async function waitHealthy({ id, port, address }) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      if (res.ok && body.ok) {
        if (body.relay?.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`relay ${id} on :${port} reports ${body.relay}, expected ${address} — `
            + `is another relay already bound to that port?`);
        }
        console.log(`[${id}] healthy on :${port} — ${body.balance} PAS`);
        return;
      }
      last = `status ${res.status}`;
    } catch (e) {
      if (/expected/.test(e?.message ?? "")) throw e; // wrong relay: never recoverable
      last = e?.message ?? String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`relay ${id} never became healthy on :${port} (${last})`);
}

function run(bin, args, { cwd, check = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit", env: process.env });
    child.on("exit", (code) => {
      if (check && code !== 0) reject(new Error(`${path.basename(args[0])} exited ${code}`));
      else resolve(code ?? 1);
    });
    child.on("error", reject);
  });
}

// Leave when the work is done. ethers' provider keeps a block poller running, so
// a finished run would otherwise sit there looking unfinished — in CI, until the
// job timed out. Reports above are written synchronously, so there is nothing
// pending to lose. (e2e-lib's runScript does the same for the shield scripts.)
main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.message ?? e);
  process.exit(1);
});
