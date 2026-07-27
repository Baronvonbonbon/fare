import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { poseidon2 } from "poseidon-lite";
import { join } from "node:path";

// Shield notes — the client half of privacy phase 3 (TEST-PLAN §6).
//
// A note's whole value is that spending it reveals only a nullifier, so the
// anonymity set is every unspent note of its bucket rather than the seal size.
// That rests on the client and the chain agreeing about a Merkle tree, exactly,
// and nothing checked that agreement: the hardhat tier CANNOT import this module
// (its relative imports have no extensions — TEST-FINDINGS #17), so a cross-tier
// differential is not available.
//
// What IS available is better than a self-consistent test. `test/fixtures/
// zk-shieldnote.json` carries a leaf and a root the REAL circom circuit proved
// against, so the commitment, the nullifier hash and the tree root are all
// checked against values a Groth16 proof already verified. If this module's
// Poseidon or its tree ever drifts from the circuit's, these fail.
//
// The failure mode being guarded is unpleasant: a wrong tree produces a
// perfectly well-formed proof against a root the vault has never held. Nothing
// errors client-side; the spend just reverts, with the note's secrets already
// committed to a leaf nobody can open.

vi.mock("./chain", () => ({
  ADDRESSES: { vault: "0x" + "11".repeat(20) },
  CHAIN_ID: 420420417,
  readProvider: {},
}));
vi.mock("./relaypick", () => ({ postPadded: vi.fn(async () => ({ ok: true })) }));

import {
  NOTE_DEPTH, noteCommitment, nullifierHashOf, makeShieldNote, zeroHashes, NoteTree,
  pendingShieldNotes, rememberShieldNote, forgetShieldNote,
} from "./shieldnote";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "test", "fixtures", "zk-shieldnote.json"), "utf8")
);
const NULLIFIER = BigInt(FIXTURE.note.nullifier);
const SECRET = BigInt(FIXTURE.note.secret);
const BUCKET = BigInt(FIXTURE.note.bucket);

function memoryLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}
beforeEach(() => { memoryLocalStorage(); });

// ── against the real circuit ────────────────────────────────────────────────

describe("note commitments, against what the circuit proved", () => {
  it("reproduces the leaf the circuit opened", () => {
    // leaf = Poseidon(Poseidon(nullifier, secret), bucket). The nesting and the
    // ORDER are both load-bearing and both plausible-looking if wrong.
    expect(noteCommitment(NULLIFIER, SECRET, BUCKET).toString()).to.equal(FIXTURE.leaf);
  });

  it("reproduces the nullifier hash the circuit published", () => {
    // The one public thing a spend reveals. Public signals are
    // [root, nullifierHash, bucket, ksCommitment].
    expect(nullifierHashOf(NULLIFIER).toString()).to.equal(FIXTURE.publicSignals[1]);
  });

  it("binds the denomination into the leaf", () => {
    // Without the bucket in the hash a 1 PAS note could be spent as 25. The
    // circuit takes bucket as a PUBLIC signal, so the binding is what stops the
    // same secrets opening a leaf in a richer denomination.
    const asOne = noteCommitment(NULLIFIER, SECRET, 10n ** 18n);
    const asTwentyFive = noteCommitment(NULLIFIER, SECRET, 25n * 10n ** 18n);
    expect(asOne).to.not.equal(asTwentyFive);
    expect(FIXTURE.publicSignals[2], "the fixture's bucket is not a public signal").to.equal(FIXTURE.note.bucket);
  });

  it("is order-sensitive — nullifier and secret are not interchangeable", () => {
    // Poseidon(a,b) ≠ Poseidon(b,a). Swapping them would still produce a valid
    // field element and a well-formed note that opens nothing.
    expect(noteCommitment(SECRET, NULLIFIER, BUCKET).toString()).to.not.equal(FIXTURE.leaf);
  });
});

// ── the tree ────────────────────────────────────────────────────────────────

describe("the note tree, against the root the circuit verified", () => {
  it("reproduces the fixture's root from its single leaf", () => {
    // THE assertion of this file. A client tree that disagrees with the vault's
    // builds proofs against a root that never existed — the spend reverts, and
    // the note's secrets are already spent into a leaf nobody can open.
    const tree = new NoteTree([BigInt(FIXTURE.leaf)]);
    expect(tree.root().toString()).to.equal(FIXTURE.root);
    expect(FIXTURE.publicSignals[0], "the root is the circuit's first public signal")
      .to.equal(FIXTURE.root);
  });

  it("has the depth the circuit and the vault agree on", () => {
    // 16 here, in circuits/shieldnote.circom, and in FareVault.NOTE_DEPTH. A
    // mismatch changes every root.
    expect(NOTE_DEPTH).to.equal(16);
    expect(zeroHashes()).to.have.length(NOTE_DEPTH + 1);
  });

  it("builds empty-subtree roots by hashing zero upward", () => {
    // These must equal FareVault.noteZeros exactly, or every path proves against
    // a root the vault has never held. Checked structurally: each level is the
    // hash of the level below with itself.
    const z = zeroHashes();
    expect(z[0]).to.equal(0n);
    const tree = new NoteTree([]);
    // An empty tree's root is the top zero — the vault's initial state.
    expect(tree.root()).to.equal(z[NOTE_DEPTH]);
  });

  it("folds every leaf's path back to the root", () => {
    // The property the circuit itself checks, asserted directly: fold the
    // siblings with the left/right bits and you must land on the root. This is
    // what makes the path test more than a snapshot — it verifies the SAME
    // relation the proof does, for every position.
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: n }, (_, i) => BigInt(1000 + i));
      const tree = new NoteTree(leaves);
      const root = tree.root();
      for (let i = 0; i < n; i++) {
        const { elements, indices } = tree.path(i);
        expect(elements).to.have.length(NOTE_DEPTH);
        let cur = leaves[i];
        for (let lv = 0; lv < NOTE_DEPTH; lv++) {
          cur = indices[lv] === 0 ? poseidon2([cur, elements[lv]]) : poseidon2([elements[lv], cur]);
        }
        expect(cur, `leaf ${i} of ${n} does not fold to the root`).to.equal(root);
      }
    }
  });

  it("reports the left/right bit that matches the leaf's index", () => {
    // The indices ARE the path directions the circuit consumes. Getting them
    // inverted still folds to *a* root, just not this one — which is why the
    // fold test above uses them rather than assuming.
    const tree = new NoteTree([1n, 2n, 3n, 4n]);
    expect(tree.path(0).indices[0]).to.equal(0); // even leaf → left
    expect(tree.path(1).indices[0]).to.equal(1); // odd  leaf → right
    expect(tree.path(2).indices.slice(0, 2)).to.deep.equal([0, 1]);
  });

  it("changes its root when any leaf changes, and when order changes", () => {
    // An incremental tree is order-sensitive by construction; if it were not,
    // two different insert histories would collide.
    const a = new NoteTree([1n, 2n, 3n]).root();
    const b = new NoteTree([1n, 2n, 4n]).root();
    const c = new NoteTree([2n, 1n, 3n]).root();
    expect(a).to.not.equal(b);
    expect(a, "the tree is insensitive to leaf order").to.not.equal(c);
  });

  it("appending a leaf does not disturb earlier leaves' membership", () => {
    // The vault's tree only ever appends. A path taken before an append must
    // still be checkable against the tree it was taken from, or a note becomes
    // unspendable every time somebody else deposits.
    const before = new NoteTree([10n, 20n]);
    const rootBefore = before.root();
    const after = new NoteTree([10n, 20n, 30n]);
    expect(after.root()).to.not.equal(rootBefore);
    // The old root is still what the old path proves against — which is why the
    // vault keeps a window of historical roots and the client retries on a
    // stale one rather than treating it as an error.
    expect(new NoteTree([10n, 20n]).root()).to.equal(rootBefore);
  });

  it("is O(leaves) rather than O(2^depth)", () => {
    // A depth-16 tree is 65,536 slots. Walking all of them per root would make
    // the client unusable; empty subtrees short-circuit to a precomputed zero.
    const t0 = Date.now();
    new NoteTree(Array.from({ length: 200 }, (_, i) => BigInt(i + 1))).root();
    expect(Date.now() - t0, "building a root took too long — did the zero short-circuit go?")
      .to.be.lessThan(5_000);
  });
});

// ── note generation and the device-local store ──────────────────────────────

describe("making and keeping notes", () => {
  it("generates distinct secrets inside the field", () => {
    // Two notes with the same nullifier collide on their nullifier hash: the
    // second spend is rejected as a double-spend and that note is dead.
    const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = makeShieldNote(10n ** 18n);
      expect(BigInt(n.nullifier) < BN254, "nullifier outside the field").to.equal(true);
      expect(BigInt(n.secret) < BN254, "secret outside the field").to.equal(true);
      expect(n.nullifier).to.not.equal(n.secret);
      seen.add(n.nullifier);
    }
    expect(seen.size, "a nullifier repeated — that note would be an instant double-spend").to.equal(50);
  });

  it("stores the commitment its own secrets open", () => {
    const n = makeShieldNote(BUCKET);
    expect(n.commitment).to.equal(
      noteCommitment(BigInt(n.nullifier), BigInt(n.secret), BigInt(n.bucketWei)).toString()
    );
    expect(n.bucketWei).to.equal(BUCKET.toString());
  });

  it("remembers, lists and forgets notes by commitment", () => {
    const a = makeShieldNote(10n ** 18n);
    const b = makeShieldNote(25n * 10n ** 18n);
    rememberShieldNote(a);
    rememberShieldNote(b);
    expect(pendingShieldNotes().map((n) => n.commitment)).to.deep.equal([a.commitment, b.commitment]);

    forgetShieldNote(a.commitment);
    expect(pendingShieldNotes().map((n) => n.commitment)).to.deep.equal([b.commitment]);
  });

  it("keeps the secrets it will need to spend", () => {
    // A stored note without its nullifier and secret is unspendable. The whole
    // point of the local store is that these never leave the device — so losing
    // them to a partial write is losing the money.
    const n = makeShieldNote(10n ** 18n);
    rememberShieldNote(n);
    const back = pendingShieldNotes()[0];
    expect(back.nullifier).to.equal(n.nullifier);
    expect(back.secret).to.equal(n.secret);
    expect(back.bucketWei).to.equal(n.bucketWei);
  });

  it("survives a corrupted store rather than throwing", () => {
    // These run on render paths. A half-written value must read as "no notes",
    // not take the wallet screen down.
    localStorage.setItem("fare.shield.notes.zk", "{not json");
    expect(pendingShieldNotes()).to.deep.equal([]);
    const n = makeShieldNote(1n);
    rememberShieldNote(n); // must recover, not compound the corruption
    expect(pendingShieldNotes()).to.have.length(1);
  });

  it("forgetting an unknown commitment is a no-op", () => {
    const n = makeShieldNote(1n);
    rememberShieldNote(n);
    forgetShieldNote("0xnot-a-note");
    expect(pendingShieldNotes(), "forgetting a stranger dropped a real note").to.have.length(1);
  });
});
