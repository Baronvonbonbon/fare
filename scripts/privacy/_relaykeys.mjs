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
const p = new ethers.JsonRpcProvider("https://eth-rpc-testnet.polkadot.io/", undefined, { staticNetwork: true });
const key = (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m))[1].trim();
const d = new ethers.Wallet(key, p);
const TOP = ethers.parseEther("25");
for (const r of relays) {
  const bal = await p.getBalance(r.address);
  if (bal < TOP / 2n) {
    const tx = await d.sendTransaction({ to: r.address, value: TOP, gasLimit: 100_000n });
    await tx.wait();
    console.log(`relay ${r.id} ${r.address} funded ${ethers.formatEther(TOP)} PAS  ${tx.hash}`);
  } else console.log(`relay ${r.id} ${r.address} already holds ${ethers.formatEther(bal)} PAS`);
}
