import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { poseidon2 } from "poseidon-lite";

// End-to-end for privacy phase 1 (docs/PRIVACY-TIERS.md §4): the REAL contract,
// the REAL keeper module, and the REAL client path derivation, wired together.
//
// The unit suites cover each piece alone. What only shows up here is the seam:
// a driver queues, a keeper batches, and the driver must end up able to prove a
// Merkle path for a note they never deposited themselves. Every failure mode in
// between is silent — a wrong index or a stale snapshot yields a note that looks
// perfectly fine and proves nothing.
//
// The pool is mocked (the live one needs a Poseidon precompile), so the tree math
// is checked against a reference LeanIMT — the same construction the pool uses.

// The keeper is ESM (.mjs) and the client is ESM TypeScript, while hardhat's
// test runner is CJS — so pull them through a REAL dynamic import (a plain
// `import` would be transpiled to require() and fail on the ESM boundary).
// Loading the actual modules is the point: a reimplementation here would test
// this file rather than the code that ships.
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const loadEsm = (rel: string) => esmImport(pathToFileURL(join(__dirname, rel)).href);

type Note = { nullifier: string; secret: string; value: string };
let createStore: any, keeperTick: any, batchNotePaths: any, makeNote: any, commitmentOf: any;

const PAS = (n: number) => ethers.parseEther(String(n));
const BUCKETS = [PAS(1), PAS(5), PAS(25)];
const MIN_BATCH = 8;
const MIN_DWELL = 5 * 60;

const b32 = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");

/// Reference LeanIMT: parent = Poseidon(l, r), lone node promotes, root = last
/// inserted node. Mirrors the deployed pool.
class LeanIMT {
  leaves: bigint[] = [];
  sn = new Map<number, bigint>();
  root = 0n;
  insert(leaf: bigint) {
    const idx = this.leaves.length;
    let node = leaf;
    for (let lv = 0; lv < 128; lv++) {
      const set = ((BigInt(idx) >> BigInt(lv)) & 1n) === 1n;
      if (set) { const s = this.sn.get(lv) ?? 0n; if (s !== 0n) node = poseidon2([s, node]); }
      else this.sn.set(lv, node);
    }
    this.root = node;
    this.leaves.push(leaf);
  }
  /// Full authentication path for a leaf, as the pool's verifier would want it.
  proof(leafIndex: number): bigint[] {
    let layer = [...this.leaves];
    let idx = leafIndex;
    const sibs: bigint[] = [];
    for (let lv = 0; lv < 128; lv++) {
      const si = idx % 2 === 0 ? idx + 1 : idx - 1;
      sibs.push(si >= 0 && si < layer.length ? layer[si] : 0n);
      const next: bigint[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        next.push(i + 1 < layer.length ? poseidon2([layer[i], layer[i + 1]]) : layer[i]);
      }
      layer = next;
      idx = Math.floor(idx / 2);
    }
    return sibs;
  }
}

const rootFrom = (leaf: bigint, index: number, sibs: bigint[]) => {
  let node = leaf;
  for (let lv = 0; lv < 128; lv++) {
    const s = sibs[lv];
    if (s === 0n) continue;
    node = ((BigInt(index) >> BigInt(lv)) & 1n) === 1n ? poseidon2([s, node]) : poseidon2([node, s]);
  }
  return node;
};

describe("privacy phase 1 — end to end (vault → keeper → spendable note)", () => {
  let dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "fare-e2e-"));
    ({ createStore, runOnce: keeperTick } = await loadEsm("../venue-node/shieldkeeper.mjs"));
    ({ batchNotePaths, makeNote, commitmentOf } = await loadEsm("../web/src/shieldpool.ts"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  async function fixture() {
    const [owner, keeper, crediter, ...rest] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();

    await vault.setAuthorized(crediter.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets(BUCKETS);
    await vault.setShieldKeeper(keeper.address, true);

    const drivers = rest.slice(0, MIN_BATCH);
    for (const d of drivers) await vault.connect(crediter).credit(d.address, { value: PAS(10) });
    return { vault, pool, owner, keeper, crediter, drivers };
  }

  /// A driver's half: make the note locally, authorize moving a bucket, and hand
  /// the relay ONLY the commitment. The note secrets never leave this scope —
  /// that is the property, not an implementation detail.
  async function driverQueues(vault: any, keeper: any, driver: any, bucket: bigint) {
    const note = makeNote(bucket);
    const commitment = b32(commitmentOf(note));
    const nonce = await vault.shieldNonce(driver.address);
    const deadline = BigInt(await time.latest()) + 3600n;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const signature = await driver.signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: vault.target as string },
      {
        ShieldCredit: [
          { name: "account", type: "address" },
          { name: "bucket", type: "uint96" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: driver.address, bucket, nonce, deadline }
    );
    // The relay's /shield-queue: submits the authorization, holds the commitment.
    const tx = await vault.connect(keeper).queueShieldCreditFor(driver.address, bucket, deadline, signature);
    return { note, commitment, tx };
  }

  const keeperArgs = (f: any, store: any, extra: () => Promise<void> = async () => {}) => ({
    vault: f.vault.connect(f.keeper),
    pool: f.pool,
    provider: ethers.provider,
    store,
    submit: async (call: any) => { await extra(); return call({}); },
    log: () => {},
  });

  it("carries a payout from vault balance to a note whose path proves against the pool root", async () => {
    const f = await loadFixture(fixture);
    const store = createStore(join(dir, "happy.json"));
    const bucket = BUCKETS[0];

    // 1. Eight drivers queue. Each keeps its own note; the relay only ever sees
    //    a commitment, and never in the same transaction as the account.
    const queued: { driver: any; note: Note; commitment: string }[] = [];
    for (const d of f.drivers) {
      const { note, commitment, tx } = await driverQueues(f.vault, f.keeper, d, bucket);
      store.addPending(bucket, commitment);
      queued.push({ driver: d, note, commitment });

      const receipt = await tx.wait();
      const blob = (tx.data + receipt!.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
      expect(blob, "the queue tx leaked a commitment").to.not.include(commitment.slice(2).toLowerCase());
    }
    expect(await f.vault.shieldPending(bucket)).to.equal(MIN_BATCH);
    expect(await f.vault.shieldBuffer()).to.equal(bucket * BigInt(MIN_BATCH));

    // 2. Too soon: the keeper must not chase a fresh ticket.
    expect(await keeperTick(keeperArgs(f, store))).to.deep.equal([]);
    expect(await f.pool.depositCount()).to.equal(0);

    // 3. After the dwell, one batch deposits all eight.
    await time.increase(MIN_DWELL + 1);
    const executed = await keeperTick(keeperArgs(f, store));
    expect(executed).to.have.length(1);
    expect(executed[0].count).to.equal(MIN_BATCH);
    expect(await f.pool.depositCount()).to.equal(MIN_BATCH);
    expect(await f.vault.shieldBuffer()).to.equal(0);
    expect(store.stats().pending).to.equal(0);

    // The batch names no account — the other half of the invariant.
    const batchTx = await ethers.provider.getTransaction(executed[0].txHash);
    const batchReceipt = await ethers.provider.getTransactionReceipt(executed[0].txHash);
    const batchBlob = (batchTx!.data + batchReceipt!.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    for (const q of queued) {
      expect(batchBlob, "the batch tx leaked an account").to.not.include(q.driver.address.slice(2).toLowerCase());
    }

    // 4. Client side: each driver finds its own commitment in the replay list and
    //    derives its leaf position. Nobody told them their index.
    const receipt = store.receiptFor(queued[0].commitment);
    expect(receipt).to.not.equal(null);

    const tree = new LeanIMT();
    for (const c of receipt.commitments) tree.insert(BigInt(c));

    for (const q of queued) {
      const mine = receipt.commitments.findIndex((c: string) => c.toLowerCase() === q.commitment.toLowerCase());
      expect(mine, `${q.commitment} missing from the batch receipt`).to.be.gte(0);

      const paths = batchNotePaths(Number(receipt.startIndex), receipt.preSideNodes, receipt.commitments.map((c: string) => BigInt(c)));
      const { index, leftSnapshot } = paths[mine];

      // The real test: the derived left path must agree with a full-tree proof,
      // and rebuild the pool's root. A wrong path proves nothing on-chain.
      const full = tree.proof(index);
      for (let lv = 0; lv < 128; lv++) {
        if (((BigInt(index) >> BigInt(lv)) & 1n) === 1n) {
          expect(BigInt(leftSnapshot[lv] ?? "0"), `left sibling at level ${lv}`).to.equal(full[lv]);
        }
      }
      expect(rootFrom(commitmentOf(q.note), index, full)).to.equal(tree.root);
      // ...and the note the driver held is the one that landed.
      expect(await f.pool.depositedValue(q.commitment)).to.equal(bucket);
    }
  });

  it("survives a foreign deposit landing between the keeper's snapshot and its batch", async () => {
    // The silent killer: the pre-batch treeSize is a prediction, and anyone can
    // deposit before the batch is included. If the keeper trusted the prediction,
    // every recipient would derive a path one leaf off and their notes would be
    // unspendable — with nothing to indicate anything went wrong.
    const f = await loadFixture(fixture);
    const store = createStore(join(dir, "shifted.json"));
    const bucket = BUCKETS[0];

    await f.pool.foreignDeposit(b32(1234n), { value: PAS(1) }); // pool isn't empty
    const commitments: string[] = [];
    for (const d of f.drivers) {
      const { commitment } = await driverQueues(f.vault, f.keeper, d, bucket);
      store.addPending(bucket, commitment);
      commitments.push(commitment);
    }
    await time.increase(MIN_DWELL + 1);

    // Slip two foreign deposits in AFTER the keeper snapshots and BEFORE its
    // batch — exactly the race the log-derived index recovery exists for.
    const foreign = [b32(5555n), b32(6666n)];
    const executed = await keeperTick(
      keeperArgs(f, store, async () => {
        for (const c of foreign) await f.pool.foreignDeposit(c, { value: PAS(1) });
      })
    );
    expect(executed).to.have.length(1);

    const receipt = store.receiptFor(commitments[0]);
    // The replay must lead with the interlopers so it starts from a tree state
    // the snapshot actually describes.
    expect(receipt.startIndex).to.equal(1); // one pre-existing leaf
    expect(receipt.commitments.slice(0, 2)).to.deep.equal(foreign);
    expect(receipt.commitments).to.have.length(foreign.length + MIN_BATCH);
    expect(receipt.mine).to.have.length(MIN_BATCH);

    // Every driver still lands on its true index, verified against the tree the
    // pool actually holds.
    const paths = batchNotePaths(Number(receipt.startIndex), receipt.preSideNodes, receipt.commitments.map((c: string) => BigInt(c)));
    const onChain: string[] = [];
    for (let i = 0; i < Number(await f.pool.depositCount()); i++) onChain.push(await f.pool.commitments(i));

    for (const c of commitments) {
      const mine = receipt.commitments.findIndex((x: string) => x.toLowerCase() === c.toLowerCase());
      expect(paths[mine].index).to.equal(onChain.findIndex((x) => x.toLowerCase() === c.toLowerCase()));
    }
  });

  it("keeps a payout recoverable when the keeper never runs", async () => {
    const f = await loadFixture(fixture);
    const store = createStore(join(dir, "stalled.json"));
    const bucket = BUCKETS[1];
    const [d] = f.drivers;

    await driverQueues(f.vault, f.keeper, d, bucket);
    expect(await f.vault.balanceOf(d.address)).to.equal(PAS(10) - bucket);

    await time.increase(24 * 60 * 60 + 1);
    await f.vault.connect(d).reclaimShieldTicket(bucket, 0);
    expect(await f.vault.balanceOf(d.address)).to.equal(PAS(10));
    expect(await f.vault.shieldBuffer()).to.equal(0);
    expect(store.stats().pending).to.equal(0);
  });

  it("does not lose commitments across a keeper restart", async () => {
    // A forgotten commitment is an unrecoverable loss: the ticket is spent and
    // nothing on-chain records who was owed a note.
    const f = await loadFixture(fixture);
    const file = join(dir, "restart.json");
    const bucket = BUCKETS[0];

    const before = createStore(file);
    const commitments: string[] = [];
    for (const d of f.drivers) {
      const { commitment } = await driverQueues(f.vault, f.keeper, d, bucket);
      before.addPending(bucket, commitment);
      commitments.push(commitment);
    }
    expect(JSON.parse(readFileSync(file, "utf8")).pending).to.have.length(MIN_BATCH);

    await time.increase(MIN_DWELL + 1);
    const after = createStore(file); // relay restarted
    const executed = await keeperTick(keeperArgs(f, after));

    expect(executed[0].count).to.equal(MIN_BATCH);
    for (const c of commitments) expect(after.receiptFor(c), `${c} lost across restart`).to.not.equal(null);
  });
});
