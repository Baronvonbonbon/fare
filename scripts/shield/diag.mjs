import { ethers } from "ethers";
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const DEP = ethers.id("Deposit(address,bytes32)");
const NEW = ethers.id("NewCommitment(bytes32)");
const WD = ethers.id("Withdrawal(address,uint256,address,uint256)");

async function safe(filter, from, to, out) {
  try { out.push(...await p.getLogs({ ...filter, fromBlock: from, toBlock: to })); }
  catch (e) { if (to <= from) throw e; const m = (from + to) >> 1; await safe(filter, from, m, out); await safe(filter, m + 1, to, out); }
}

const main = async () => {
  const cur = await p.getBlockNumber();
  const treeSize = await new ethers.Contract(POOL, ["function treeSize() view returns (uint256)"], p).treeSize();
  console.log(`pool ${POOL}  block ${cur}  treeSize ${treeSize}`);

  // Full-range, tiny chunks, no topic filter — capture EVERYTHING from the pool.
  const all = [];
  const STEP = Number(process.env.STEP ?? 5000);
  let scanned = 0;
  for (let s = 0; s <= cur; s += STEP) { await safe({ address: POOL }, s, Math.min(s + STEP - 1, cur), all); scanned++; }
  console.log(`scanned ${scanned} chunks of ${STEP}, got ${all.length} total logs`);

  const byTopic = {};
  for (const l of all) byTopic[l.topics[0]] = (byTopic[l.topics[0]] || 0) + 1;
  const name = (t) => t === DEP ? "Deposit" : t === NEW ? "NewCommitment" : t === WD ? "Withdrawal" : t.slice(0, 12);
  for (const [t, n] of Object.entries(byTopic)) console.log(`  ${name(t)}: ${n}`);

  const inserts = (byTopic[DEP] || 0) + (byTopic[NEW] || 0);
  console.log(`inserts (Deposit+NewCommitment) = ${inserts}  vs treeSize ${treeSize}  => ${inserts === Number(treeSize) ? "MATCH ✓" : "MISSING " + (Number(treeSize) - inserts)}`);

  // Block window of insert events
  const ins = all.filter((l) => l.topics[0] === DEP || l.topics[0] === NEW).sort((a, b) => a.blockNumber - b.blockNumber);
  if (ins.length) console.log(`insert events span blocks ${ins[0].blockNumber} .. ${ins[ins.length - 1].blockNumber}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
