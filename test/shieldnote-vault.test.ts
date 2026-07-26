import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poseidon1, poseidon2 } from "poseidon-lite";
// @ts-ignore — circomlib's generated Poseidon has no types
import { poseidonContract } from "circomlibjs";
import * as snarkjs from "snarkjs";

// Privacy phase 3 end-to-end inside the vault: balance → note → ZK spend → pool.
//
// Everything here uses the REAL circuit and the REAL proving key. That matters:
// a mocked verifier would pass whatever the vault asked it, and the properties
// under test — that spending reveals nothing but a nullifier, and that the
// deposit target cannot be redirected — live entirely in the proof.

const VK = JSON.parse(readFileSync(join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json"), "utf8"));
const WASM = join(__dirname, "..", "circuits", "build", "shieldnote_js", "shieldnote.wasm");
const ZKEY = join(__dirname, "..", "circuits", "build", "shieldnote.zkey");

const PAS = (n: number) => ethers.parseEther(String(n));
const BUCKET = PAS(1);
const DEPTH = 16;

const zeros = (() => {
  const z = [0n];
  for (let i = 1; i <= DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]]));
  return z;
})();

const noteCommitment = (nullifier: bigint, secret: bigint, bucket: bigint) =>
  poseidon2([poseidon2([nullifier, secret]), bucket]);

const randField = () => BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));

/// Mirror of the contract's incremental tree, for building authentication paths
/// the way a client would from `ShieldNoteInserted` events.
class NoteTree {
  leaves: bigint[] = [];
  private memo = new Map<string, bigint>();
  insert(leaf: bigint) { this.leaves.push(leaf); this.memo.clear(); }
  private node(level: number, index: number): bigint {
    // Short-circuit empty subtrees. Without this a depth-16 root walks all
    // 65,536 slots — ~65k Poseidon hashes per call, which reads as "proving is
    // slow" when it is nothing of the sort.
    if (index * 2 ** level >= this.leaves.length) return zeros[level];
    if (level === 0) return this.leaves[index];
    const key = `${level}:${index}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const v = poseidon2([this.node(level - 1, index * 2), this.node(level - 1, index * 2 + 1)]);
    this.memo.set(key, v);
    return v;
  }
  root(): bigint { return this.node(DEPTH, 0); }
  path(index: number): { elements: bigint[]; indices: number[] } {
    const elements: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let lv = 0; lv < DEPTH; lv++) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      elements.push(this.node(lv, sibling));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

async function prove(note: any, tree: NoteTree, index: number, ksCommitment: bigint) {
  const { elements, indices } = tree.path(index);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root: tree.root().toString(),
      nullifierHash: poseidon1([note.nullifier]).toString(),
      bucket: note.bucket.toString(),
      ksCommitment: ksCommitment.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      pathElements: elements.map(String),
      pathIndices: indices,
    },
    WASM,
    ZKEY
  );
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
      [proof.pi_c[0], proof.pi_c[1]],
    ]
  );
  return { encoded, publicSignals };
}

describe("shield notes (privacy phase 3 — ZK authorization)", function () {
  this.timeout(120_000); // real Groth16 proving

  // Not loadFixture: proving is the slow part, and snapshots don't help it.
  async function deploy() {
    const [owner, payee, other, submitter] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    const verifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();

    // circomlib's generated Poseidon, behind the Paseo precompile's ABI.
    const poseidonImpl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2), poseidonContract.createCode(2), owner
    ).deploy();
    const adapter = await (await ethers.getContractFactory("PoseidonT3Adapter"))
      .deploy(await poseidonImpl.getAddress());

    await verifier.setVerifyingKey(VK.alpha1, VK.beta2, VK.gamma2, VK.delta2, VK.IC0, VK.IC1, VK.IC2, VK.IC3, VK.IC4);
    await vault.setAuthorized(owner.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets([BUCKET, PAS(5)]);
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(verifier.target);
    await vault.credit(payee.address, { value: PAS(10) });
    await vault.credit(other.address, { value: PAS(10) });
    return { vault, pool, verifier, adapter, owner, payee, other, submitter };
  }

  /// Insert a fresh note for `who` and mirror it into the local tree.
  async function insertNote(f: any, who: any, tree: NoteTree, bucket = BUCKET) {
    const note = { nullifier: randField(), secret: randField(), bucket };
    const commitment = noteCommitment(note.nullifier, note.secret, bucket);
    await f.vault.connect(who).insertShieldNote(bucket, commitment);
    tree.insert(commitment);
    return { note, commitment, index: tree.leaves.length - 1 };
  }

  it("the vault's tree agrees with the client's, insert for insert", async () => {
    // If these ever diverge, every proof fails with "unknown-root" and the notes
    // are stuck — so this is the load-bearing compatibility check between
    // Solidity Poseidon and poseidon-lite.
    const f = await deploy();
    const tree = new NoteTree();
    expect(await f.vault.noteRoot()).to.equal(tree.root());

    for (let i = 0; i < 4; i++) {
      await insertNote(f, f.payee, tree);
      expect(await f.vault.noteRoot(), `root diverged after insert ${i}`).to.equal(tree.root());
      expect(await f.vault.nextNoteIndex()).to.equal(i + 1);
    }
  });

  it("spends a note into the pool, revealing only a nullifier", async () => {
    const f = await deploy();
    const tree = new NoteTree();
    // Several notes so the spend is genuinely hidden among them.
    const notes = [];
    for (let i = 0; i < 3; i++) notes.push(await insertNote(f, i === 1 ? f.other : f.payee, tree));
    const mine = notes[1];

    const ks = poseidon2([randField(), randField()]); // the payee's pool commitment
    const { encoded, publicSignals } = await prove(mine.note, tree, mine.index, ks);
    const nullifierHash = poseidon1([mine.note.nullifier]);

    // Anyone may submit — the proof binds the destination, so there is nothing
    // to gain by front-running it.
    const tx = await f.vault
      .connect(f.submitter)
      .depositShieldNoteZK(encoded, tree.root(), nullifierHash, BUCKET, ethers.toBeHex(ks, 32));
    const rec = await tx.wait();

    expect(await f.pool.depositCount()).to.equal(1);
    expect(await f.pool.depositedValue(ethers.toBeHex(ks, 32))).to.equal(BUCKET);
    expect(await f.vault.shieldNullifierSpent(nullifierHash)).to.equal(true);
    expect(publicSignals[1]).to.equal(nullifierHash.toString());

    // The spend names no account and no leaf index.
    const blob = (tx.data + rec!.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    for (const who of [f.payee, f.other]) {
      expect(blob, "the spend leaked an account").to.not.include(who.address.slice(2).toLowerCase());
    }
    expect(blob, "the spend leaked the note commitment")
      .to.not.include(mine.commitment.toString(16).padStart(64, "0").toLowerCase());
  });

  it("cannot spend the same note twice", async () => {
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertNote(f, f.payee, tree);
    await insertNote(f, f.other, tree);

    const ks = poseidon2([randField(), 7n]);
    const { encoded } = await prove(mine.note, tree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);
    await f.vault.depositShieldNoteZK(encoded, tree.root(), nh, BUCKET, ethers.toBeHex(ks, 32));

    await expect(
      f.vault.depositShieldNoteZK(encoded, tree.root(), nh, BUCKET, ethers.toBeHex(ks, 32))
    ).to.be.revertedWith("note-spent");
  });

  it("cannot redirect someone else's proof to a different commitment", async () => {
    // The custody risk phase 1 and 2 could only bound, closed here: the deposit
    // target is a public input, so altering it invalidates the proof.
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertNote(f, f.payee, tree);

    const ks = poseidon2([randField(), 9n]);
    const { encoded } = await prove(mine.note, tree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);
    const theirs = poseidon2([randField(), 11n]); // an attacker's own commitment

    await expect(
      f.vault.connect(f.submitter).depositShieldNoteZK(encoded, tree.root(), nh, BUCKET, ethers.toBeHex(theirs, 32))
    ).to.be.revertedWith("bad-proof");
  });

  it("cannot spend a 1 PAS note as a 5 PAS one", async () => {
    // The denomination is bound into the leaf, so claiming a larger bucket
    // breaks the membership proof rather than draining the buffer.
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertNote(f, f.payee, tree);

    const ks = poseidon2([randField(), 13n]);
    const { encoded } = await prove(mine.note, tree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);

    await expect(
      f.vault.depositShieldNoteZK(encoded, tree.root(), nh, PAS(5), ethers.toBeHex(ks, 32))
    ).to.be.revertedWith("bad-proof");
  });

  it("rejects a proof against a root the vault never had", async () => {
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertNote(f, f.payee, tree);

    // Prove against a tree the chain doesn't know (an extra local leaf).
    const forked = new NoteTree();
    forked.leaves = [...tree.leaves, poseidon2([1n, 2n])];
    const ks = poseidon2([randField(), 17n]);
    const { encoded } = await prove(mine.note, forked, mine.index, ks);

    await expect(
      f.vault.depositShieldNoteZK(encoded, forked.root(), poseidon1([mine.note.nullifier]), BUCKET, ethers.toBeHex(ks, 32))
    ).to.be.revertedWith("unknown-root");
  });

  it("still verifies against a root that has since moved on", async () => {
    // Proofs are built off-chain; more notes land while the payee proves. Without
    // a root window every real spend would race and lose.
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertNote(f, f.payee, tree);
    const rootAtProof = tree.root();

    const ks = poseidon2([randField(), 19n]);
    const { encoded } = await prove(mine.note, tree, mine.index, ks);

    for (let i = 0; i < 3; i++) await insertNote(f, f.other, tree); // the tree moves
    expect(await f.vault.noteRoot()).to.not.equal(rootAtProof);

    await f.vault.depositShieldNoteZK(encoded, rootAtProof, poseidon1([mine.note.nullifier]), BUCKET, ethers.toBeHex(ks, 32));
    expect(await f.pool.depositCount()).to.equal(1);
  });

  it("a relay cannot substitute its own note when inserting for a payee", async () => {
    const f = await deploy();
    const note = { nullifier: randField(), secret: randField(), bucket: BUCKET };
    const commitment = noteCommitment(note.nullifier, note.secret, BUCKET);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await f.payee.signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: f.vault.target as string },
      {
        ShieldNote: [
          { name: "account", type: "address" },
          { name: "bucket", type: "uint96" },
          { name: "commitment", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: f.payee.address, bucket: BUCKET, commitment, nonce: 0n, deadline }
    );

    // The signature covers the commitment, so swapping it fails.
    const attacker = noteCommitment(randField(), randField(), BUCKET);
    await expect(
      f.vault.connect(f.submitter).insertShieldNoteFor(f.payee.address, BUCKET, attacker, deadline, sig)
    ).to.be.revertedWith("bad-sig");

    await f.vault.connect(f.submitter).insertShieldNoteFor(f.payee.address, BUCKET, commitment, deadline, sig);
    expect(await f.vault.nextNoteIndex()).to.equal(1);
    expect(await f.vault.balanceOf(f.payee.address)).to.equal(PAS(10) - BUCKET);
  });

  it("is dormant until governance wires the verifier and the hasher", async () => {
    const [owner, payee] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    await vault.setAuthorized(owner.address, true);
    await vault.setShieldBuckets([BUCKET]);
    await vault.credit(payee.address, { value: PAS(2) });

    await expect(vault.connect(payee).insertShieldNote(BUCKET, 123n)).to.be.revertedWith("poseidon-unset");
    await expect(
      vault.depositShieldNoteZK("0x", 1n, 2n, BUCKET, ethers.ZeroHash)
    ).to.be.revertedWith("zk-off");
  });
});
