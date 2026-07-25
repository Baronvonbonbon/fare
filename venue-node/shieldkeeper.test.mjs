// Shielded-payout keeper: planning + the persisted pending set. Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBatch, shuffle, createStore, batchReceipt } from "./shieldkeeper.mjs";

const C = (n) => `0x${String(n).padStart(64, "0")}`;
const held = (n) => Array.from({ length: n }, (_, i) => C(i));

test("planBatch: waits until the batch clears minBatch", () => {
  assert.equal(planBatch({ held: held(7), live: 7, minBatch: 8 }), null);
  assert.equal(planBatch({ held: held(8), live: 8, minBatch: 8 }).length, 8);
});

test("planBatch: never submits more commitments than there are live tickets", () => {
  // Another keeper batched first, or a driver reclaimed: the contract would
  // revert with not-enough-tickets, so cut the batch to what is actually queued.
  assert.equal(planBatch({ held: held(12), live: 9, minBatch: 8 }).length, 9);
  assert.equal(planBatch({ held: held(12), live: 3, minBatch: 8 }), null);
});

test("planBatch: extra on-chain tickets don't inflate a batch we can't fill", () => {
  // Drivers queued through another relay — their commitments are not ours to
  // deposit, so we submit only what we hold.
  assert.equal(planBatch({ held: held(8), live: 40, minBatch: 8 }).length, 8);
});

test("planBatch: does not preserve queue order", () => {
  // The contract consumes tickets FIFO, so submitting in insertion order would
  // line commitments up against ticket ages and give the pairing straight back.
  const input = held(32);
  const runs = Array.from({ length: 8 }, () => planBatch({ held: input, live: 32, minBatch: 8 }).join(","));
  assert.ok(new Set(runs).size > 1, "batches are identical across runs — not shuffled");
  assert.ok(runs.some((r) => r !== input.slice(0, 8).join(",")), "batch preserved queue order");
});

test("shuffle: is a permutation, and does not mutate its input", () => {
  const input = held(16);
  const out = shuffle(input);
  assert.deepEqual([...out].sort(), [...input].sort());
  assert.deepEqual(input, held(16));
});

test("store: pending commitments survive a restart", () => {
  // The failure this guards: a keeper that forgets a commitment after its ticket
  // is consumed has destroyed the payout — spent ticket, no note, no on-chain
  // record of who was owed what.
  const dir = mkdtempSync(join(tmpdir(), "fare-keeper-"));
  const file = join(dir, "keeper.json");
  try {
    const a = createStore(file);
    a.addPending(1000n, C(1));
    a.addPending(1000n, C(2));
    a.addPending(5000n, C(3));

    const b = createStore(file); // restart
    assert.deepEqual(b.heldFor(1000n), [C(1), C(2)]);
    assert.deepEqual(b.heldFor(5000n), [C(3)]);
    assert.deepEqual(b.buckets().sort(), ["1000", "5000"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: the same commitment cannot be queued twice", () => {
  // A client retry must not consume a second ticket for one note.
  const s = createStore(null);
  assert.equal(s.addPending(1000n, C(1)), true);
  assert.equal(s.addPending(1000n, C(1)), false);
  assert.equal(s.heldFor(1000n).length, 1);
});

test("store: settling clears the batch and makes it claimable", () => {
  const s = createStore(null);
  for (const i of [1, 2, 3]) s.addPending(1000n, C(i));
  s.settle(batchReceipt({
    bucket: 1000n, txHash: "0xabc", blockNumber: 42, startIndex: 7,
    preSideNodes: { 0: "0" }, commitments: [C(1), C(2)],
  }));

  assert.deepEqual(s.heldFor(1000n), [C(3)], "deposited commitments stay pending");
  assert.equal(s.isPending(C(3)), true);
  assert.equal(s.receiptFor(C(1)).startIndex, 7);
  assert.equal(s.receiptFor(C(3)), null, "a still-pending commitment has no receipt");
});

test("store: a receipt keeps the full replay list, not just our own leaves", () => {
  // When someone else's deposit lands between the snapshot and the batch, the
  // replay has to start from a state the snapshot actually describes — so
  // foreign leaves lead the list and recipients just find their own.
  const s = createStore(null);
  s.addPending(1000n, C(9));
  const r = batchReceipt({
    bucket: 1000n, txHash: "0xdef", blockNumber: 9, startIndex: 4,
    preSideNodes: {}, commitments: [C(77), C(9)], mine: [C(9)],
  });
  s.settle(r);
  assert.deepEqual(r.commitments, [C(77), C(9)]);
  assert.deepEqual(r.mine, [C(9)]);
  assert.equal(s.receiptFor(C(9)).startIndex, 4);
});

test("store: a corrupt file does not stop the keeper booting", () => {
  const dir = mkdtempSync(join(tmpdir(), "fare-keeper-"));
  const file = join(dir, "keeper.json");
  try {
    const s = createStore(file);
    s.addPending(1000n, C(1));
    writeFileSync(file, "{ not json");
    const fresh = createStore(file);
    assert.deepEqual(fresh.heldFor(1000n), []);
    fresh.addPending(1000n, C(2)); // still writable
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).pending.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
