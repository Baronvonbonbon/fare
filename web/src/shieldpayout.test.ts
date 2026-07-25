import { describe, it, expect } from "vitest";
import { poseidon2 } from "poseidon-lite";
import { batchNotePaths, commitmentOf, makeNote } from "./shieldpool";

// Driver/venue-side shielded payouts (docs/PRIVACY-TIERS.md §4).

// shieldpayout.ts persists pending notes to localStorage and pulls in chain.ts,
// which reads it at import time; vitest runs in node, so stand up the shim
// before importing (same pattern as pool.test.ts).
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const { planShielding } = await import("./shieldpayout");

const PAS = (n: number) => BigInt(n) * 10n ** 18n;
const BUCKETS = [PAS(1), PAS(5), PAS(25)];

describe("planShielding", () => {
  it("shields as much as the standard denominations cover, biggest first", () => {
    expect(planShielding(PAS(31), BUCKETS)).toEqual([PAS(25), PAS(5), PAS(1)]);
    expect(planShielding(PAS(7), BUCKETS)).toEqual([PAS(5), PAS(1), PAS(1)]);
    expect(planShielding(PAS(50), BUCKETS)).toEqual([PAS(25), PAS(25)]);
  });

  it("leaves the remainder unshielded rather than inventing a denomination", () => {
    // A bucket nobody else is using identifies its owner inside the batch, so a
    // 0.3 PAS remainder must stay an ordinary balance.
    const plan = planShielding(PAS(6) + 10n ** 17n * 3n, BUCKETS);
    expect(plan).toEqual([PAS(5), PAS(1)]);
    for (const b of plan) expect(BUCKETS).toContain(b);
  });

  it("shields nothing below the smallest bucket", () => {
    expect(planShielding(10n ** 17n, BUCKETS)).toEqual([]);
    expect(planShielding(0n, BUCKETS)).toEqual([]);
  });
});

describe("claiming a batched payout", () => {
  // Reference LeanIMT (parent = Poseidon(l,r), lone node promotes, root = last
  // inserted) — the construction the pool uses.
  class LeanIMT {
    leaves: bigint[] = []; sn = new Map<number, bigint>(); root = 0n;
    insert(leaf: bigint) {
      const idx = this.leaves.length; let node = leaf;
      for (let lv = 0; lv < 128; lv++) {
        const set = ((BigInt(idx) >> BigInt(lv)) & 1n) === 1n;
        if (set) { const s = this.sn.get(lv) ?? 0n; if (s !== 0n) node = poseidon2([s, node]); }
        else this.sn.set(lv, node);
      }
      this.root = node; this.leaves.push(leaf);
    }
  }

  it("finds the note's own position when the batch leads with foreign leaves", async () => {
    // The keeper's snapshot can go stale: someone else deposits between the read
    // and the batch landing, so the replay list starts with leaves that are not
    // ours. Taking index 0 would silently produce an unspendable note.
    const tree = new LeanIMT();
    for (let i = 0; i < 11; i++) tree.insert(poseidon2([BigInt(i + 1), 4n]));

    const startIndex = tree.leaves.length;
    const preSideNodes: Record<number, string> = {};
    for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (tree.sn.get(lv) ?? 0n).toString();

    const foreign = [poseidon2([99n, 1n]), poseidon2([98n, 1n])]; // slipped in ahead of us
    const ours = makeNote(PAS(5));
    const oursCommit = commitmentOf(ours);
    const replay = [...foreign, oursCommit];

    const paths = batchNotePaths(startIndex, preSideNodes, replay);
    const mine = replay.findIndex((c) => c === oursCommit);
    expect(mine).toBe(2);
    expect(paths[mine].index).toBe(startIndex + 2);

    // And the derived path is the real one: rebuilding from it reproduces the
    // tree's root after all three leaves land.
    for (const leaf of replay) tree.insert(leaf);
    let node = oursCommit;
    const idx = paths[mine].index;
    const rightLeaves = new Map<number, bigint>(replay.map((l, i) => [startIndex + i, l]));
    for (let lv = 0; lv < 128; lv++) {
      const set = ((BigInt(idx) >> BigInt(lv)) & 1n) === 1n;
      if (set) {
        const s = BigInt(paths[mine].leftSnapshot[lv] ?? "0");
        if (s !== 0n) node = poseidon2([s, node]);
      } else {
        // right sibling: the only leaves to our right are later batch members
        const sibStart = ((BigInt(idx) >> BigInt(lv)) + 1n) << BigInt(lv);
        let sib: bigint | null = null;
        for (let k = 0; k < replay.length; k++) {
          const at = BigInt(startIndex + k);
          if (at >= sibStart && at < sibStart + (1n << BigInt(lv))) {
            sib = sib == null ? replay[k] : poseidon2([sib, replay[k]]);
          }
        }
        if (sib != null) node = poseidon2([node, sib]);
      }
    }
    expect(node).toBe(tree.root);
  });
});
