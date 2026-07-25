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

  /// Keep the mock's sideNodes equal to what the real pool would hold, by
  /// replaying its leaves through the reference tree. Without this the second
  /// deposit chunk snapshots an all-zero tree and every path after the first two
  /// leaves is wrong — which is exactly the bug shape this suite exists to catch.
  async function syncSideNodes(f: any) {
    const n = Number(await f.pool.depositCount());
    const tree = new LeanIMT();
    for (let i = 0; i < n; i++) tree.insert(BigInt(await f.pool.commitments(i)));
    const levels = [...tree.sn.keys()];
    await f.pool.setSideNodes(levels, levels.map((lv) => tree.sn.get(lv)!));
  }

  /// `beforeCall(i)` runs before submit #i — 0 is the seal, 1+ are deposits.
  const keeperArgs = (f: any, store: any, beforeCall: (i: number) => Promise<void> = async () => {}) => {
    let call = 0;
    return {
      vault: f.vault.connect(f.keeper),
      pool: f.pool,
      provider: ethers.provider,
      store,
      submit: async (fn: any) => {
        await beforeCall(call++);
        const tx = await fn({});
        await tx.wait();
        await syncSideNodes(f); // before the keeper snapshots for the next chunk
        return tx;
      },
      maxPerTx: 2, // the Paseo ceiling, so chunking is exercised
      log: () => {},
    };
  };

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

    // 3. After the dwell: ONE seal covering all eight (that is the anonymity
    //    set), then deposits in chain-sized chunks.
    await time.increase(MIN_DWELL + 1);
    const executed = await keeperTick(keeperArgs(f, store));
    expect(executed.reduce((n: number, e: any) => n + e.count, 0)).to.equal(MIN_BATCH);
    expect(new Set(executed.map((e: any) => e.sealTxHash)).size, "one seal for the whole batch").to.equal(1);
    expect(await f.pool.depositCount()).to.equal(MIN_BATCH);
    expect(await f.vault.shieldBuffer()).to.equal(0);
    expect(await f.vault.shieldOwed(bucket)).to.equal(0);
    expect(store.stats().pending).to.equal(0);

    // The seal names the accounts but no commitment; the deposits name the
    // commitments but no account. Neither alone pairs anything.
    const blobOf = async (hash: string) => {
      const tx = await ethers.provider.getTransaction(hash);
      const rec = await ethers.provider.getTransactionReceipt(hash);
      return (tx!.data + rec!.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    };
    const sealBlob = await blobOf(executed[0].sealTxHash);
    for (const q of queued) {
      expect(sealBlob, "the seal tx leaked a commitment").to.not.include(q.commitment.slice(2).toLowerCase());
    }
    for (const e of executed) {
      const depositBlob = await blobOf(e.txHash);
      for (const q of queued) {
        expect(depositBlob, "a deposit tx leaked an account").to.not.include(q.driver.address.slice(2).toLowerCase());
      }
    }

    // 4. Client side: each driver finds its own commitment in its chunk's replay
    //    list and derives its leaf position. Nobody told them their index.
    const tree = new LeanIMT();
    const onChain: string[] = [];
    for (let i = 0; i < Number(await f.pool.depositCount()); i++) {
      const c = await f.pool.commitments(i);
      onChain.push(c);
      tree.insert(BigInt(c));
    }

    for (const q of queued) {
      const receipt = store.receiptFor(q.commitment);
      expect(receipt, `${q.commitment} was never deposited`).to.not.equal(null);
      const mine = receipt.commitments.findIndex((c: string) => c.toLowerCase() === q.commitment.toLowerCase());
      expect(mine).to.be.gte(0);

      const paths = batchNotePaths(Number(receipt.startIndex), receipt.preSideNodes, receipt.commitments.map((c: string) => BigInt(c)));
      const { index, leftSnapshot } = paths[mine];
      expect(index, "derived index disagrees with the pool").to.equal(
        onChain.findIndex((x) => x.toLowerCase() === q.commitment.toLowerCase())
      );

      // The real test: the derived left path must agree with a full-tree proof,
      // and rebuild the pool's root. A wrong path proves nothing on-chain.
      const full = tree.proof(index);
      for (let lv = 0; lv < 128; lv++) {
        if (((BigInt(index) >> BigInt(lv)) & 1n) === 1n) {
          expect(BigInt(leftSnapshot[lv] ?? "0"), `left sibling at level ${lv}`).to.equal(full[lv]);
        }
      }
      expect(rootFrom(commitmentOf(q.note), index, full)).to.equal(tree.root);
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
    await syncSideNodes(f); // the tree the keeper's first snapshot must see
    const commitments: string[] = [];
    for (const d of f.drivers) {
      const { commitment } = await driverQueues(f.vault, f.keeper, d, bucket);
      store.addPending(bucket, commitment);
      commitments.push(commitment);
    }
    await time.increase(MIN_DWELL + 1);

    // Slip two foreign deposits in AFTER the keeper snapshots and BEFORE its
    // batch — exactly the race the log-derived index recovery exists for.
    const foreignFixed = [b32(5555n), b32(6666n)];
    // The foreign deposits land before the FIRST deposit chunk (the hook runs on
    // every submit; only the first matters for the leading gap).
    const executed = await keeperTick(
      keeperArgs(f, store, async (i: number) => {
        // Call 0 is the seal (no snapshot); call 1 is the first deposit chunk,
        // whose snapshot these leaves must land after.
        if (i !== 1) return;
        for (const c of foreignFixed) await f.pool.foreignDeposit(c, { value: PAS(1) });
      })
    );
    expect(executed.length).to.be.greaterThan(0);

    // Exactly one chunk should have replayed the foreign leaves ahead of its own.
    const receipts = commitments.map((c) => store.receiptFor(c)).filter(Boolean);
    expect(receipts.length).to.equal(MIN_BATCH);
    const leading = receipts.find((r: any) => r.commitments[0] === foreignFixed[0]);
    expect(leading, "no chunk replayed the foreign leaves").to.not.equal(undefined);
    expect(leading.startIndex).to.equal(1); // one pre-existing leaf
    expect(leading.commitments.slice(0, 2)).to.deep.equal(foreignFixed);

    // Every driver still lands on its true index, verified against the tree the
    // pool actually holds — across every chunk.
    const onChain: string[] = [];
    for (let i = 0; i < Number(await f.pool.depositCount()); i++) onChain.push(await f.pool.commitments(i));

    for (const c of commitments) {
      const r = store.receiptFor(c);
      expect(r, `${c} was never deposited`).to.not.equal(null);
      const paths = batchNotePaths(Number(r.startIndex), r.preSideNodes, r.commitments.map((x: string) => BigInt(x)));
      const mine = r.commitments.findIndex((x: string) => x.toLowerCase() === c.toLowerCase());
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

    expect(executed.reduce((n: number, e: any) => n + e.count, 0)).to.equal(MIN_BATCH);
    for (const c of commitments) expect(after.receiptFor(c), `${c} lost across restart`).to.not.equal(null);
  });
});
