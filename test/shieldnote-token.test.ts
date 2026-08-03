import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poseidon1, poseidon2 } from "poseidon-lite";
// @ts-ignore — circomlib's generated Poseidon has no types
import { poseidonContract } from "circomlibjs";
import * as snarkjs from "snarkjs";

// The stablecoin half of privacy phase 3: a USDC payout becomes a note and is
// spent into the shielded pool, with nothing but a nullifier revealed.
//
// The circuit is UNCHANGED — its public signals are still
// [root, nullifierHash, bucket, ksCommitment], with no asset among them. What
// binds a note to its asset is that each asset gets its OWN tree, so `root`
// carries the asset implicitly. The tests that matter here are the ones that
// try to cross that boundary; everything else is the native path again in a
// different denomination.

const VK = JSON.parse(readFileSync(join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json"), "utf8"));
const WASM = join(__dirname, "..", "circuits", "build", "shieldnote_js", "shieldnote.wasm");
const ZKEY = join(__dirname, "..", "circuits", "build", "shieldnote.zkey");

const PAS = (n: number) => ethers.parseEther(String(n));
const USDC = (n: number) => BigInt(Math.round(n * 1e6)); // 6dp, like the real asset
const ASSET_ID = 1337n; // Asset Hub USDC
const RUNG = USDC(1);
const DEPTH = 16;

const zeros = (() => {
  const z = [0n];
  for (let i = 1; i <= DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]]));
  return z;
})();

const noteCommitment = (nullifier: bigint, secret: bigint, bucket: bigint) =>
  poseidon2([poseidon2([nullifier, secret]), bucket]);

const randField = () => BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));

class NoteTree {
  leaves: bigint[] = [];
  private memo = new Map<string, bigint>();
  insert(leaf: bigint) { this.leaves.push(leaf); this.memo.clear(); }
  private node(level: number, index: number): bigint {
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
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

async function prove(note: any, tree: NoteTree, index: number, ksCommitment: bigint) {
  const { elements, indices } = tree.path(index);
  const { proof } = await snarkjs.groth16.fullProve(
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
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
      [proof.pi_c[0], proof.pi_c[1]],
    ]
  );
}

describe("shield notes — stablecoin payouts", function () {
  this.timeout(120_000); // real Groth16 proving

  async function deploy() {
    const [owner, payee, other, submitter] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    const verifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();

    const poseidonImpl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2), poseidonContract.createCode(2), owner
    ).deploy();
    const adapter = await (await ethers.getContractFactory("PoseidonT3Adapter"))
      .deploy(await poseidonImpl.getAddress());

    await verifier.setVerifyingKey(VK.alpha1, VK.beta2, VK.gamma2, VK.delta2, VK.IC0, VK.IC1, VK.IC2, VK.IC3, VK.IC4);
    await vault.setAuthorized(owner.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets([PAS(1), PAS(5)]);
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(verifier.target);
    // The token half of governance: a ladder and an asset id, both required.
    await vault.setShieldBucketsToken(usdc.target, [USDC(0.5), RUNG, USDC(5), USDC(25)]);
    await vault.setShieldAssetId(usdc.target, ASSET_ID);
    await pool.setAssetToken(ASSET_ID, usdc.target);

    // Settle some USDC earnings the way FareOrders would.
    await usdc.mint(owner.address, USDC(1000));
    await usdc.approve(vault.target, USDC(1000));
    await vault.creditToken(usdc.target, payee.address, USDC(40));
    await vault.creditToken(usdc.target, other.address, USDC(40));
    await vault.credit(payee.address, { value: PAS(10) });

    return { vault, pool, verifier, usdc, owner, payee, other, submitter };
  }

  async function insertToken(f: any, who: any, tree: NoteTree, bucket = RUNG) {
    const note = { nullifier: randField(), secret: randField(), bucket };
    const commitment = noteCommitment(note.nullifier, note.secret, bucket);
    await f.vault.connect(who).insertShieldNoteToken(f.usdc.target, bucket, commitment);
    tree.insert(commitment);
    return { note, commitment, index: tree.leaves.length - 1 };
  }

  async function insertNative(f: any, who: any, tree: NoteTree, bucket = PAS(1)) {
    const note = { nullifier: randField(), secret: randField(), bucket };
    const commitment = noteCommitment(note.nullifier, note.secret, bucket);
    await f.vault.connect(who).insertShieldNote(bucket, commitment);
    tree.insert(commitment);
    return { note, commitment, index: tree.leaves.length - 1 };
  }

  it("a USDC payout becomes a note and lands in the pool as the asset id", async () => {
    const f = await deploy();
    const tree = new NoteTree();
    const notes = [];
    for (let i = 0; i < 3; i++) notes.push(await insertToken(f, i === 1 ? f.other : f.payee, tree));
    const mine = notes[1];

    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.other.address)).to.equal(USDC(40) - RUNG);
    expect(await f.vault.shieldBufferOf(f.usdc.target)).to.equal(RUNG * 3n);
    expect(await f.vault.shieldBuffer(), "the native buffer must not move").to.equal(0n);

    const ks = poseidon2([randField(), randField()]);
    const encoded = await prove(mine.note, tree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);

    const tx = await f.vault.connect(f.submitter).depositShieldNoteTokenZK(
      encoded, tree.root(), nh, f.usdc.target, RUNG, ethers.toBeHex(ks, 32)
    );
    const rec = await tx.wait();

    expect(await f.pool.depositedValue(ethers.toBeHex(ks, 32))).to.equal(RUNG);
    // The trap worth pinning: the CALL carries the asset id, not the address.
    expect(await f.pool.depositedAssetId(ethers.toBeHex(ks, 32))).to.equal(ASSET_ID);
    expect(await f.usdc.balanceOf(f.pool.target)).to.equal(RUNG);
    expect(await f.vault.nullifierSpentOf(f.usdc.target, nh)).to.equal(true);
    expect(await f.vault.shieldBufferOf(f.usdc.target)).to.equal(RUNG * 2n);

    const blob = (tx.data + rec!.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
    for (const who of [f.payee, f.other]) {
      expect(blob, "the spend leaked an account").to.not.include(who.address.slice(2).toLowerCase());
    }
    expect(blob, "the spend leaked the note commitment")
      .to.not.include(mine.commitment.toString(16).padStart(64, "0").toLowerCase());
  });

  it("a USDC note cannot be spent against the native buffer", async () => {
    // THE property the whole per-tree design exists for. The circuit has no
    // asset signal, so if both assets shared a tree this proof would verify and
    // 1 USDC of note would draw 1 PAS out of the native buffer.
    const f = await deploy();
    const usdcTree = new NoteTree();
    const mine = await insertToken(f, f.payee, usdcTree);
    // Give the native buffer something to steal, so the failure is the binding
    // and not an empty-buffer underflow.
    const nativeTree = new NoteTree();
    await insertNative(f, f.payee, nativeTree, PAS(1));

    const ks = poseidon2([randField(), 23n]);
    const encoded = await prove(mine.note, usdcTree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);

    await expect(
      f.vault.depositShieldNoteZK(encoded, usdcTree.root(), nh, RUNG, ethers.toBeHex(ks, 32))
    ).to.be.revertedWith("unknown-root");
  });

  it("a native note cannot be spent against a token buffer", async () => {
    const f = await deploy();
    const nativeTree = new NoteTree();
    const mine = await insertNative(f, f.payee, nativeTree, PAS(1));
    const usdcTree = new NoteTree();
    await insertToken(f, f.payee, usdcTree, USDC(25));

    const ks = poseidon2([randField(), 29n]);
    const encoded = await prove(mine.note, nativeTree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);

    await expect(
      f.vault.depositShieldNoteTokenZK(
        encoded, nativeTree.root(), nh, f.usdc.target, PAS(1), ethers.toBeHex(ks, 32)
      )
    ).to.be.revertedWith("unknown-root");
  });

  it("keeps a separate nullifier set per asset, so the trees never collide", async () => {
    const f = await deploy();
    const tree = new NoteTree();
    const mine = await insertToken(f, f.payee, tree);
    await insertToken(f, f.other, tree);

    const ks = poseidon2([randField(), 31n]);
    const encoded = await prove(mine.note, tree, mine.index, ks);
    const nh = poseidon1([mine.note.nullifier]);

    await f.vault.depositShieldNoteTokenZK(encoded, tree.root(), nh, f.usdc.target, RUNG, ethers.toBeHex(ks, 32));
    await expect(
      f.vault.depositShieldNoteTokenZK(encoded, tree.root(), nh, f.usdc.target, RUNG, ethers.toBeHex(ks, 32))
    ).to.be.revertedWith("note-spent");
    // The same nullifier is untouched on the native side — separate mappings.
    expect(await f.vault.shieldNullifierSpent(nh)).to.equal(false);
  });

  it("the two trees advance independently", async () => {
    const f = await deploy();
    const usdcTree = new NoteTree();
    const nativeTree = new NoteTree();

    await insertToken(f, f.payee, usdcTree);
    expect(await f.vault.noteIndexOf(f.usdc.target)).to.equal(1);
    expect(await f.vault.nextNoteIndex(), "the native tree must not move").to.equal(0);
    expect(await f.vault.noteRootOf(f.usdc.target)).to.equal(usdcTree.root());
    expect(await f.vault.noteRoot()).to.equal(nativeTree.root());

    await insertNative(f, f.payee, nativeTree);
    await insertToken(f, f.other, usdcTree);
    expect(await f.vault.noteRootOf(f.usdc.target)).to.equal(usdcTree.root());
    expect(await f.vault.noteRoot()).to.equal(nativeTree.root());
    expect(await f.vault.noteIndexOf(f.usdc.target)).to.equal(2);
    expect(await f.vault.nextNoteIndex()).to.equal(1);
  });

  it("rejects a rung that is not on the token's ladder", async () => {
    const f = await deploy();
    const c = noteCommitment(randField(), randField(), USDC(3));
    await expect(
      f.vault.connect(f.payee).insertShieldNoteToken(f.usdc.target, USDC(3), c)
    ).to.be.revertedWith("bad-bucket");
  });

  it("the token ladder is independent of the native one", async () => {
    // A 1 PAS rung is not a USDC rung, and vice versa — they are different
    // magnitudes in different decimals and sharing a list would be nonsense.
    const f = await deploy();
    const c = noteCommitment(randField(), randField(), PAS(1));
    await expect(
      f.vault.connect(f.payee).insertShieldNoteToken(f.usdc.target, PAS(1), c)
    ).to.be.revertedWith("bad-bucket");
    const c2 = noteCommitment(randField(), randField(), RUNG);
    await expect(f.vault.connect(f.payee).insertShieldNote(RUNG, c2)).to.be.revertedWith("bad-bucket");
  });

  it("accepts a half-unit rung the native Paseo check would reject", async () => {
    // 0.5 USDC is 500_000, which fails `% 10**6 < 500_000`. That check guards the
    // eth-rpc denomination bug on native `msg.value`; an ERC-20 transfer never
    // goes near it, so applying it to tokens would ban a legitimate rung.
    const f = await deploy();
    const c = noteCommitment(randField(), randField(), USDC(0.5));
    await f.vault.connect(f.payee).insertShieldNoteToken(f.usdc.target, USDC(0.5), c);
    expect(await f.vault.shieldBufferOf(f.usdc.target)).to.equal(USDC(0.5));

    const bad = [USDC(0.5)] as any;
    await expect(f.vault.setShieldBuckets(bad)).to.be.revertedWith("bucket-unsendable");
  });

  it("cannot shield more than the payee actually earned", async () => {
    const f = await deploy();
    const [, , , , stranger] = await ethers.getSigners();
    const c = noteCommitment(randField(), randField(), RUNG);
    await expect(
      f.vault.connect(stranger).insertShieldNoteToken(f.usdc.target, RUNG, c)
    ).to.be.revertedWith("insufficient-balance");
  });

  it("a relay cannot substitute its own note, and a native signature will not do", async () => {
    const f = await deploy();
    const note = { nullifier: randField(), secret: randField(), bucket: RUNG };
    const commitment = noteCommitment(note.nullifier, note.secret, RUNG);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "FareVault", version: "1", chainId, verifyingContract: f.vault.target as string };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const TOKEN_TYPES = {
      ShieldNoteToken: [
        { name: "token", type: "address" },
        { name: "account", type: "address" },
        { name: "bucket", type: "uint96" },
        { name: "commitment", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const value = {
      token: f.usdc.target, account: f.payee.address, bucket: RUNG, commitment, nonce: 0n, deadline,
    };
    const sig = await f.payee.signTypedData(domain, TOKEN_TYPES, value);

    const attacker = noteCommitment(randField(), randField(), RUNG);
    await expect(
      f.vault.connect(f.submitter)
        .insertShieldNoteTokenFor(f.usdc.target, f.payee.address, RUNG, attacker, deadline, sig)
    ).to.be.revertedWith("bad-sig");

    // A signature over the NATIVE ShieldNote struct must not authorize a token
    // insert — that is what the distinct typehash buys.
    const nativeSig = await f.payee.signTypedData(
      domain,
      {
        ShieldNote: [
          { name: "account", type: "address" }, { name: "bucket", type: "uint96" },
          { name: "commitment", type: "uint256" }, { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: f.payee.address, bucket: RUNG, commitment, nonce: 0n, deadline }
    );
    await expect(
      f.vault.connect(f.submitter)
        .insertShieldNoteTokenFor(f.usdc.target, f.payee.address, RUNG, commitment, deadline, nativeSig)
    ).to.be.revertedWith("bad-sig");

    await f.vault.connect(f.submitter)
      .insertShieldNoteTokenFor(f.usdc.target, f.payee.address, RUNG, commitment, deadline, sig);
    expect(await f.vault.noteIndexOf(f.usdc.target)).to.equal(1);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.payee.address)).to.equal(USDC(40) - RUNG);
  });

  it("refuses to spend a token with no asset id bound", async () => {
    // Without the id the vault would have to guess what to pass depositAsset,
    // and a wrong guess is unrecoverable value.
    const f = await deploy();
    const other = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await f.vault.setShieldBucketsToken(other.target, [RUNG]);
    await expect(
      f.vault.depositShieldNoteTokenZK("0x", 1n, 2n, other.target, RUNG, ethers.ZeroHash)
    ).to.be.revertedWith("asset-unset");
  });

  it("withdrawForToken pays a payee with no gas, and keeps the relay's fee in the ledger", async () => {
    const f = await deploy();
    await f.vault.setWithdrawFeeBps(100); // 1%
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await f.payee.signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: f.vault.target as string },
      {
        WithdrawToken: [
          { name: "token", type: "address" }, { name: "account", type: "address" },
          { name: "recipient", type: "address" }, { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { token: f.usdc.target, account: f.payee.address, recipient: f.payee.address, nonce: 0n, deadline }
    );

    await f.vault.connect(f.submitter)
      .withdrawForToken(f.usdc.target, f.payee.address, f.payee.address, deadline, sig);

    const fee = USDC(40) / 100n;
    expect(await f.usdc.balanceOf(f.payee.address)).to.equal(USDC(40) - fee);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.submitter.address)).to.equal(fee);
    expect(await f.vault.tokenBalanceOf(f.usdc.target, f.payee.address)).to.equal(0);
  });

  it("is dormant until governance sets a token ladder", async () => {
    const [owner, payee] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await vault.setAuthorized(owner.address, true);
    await usdc.mint(owner.address, USDC(10));
    await usdc.approve(vault.target, USDC(10));
    await vault.creditToken(usdc.target, payee.address, USDC(10));

    await expect(
      vault.connect(payee).insertShieldNoteToken(usdc.target, RUNG, 123n)
    ).to.be.revertedWith("poseidon-unset");
    // And the ladder cannot be set before the hasher, because the tree it warms
    // is derived from it.
    await expect(vault.setShieldBucketsToken(usdc.target, [RUNG])).to.be.revertedWith("poseidon-unset");
  });
});
