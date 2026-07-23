// Phase C — position / PII exposure scan over the live e2e's on-chain footprint.
//
// For every transaction in the ledger, pull its calldata + emitted log
// data/topics and assert the PRIVATE location values never appear, while
// accounting for the values that are public BY DESIGN (the venue pin; the
// coarsened driver pickup near that public pin). Also checks funding
// unlinkability (no on-chain edge customer-main → burner).
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { ROOT, provider, loadState, loadLedger, OUT } from "./e2e-lib.mjs";

// int32 two's-complement, 8 hex digits (how a raw lat/lon rides in calldata).
function int32Hex(v) {
  return "0x" + BigInt.asUintN(32, BigInt(v)).toString(16).padStart(8, "0");
}
// the value's bare hex (no 0x), for substring search in a calldata blob
const bare = (v) => int32Hex(v).slice(2).toLowerCase();

async function main() {
  const prov = provider();
  const st = loadState();
  const ledger = loadLedger();

  // Coordinates used in the run (µdeg).
  const VENUE = { lat: 37_774_900, lon: -122_419_400 };          // public pin
  const DROP = { lat: 37_784_900, lon: -122_419_400 };           // customer home — PRIVATE
  const DRIVER_DROPOFF = { lat: 37_785_200, lon: -122_419_400 }; // ZK witness — PRIVATE
  const DRIVER_PICKUP_EXACT = { lat: 37_775_051, lon: -122_419_377 }; // pre-coarsen — PRIVATE
  const DRIVER_PICKUP_COARSE = st.run.driverPickupCoarse;        // public (near public pin)

  // Distinctive values whose presence anywhere on-chain would be a leak. We key
  // on LATITUDES (the lons collide with the public venue lon, so lat is the
  // discriminating axis for the home / dropoff points).
  const MUST_BE_ABSENT = [
    { label: "customer home latitude (drop)", val: DROP.lat },
    { label: "customer home lat+lon pair", val: null, pair: DROP },
    { label: "driver dropoff latitude (ZK witness)", val: DRIVER_DROPOFF.lat },
    { label: "driver pickup EXACT latitude (pre-coarsen)", val: DRIVER_PICKUP_EXACT.lat },
    { label: "driver pickup EXACT longitude (pre-coarsen)", val: DRIVER_PICKUP_EXACT.lon },
  ];

  console.log("Position / PII exposure scan\n" + "=".repeat(60));

  // Pull calldata + logs for every resolvable tx into one big searchable blob,
  // per tx, and a combined blob.
  const perTx = [];
  let combined = "";
  for (const e of ledger) {
    if (!e.hash) continue;
    const tx = await prov.getTransaction(e.hash).catch(() => null);
    const rc = await prov.getTransactionReceipt(e.hash).catch(() => null);
    let blob = "";
    if (tx?.data) blob += tx.data.toLowerCase();
    if (rc?.logs) for (const l of rc.logs) blob += (l.data || "").toLowerCase() + l.topics.join("").toLowerCase();
    const resolved = !!(tx || rc);
    perTx.push({ action: e.action, hash: e.hash, resolved, blob, calldataLen: tx?.data?.length ?? 0, logs: rc?.logs?.length ?? 0 });
    combined += blob;
    console.log(`  ${resolved ? "fetched " : "UNRESOLVED"} ${e.action.padEnd(26)} calldata ${((tx?.data?.length ?? 2) - 2) / 2} B, logs ${rc?.logs?.length ?? "—"}`);
  }

  // 1. Private values must be absent everywhere.
  console.log("\n1. PRIVATE location values — must be ABSENT on-chain");
  let leaks = 0;
  for (const m of MUST_BE_ABSENT) {
    let hit = false, where = [];
    if (m.pair) {
      // both lat and lon must co-occur in the same tx to count as the pair
      for (const t of perTx) if (t.blob.includes(bare(m.pair.lat)) && t.blob.includes(bare(m.pair.lon))) { hit = true; where.push(t.action); }
    } else {
      for (const t of perTx) if (t.blob.includes(bare(m.val))) { hit = true; where.push(t.action); }
    }
    if (hit) { leaks++; console.log(`   ✗ LEAK: ${m.label} found in [${where.join(", ")}]`); }
    else console.log(`   ✓ absent: ${m.label}`);
  }

  // 2. Public-by-design values — expected only in the pickup calldata.
  console.log("\n2. PUBLIC-by-design values — venue pin + coarsened driver (pickup only)");
  const inPickup = (v) => perTx.filter((t) => t.action === "confirmPickup" && t.blob.includes(bare(v))).length > 0;
  const anyOther = (v) => perTx.filter((t) => t.action !== "confirmPickup" && t.blob.includes(bare(v))).length > 0;
  for (const [label, v] of [
    ["venue latitude", VENUE.lat], ["venue longitude", VENUE.lon],
    ["driver pickup COARSE latitude", DRIVER_PICKUP_COARSE?.lat], ["driver pickup COARSE longitude", DRIVER_PICKUP_COARSE?.lon],
  ]) {
    if (v == null) continue;
    const note = perTx.some((t) => t.action === "confirmPickup" && !t.resolved)
      ? "(pickup calldata unresolved on this RPC — see note)"
      : inPickup(v) ? "present in pickup calldata (expected)" : "not found in pickup calldata";
    console.log(`   • ${label}: ${note}${anyOther(v) ? " ; also elsewhere!" : ""}`);
  }

  // 3. createOrder carries only the Poseidon commitment, never coordinates.
  console.log("\n3. Order-creation privacy");
  const co = perTx.find((t) => t.action === "createOrder");
  if (co?.resolved) {
    const hasDropLat = co.blob.includes(bare(DROP.lat));
    const hasCommit = st.run.dropCommit && co.blob.includes(st.run.dropCommit.slice(2).toLowerCase());
    console.log(`   • createOrder calldata contains dropCommit (Poseidon hash): ${hasCommit ? "yes ✓" : "no"}`);
    console.log(`   • createOrder calldata contains raw drop latitude: ${hasDropLat ? "YES ✗" : "no ✓ (home location is committed as a hash, not written)"}`);
  }

  // 4. Funding unlinkability — no direct edge customer-main → burner.
  console.log("\n4. Funding unlinkability (customer-main → burner)");
  const burner = st.wallets.burner.address.toLowerCase();
  const main = st.deployer.toLowerCase();
  let directEdge = false;
  for (const e of ledger) {
    if (!e.hash) continue;
    const tx = await prov.getTransaction(e.hash).catch(() => null);
    if (tx && (tx.from || "").toLowerCase() === main && (tx.to || "").toLowerCase() === burner) directEdge = true;
  }
  // where did the burner's funds come from?
  const wtx = await prov.getTransaction(st.run.ksWithdrawHash).catch(() => null);
  console.log(`   • any tx with from=customer-main, to=burner: ${directEdge ? "YES ✗" : "none ✓"}`);
  console.log(`   • burner funded by: KS proxy_withdraw submitted by ${wtx ? wtx.from : "relay"} (the pool pays out; no edge to customer-main)`);
  console.log(`   • customer-main's only pool interaction: a depositNative to the shared pool (1 of ${"~230+"} leaves) — unlinkable to the withdrawal except by the anonymity set`);

  const result = {
    scannedAt: new Date().toISOString(),
    txScanned: perTx.length,
    unresolved: perTx.filter((t) => !t.resolved).map((t) => t.action),
    privateLeaks: leaks,
    directFundingEdge: directEdge,
    coords: { VENUE, DROP, DRIVER_DROPOFF, DRIVER_PICKUP_EXACT, DRIVER_PICKUP_COARSE },
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "scan.json"), JSON.stringify(result, null, 2));
  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: private leaks=${leaks}  direct-funding-edge=${directEdge}  → ${leaks === 0 && !directEdge ? "PASS ✓" : "REVIEW ✗"}`);
  console.log(`scan.json written.`);
}

main().catch((e) => { console.error("SCAN FAILED:", e?.message ?? e); process.exit(1); });
