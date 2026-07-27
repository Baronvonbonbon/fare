// Batch decorrelation (TEST-PLAN B6). Run: npm test (node --test, no deps).
//
// The phase-1 shielded payout splits one flow across two transactions: a queue
// tx that names the ACCOUNT, and a deposit tx that names the COMMITMENT. Neither
// carries both, which is what privacy-e2e.test.ts asserts.
//
// That is not sufficient on its own. An observer sees ShieldQueued events in
// queue order and pool deposits in deposit order; if the two orders agree, the
// pairing falls out by POSITION and the split has bought nothing. The contract
// consumes tickets FIFO, so the keeper's shuffle is the only thing standing
// between those two lists.
//
// shieldkeeper.test.mjs already asserts that batches differ across runs. That
// shows randomness exists; it does not show the ordering is decorrelated. A
// shuffle that merely rotated the array by a random offset would pass it while
// leaving every item's position perfectly predictable from its neighbour's.
// So this measures the property itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shuffle, planBatch, depositChunks } from "./shieldkeeper.mjs";

const N = 8;              // the deployed shieldMinBatch
const TRIALS = 20_000;
const items = Array.from({ length: N }, (_, i) => `c${i}`);
const indexOf = new Map(items.map((c, i) => [c, i]));

/// Counts[i][j] = how often the item queued i-th landed j-th in the batch.
function positionCounts(permute) {
  const counts = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let t = 0; t < TRIALS; t++) {
    const out = permute(items);
    for (let pos = 0; pos < out.length; pos++) counts[indexOf.get(out[pos])][pos]++;
  }
  return counts;
}

// Expected count per cell, and the spread a fair shuffle produces. 5σ over 64
// cells is a ~1-in-30,000 false-alarm rate — tight enough to catch a biased
// shuffle, loose enough not to flake.
const EXPECTED = TRIALS / N;
const SIGMA = Math.sqrt(TRIALS * (1 / N) * (1 - 1 / N));
const TOLERANCE = 5 * SIGMA;

test("every commitment is equally likely to land in every batch position", () => {
  // The property an attacker cares about: knowing an item was queued third must
  // say nothing about where it appears in the deposit stream.
  const counts = positionCounts(shuffle);

  let worst = 0, where = "";
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const dev = Math.abs(counts[i][j] - EXPECTED);
      if (dev > worst) { worst = dev; where = `queued ${i} → position ${j}`; }
    }
  }
  assert.ok(
    worst < TOLERANCE,
    `positional bias: ${where} deviated ${worst.toFixed(0)} from ${EXPECTED} (tolerance ${TOLERANCE.toFixed(0)}, σ=${SIGMA.toFixed(1)})`
  );
});

test("queue position and batch position are uncorrelated", () => {
  // A rotation, a partial shuffle, or an off-by-one Fisher-Yates all leave a
  // measurable correlation between the two orderings even when individual
  // batches look different each run.
  let sum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const out = shuffle(items);
    // Pearson r between queue index and batch index for this permutation.
    const xs = out.map((c) => indexOf.get(c));
    const mean = (N - 1) / 2;
    let num = 0, dx = 0, dy = 0;
    for (let pos = 0; pos < N; pos++) {
      const a = xs[pos] - mean, b = pos - mean;
      num += a * b; dx += a * a; dy += b * b;
    }
    sum += num / Math.sqrt(dx * dy);
  }
  const meanR = sum / TRIALS;
  // Per-permutation r has sd ≈ 1/√(N−1) ≈ 0.378, so the mean over 20k trials
  // has sd ≈ 0.0027. 0.02 is >7σ from zero.
  assert.ok(Math.abs(meanR) < 0.02, `queue order survives into the batch: mean r = ${meanR.toFixed(4)}`);
});

test("the k-th queued commitment is deposited k-th only by chance", () => {
  // The most direct form of the attack: line the two event streams up and read
  // the pairing straight off. That should succeed at the rate of a coin toss
  // across 8 positions, not reliably.
  let matches = 0;
  for (let t = 0; t < TRIALS; t++) {
    const out = shuffle(items);
    for (let pos = 0; pos < N; pos++) if (indexOf.get(out[pos]) === pos) matches++;
  }
  // Expected fixed points of a random permutation is exactly 1, whatever N is.
  const perTrial = matches / TRIALS;
  assert.ok(perTrial > 0.85 && perTrial < 1.15, `expected ~1 positional match per batch, got ${perTrial.toFixed(3)}`);
});

test("planBatch decorrelates, not just shuffle in isolation", () => {
  // The keeper's actual entry point — the shuffle has to be reached by the code
  // that builds a batch, not merely exist in the module.
  const counts = positionCounts((held) => planBatch({ held, live: N, minBatch: N }));
  let worst = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) worst = Math.max(worst, Math.abs(counts[i][j] - EXPECTED));
  assert.ok(worst < TOLERANCE, `planBatch leaks queue order: worst deviation ${worst.toFixed(0)} (tolerance ${TOLERANCE.toFixed(0)})`);
});

// ── the joint distribution, which is where a rotation hides ─────────────────
//
// Everything above measures MARGINALS — where one item lands, on average. A
// random rotation passes every one of them: positions are uniform, the mean
// correlation is ~0, and it has exactly one fixed point on average, same as a
// uniform permutation. What a rotation preserves is the RELATIONSHIP between
// items, and that is the part that matters here: an attacker who de-anonymises
// one pairing would get every other pairing for free.

test("relative order is destroyed — i precedes j half the time, for every pair", () => {
  const before = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let t = 0; t < TRIALS; t++) {
    const pos = new Array(N);
    shuffle(items).forEach((c, p) => (pos[indexOf.get(c)] = p));
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (pos[i] < pos[j]) before[i][j]++;
  }
  let worst = 0, where = "";
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const p = before[i][j] / TRIALS;
      if (Math.abs(p - 0.5) > worst) { worst = Math.abs(p - 0.5); where = `${i} before ${j} = ${p.toFixed(3)}`; }
    }
  }
  // sd of a proportion over 20k trials is 0.0035, so 0.02 is >5σ.
  assert.ok(worst < 0.02, `queue order partially survives: ${where} (expected ~0.500)`);
});

test("adjacency is destroyed — a commitment's queue-neighbour does not follow it", () => {
  // The sharpest rotation detector: under a rotation the item queued after i is
  // deposited immediately after i almost always, so one recovered pairing
  // unravels the batch.
  let adjacent = 0, opportunities = 0;
  for (let t = 0; t < TRIALS; t++) {
    const out = shuffle(items).map((c) => indexOf.get(c));
    for (let p = 0; p < N - 1; p++) {
      opportunities++;
      if (out[p + 1] === out[p] + 1) adjacent++;
    }
  }
  const rate = adjacent / opportunities;
  // A uniform permutation puts a specific successor next with p = 1/(N−1).
  assert.ok(rate < 0.25, `queue neighbours stay adjacent ${(rate * 100).toFixed(1)}% of the time — order survives`);
  assert.ok(rate > 0.05, `suspiciously low (${rate.toFixed(3)}) — check the measurement, not the shuffle`);
});

test("chunking for the chain ceiling preserves the shuffled order", () => {
  // Paseo caps deposits per transaction, so a sealed batch is split. The split
  // must not re-sort — and equally must not be the place order sneaks back in.
  const batch = shuffle(items);
  const chunks = depositChunks(batch, 2);
  assert.deepEqual(chunks.flat(), batch, "chunking reordered the batch");
  assert.equal(chunks.length, Math.ceil(N / 2));
  for (const c of chunks) assert.ok(c.length <= 2);
});

test("shuffle is a permutation and leaves its input alone", () => {
  // Cheap, but it is what makes the statistics above mean anything: a "shuffle"
  // that dropped or duplicated an entry would also flatten the position counts.
  const input = [...items];
  const out = shuffle(input);
  assert.deepEqual(input, items, "shuffle mutated its argument");
  assert.deepEqual([...out].sort(), [...items].sort(), "not a permutation");
  assert.equal(new Set(out).size, N);
});
