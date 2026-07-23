import { describe, it, expect } from "vitest";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { authPath, subtreeRoot, commitmentOf, nullifierHashOf, contextFor } from "./shieldpool";

// Reference LeanIMT128 (parent = Poseidon(l,r); lone node promotes; root = last
// inserted node) — the same construction the pool uses. Used to cross-check the
// snapshot+right-scan reconstruction against a full-tree proof.
const bit = (n: number, lv: number) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;
class LeanIMT {
  leaves: bigint[] = []; _sn = new Map<number, bigint>(); root = 0n;
  insert(leaf: bigint) {
    const idx = this.leaves.length; let node = leaf;
    for (let lv = 0; lv < 128; lv++) {
      if (bit(idx, lv)) { const s = this._sn.get(lv) ?? 0n; if (s !== 0n) node = poseidon2([s, node]); }
      else this._sn.set(lv, node);
    }
    this.root = node; this.leaves.push(leaf);
  }
  // Full-tree authentication path for a leaf (siblings as decimal strings, "0" = none).
  proof(leafIndex: number): string[] {
    let layer = [...this.leaves], idx = leafIndex; const sibs: string[] = [];
    for (let lv = 0; lv < 128; lv++) {
      const si = idx % 2 === 0 ? idx + 1 : idx - 1;
      sibs.push(si >= 0 && si < layer.length ? layer[si].toString() : "0");
      const nxt: bigint[] = [];
      for (let i = 0; i < layer.length; i += 2) nxt.push(i + 1 < layer.length ? poseidon2([layer[i], layer[i + 1]]) : layer[i]);
      layer = nxt; idx = Math.floor(idx / 2);
    }
    return sibs;
  }
}
const rootFrom = (leaf: bigint, index: number, sibs: string[]) => {
  let node = leaf;
  for (let lv = 0; lv < 128; lv++) { const s = BigInt(sibs[lv]); if (s === 0n) continue; node = bit(index, lv) ? poseidon2([s, node]) : poseidon2([node, s]); }
  return node;
};

describe("shieldpool commitment scheme", () => {
  it("commitment and nullifier hash are deterministic and match the KS layout", () => {
    const note = { nullifier: "123456789", secret: "987654321", value: "500000000000000000" };
    // commitment = Poseidon(Poseidon(value,0), Poseidon(nullifier,secret))
    const expected = poseidon2([poseidon2([500000000000000000n, 0n]), poseidon2([123456789n, 987654321n])]);
    expect(commitmentOf(note)).toBe(expected);
    expect(nullifierHashOf(note)).toBe(poseidon1([123456789n])); // = Poseidon(nullifier)
    expect(contextFor("0x0000000000000000000000000000000000000000")).toBeTypeOf("bigint");
  });
});

describe("snapshot + right-scan reconstruction (KS Issue-1 workaround)", () => {
  // For several tree sizes and target leaves, the reconstructed path must equal
  // the full-tree proof and reproduce the root — using only the leaf's left
  // snapshot (bit-set siblings) + the leaves to its right.
  for (const N of [1, 2, 5, 8, 13, 21, 34]) {
    it(`rebuilds interior-leaf paths for a tree of ${N} leaves`, () => {
      const tree = new LeanIMT();
      const vals: bigint[] = [];
      for (let i = 0; i < N; i++) { const v = poseidon2([BigInt(i + 1), 7n]); vals.push(v); tree.insert(v); }
      for (const i of [0, Math.floor(N / 2), N - 1].filter((x, k, a) => x >= 0 && a.indexOf(x) === k)) {
        const full = tree.proof(i);
        // left snapshot = the bit-set-level siblings of the full path (immutable left path)
        const leftSnapshot: Record<number, string> = {};
        for (let lv = 0; lv < 128; lv++) if (bit(i, lv)) leftSnapshot[lv] = full[lv];
        // right leaves = everything from i onward
        const right = new Map<number, bigint>();
        for (let j = i; j < N; j++) right.set(j, vals[j]);
        const rebuilt = authPath(i, leftSnapshot, right, N - 1);
        expect(rebuilt).toEqual(full);
        expect(rootFrom(vals[i], i, rebuilt)).toBe(tree.root);
      }
    });
  }

  it("subtreeRoot short-circuits empty ranges past the last leaf (no exponential blowup)", () => {
    const leaves = new Map<number, bigint>([[5, 99n]]);
    // A high-level range whose start is far beyond maxIdx must return null instantly.
    expect(subtreeRoot(leaves, 100, (1n << 100n), 5)).toBeNull();
    expect(subtreeRoot(leaves, 0, 5n, 5)).toBe(99n);
    expect(subtreeRoot(leaves, 0, 6n, 5)).toBeNull();
  });
});
