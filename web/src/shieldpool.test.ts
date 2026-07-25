import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { authPath, subtreeRoot, commitmentOf, nullifierHashOf, contextFor, loadZkey, batchNotePaths } from "./shieldpool";

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

// The 34 MB proving key ships as parts because Cloudflare Pages rejects any
// single asset over 25 MiB. Exercise the reassembly against the REAL published
// parts — a stale manifest or a part that never got regenerated would otherwise
// only show up as an unexplainable invalid proof in production.
describe("withdraw zkey reassembly", () => {
  const shieldDir = new URL("../public/shield/", import.meta.url);
  const serveLocally = () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const file = new URL(url.replace(/^\/shield\//, ""), shieldDir);
      const body = await readFile(file);
      return new Response(body, { status: 200 });
    });
  };

  it("rebuilds the key from its parts and matches the manifest digest", async () => {
    serveLocally();
    const key = await loadZkey();
    const manifest = JSON.parse(await readFile(new URL("withdraw_v7.zkey.json", shieldDir), "utf8"));
    expect(key.length).toBe(manifest.bytes);
    expect(createHash("sha256").update(key).digest("hex")).toBe(manifest.sha256);
    // .zkey magic header ("zkey" + version), i.e. snarkjs will accept these bytes.
    expect(new TextDecoder().decode(key.subarray(0, 4))).toBe("zkey");
    vi.unstubAllGlobals();
  });
});

// Batched vault payouts (docs/PRIVACY-TIERS.md §4): the recipient of a batched
// deposit never gets to snapshot sideNodes at insertion time, so they replay the
// batch locally from the PRE-batch tree state. Cross-checked against the same
// reference LeanIMT the snapshot path is checked against — if the replay were
// wrong, the note would be unspendable (a wrong path proves nothing).
describe("batched deposit paths", () => {
  it("derives every batch member's left path from pre-batch state alone", () => {
    for (const preexisting of [0, 1, 5, 8, 23]) {
      const tree = new LeanIMT();
      for (let i = 0; i < preexisting; i++) tree.insert(poseidon2([BigInt(i + 1), 3n]));

      // The keeper's snapshot: sideNodes as they stand just before the batch.
      const preSideNodes: Record<number, string> = {};
      for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (tree._sn.get(lv) ?? 0n).toString();

      const batch = Array.from({ length: 8 }, (_, k) => poseidon2([BigInt(1000 + k), 9n]));
      const derived = batchNotePaths(preexisting, preSideNodes, batch);
      for (const leaf of batch) tree.insert(leaf);

      // Each derived path must reproduce the live root, which is the only test
      // that matters: it is exactly what the pool's verifier checks.
      derived.forEach((d, k) => {
        expect(d.index).toBe(preexisting + k);
        const full = tree.proof(d.index);
        for (let lv = 0; lv < 128; lv++) {
          if (bit(d.index, lv)) expect(d.leftSnapshot[lv] ?? "0").toBe(full[lv]);
        }
        const rebuilt = authPath(d.index, d.leftSnapshot, new Map(batch.map((l, i) => [preexisting + i, l])), preexisting + batch.length - 1);
        expect(rootFrom(batch[k], d.index, rebuilt)).toBe(tree.root);
      });
    }
  });
});
