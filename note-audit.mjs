import { ethers } from "ethers";
import fs from "node:fs";
const BOOK = JSON.parse(fs.readFileSync("deployed-addresses.json", "utf8"));
const p = new ethers.JsonRpcProvider("https://eth-rpc-testnet.polkadot.io/", undefined, { staticNetwork: true, batchMaxCount: 1 });
const v = new ethers.Contract(BOOK.vault, [
  "event ShieldNoteInserted(address indexed account, uint96 indexed bucket, uint256 commitment, uint32 index)",
  "event ShieldNoteSpent(uint256 nullifierHash)",
  "function nextNoteIndex() view returns (uint32)",
], p);
const head = await p.getBlockNumber();
const FROM = 11541208; // deployment block
const scan = async (filter) => {
  const out = [];
  for (let f = FROM; f <= head; f += 500_000) {
    try { out.push(...await v.queryFilter(filter, f, Math.min(f + 499_999, head))); } catch {}
  }
  return out;
};
const ins = await scan(v.filters.ShieldNoteInserted());
console.log("nextNoteIndex        ", (await v.nextNoteIndex()).toString());
console.log("ShieldNoteInserted   ", ins.length);
for (const e of ins) console.log("   idx", e.args.index.toString(), "bucket", ethers.formatEther(e.args.bucket), "PAS  block", e.blockNumber, "acct", e.args.account.slice(0, 10));
let spent = [];
try { spent = await scan(v.filters.ShieldNoteSpent()); console.log("ShieldNoteSpent      ", spent.length); }
catch { console.log("ShieldNoteSpent      — no such event"); }
