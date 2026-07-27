import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const OUT = path.join(ROOT, "e2e-runs", "relay-lab");
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, "relays.json");
let relays;
if (fs.existsSync(file)) { relays = JSON.parse(fs.readFileSync(file, "utf8")); }
else {
  relays = ["A", "B", "C"].map((id, i) => {
    const w = ethers.Wallet.createRandom();
    return { id, port: 8788 + i, address: w.address, privateKey: w.privateKey };
  });
  fs.writeFileSync(file, JSON.stringify(relays, null, 2));
}
const p = new ethers.JsonRpcProvider(
  process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/", undefined, { staticNetwork: true });

// The env wins over .env, so this runs unattended (E3's nightly has the key as a
// secret and no .env at all). Reading .env directly and indexing the match was
// how this started, which threw a TypeError on a missing file — a confusing
// failure for the one thing an operator is most likely to have got wrong.
function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY.trim();
  const envFile = path.join(ROOT, ".env");
  const m = fs.existsSync(envFile)
    && fs.readFileSync(envFile, "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error("DEPLOYER_PRIVATE_KEY not set (env or .env) — the relays cannot be funded");
  return m[1].trim();
}
const d = new ethers.Wallet(deployerKey(), p);
const TOP = ethers.parseEther("25");
for (const r of relays) {
  const bal = await p.getBalance(r.address);
  if (bal < TOP / 2n) {
    const tx = await d.sendTransaction({ to: r.address, value: TOP, gasLimit: 100_000n });
    await tx.wait();
    console.log(`relay ${r.id} ${r.address} funded ${ethers.formatEther(TOP)} PAS  ${tx.hash}`);
  } else console.log(`relay ${r.id} ${r.address} already holds ${ethers.formatEther(bal)} PAS`);
}
