import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
// @ts-ignore — circomlib's generated Poseidon has no types
import { poseidonContract } from "circomlibjs";

// Anonymity-set size, measured (TEST-PLAN B4).
//
// PRIVACY-STATUS says "anonymity is only as large as usage" and "an empty note
// tree is an anonymity set of one". Both are true and neither was asserted
// anywhere — the existing suites prove the batching and note MECHANISMS work,
// which is a different claim. A mechanism can run perfectly and still deliver a
// set of one.
//
// So this counts. Every test here produces a NUMBER and asserts it, including
// the numbers that are uncomfortably small.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const BUCKETS = [PAS(1), PAS(5), PAS(25)];
const MIN_BATCH = 4;
const MIN_DWELL = 60;

describe("anonymity set, measured", () => {
  async function shieldFixture() {
    const [owner, keeper, crediter, ...accounts] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    const verifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();
    const poseidonImpl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2), poseidonContract.createCode(2), owner
    ).deploy();
    const adapter = await (await ethers.getContractFactory("PoseidonT3Adapter"))
      .deploy(await poseidonImpl.getAddress());

    await vault.setAuthorized(crediter.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets(BUCKETS);
    await vault.setShieldKeeper(keeper.address, true);
    await vault.setShieldParams(MIN_BATCH, MIN_DWELL, 3600);
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(verifier.target);

    const payees = accounts.slice(0, 12);
    for (const p of payees) await vault.connect(crediter).credit(p.address, { value: PAS(60) });
    return { vault, pool, owner, keeper, crediter, payees };
  }

  /// The set a ZK spend of `bucket` actually hides in: notes of THAT bucket.
  /// The bucket is a public signal of the spend, so notes of other denominations
  /// do not hide it — counting the whole tree would overstate the set.
  async function zkSetSize(vault: any, bucket: bigint): Promise<number> {
    const logs = await vault.queryFilter(vault.filters.ShieldNoteInserted(null, bucket), 0, "latest");
    return logs.length;
  }

  async function treeSize(vault: any): Promise<number> {
    const logs = await vault.queryFilter(vault.filters.ShieldNoteInserted(), 0, "latest");
    return logs.length;
  }

  const noteFor = (label: string) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(label))) >> 8n;

  // ── the ZK path (phase 3) ─────────────────────────────────────────────────

  it("a lone note has an anonymity set of one", async () => {
    // The uncomfortable number, and the one the docs are honest about. The
    // mechanism is fully working here — it just has nothing to hide among.
    const f = await loadFixture(shieldFixture);
    await f.vault.connect(f.payees[0]).insertShieldNote(BUCKETS[0], noteFor("solo"));

    expect(await zkSetSize(f.vault, BUCKETS[0])).to.equal(1);
    expect(await treeSize(f.vault)).to.equal(1);
  });

  it("the set is the notes of the SAME bucket, not the whole tree", async () => {
    // `bucket` is a public signal of the spend (FareVault.depositShieldNoteZK
    // passes it to the verifier), so a 25 PAS spend is publicly a 25 PAS spend
    // and hides only among other 25 PAS notes. PRIVACY-STATUS's "every unspent
    // note in the tree" overstates this whenever more than one bucket is in use.
    const f = await loadFixture(shieldFixture);
    for (let i = 0; i < 5; i++) await f.vault.connect(f.payees[i]).insertShieldNote(BUCKETS[0], noteFor(`a${i}`));
    for (let i = 0; i < 3; i++) await f.vault.connect(f.payees[i]).insertShieldNote(BUCKETS[1], noteFor(`b${i}`));
    await f.vault.connect(f.payees[0]).insertShieldNote(BUCKETS[2], noteFor("c0"));

    expect(await treeSize(f.vault)).to.equal(9);
    expect(await zkSetSize(f.vault, BUCKETS[0])).to.equal(5);
    expect(await zkSetSize(f.vault, BUCKETS[1])).to.equal(3);
    // The lone 25 PAS note is hidden by nothing, in a tree of nine.
    expect(await zkSetSize(f.vault, BUCKETS[2])).to.equal(1);
    expect(await zkSetSize(f.vault, BUCKETS[2])).to.be.lessThan(await treeSize(f.vault));
  });

  it("filling one bucket does nothing for another", async () => {
    // The practical consequence: heavy 1 PAS traffic does not make a 25 PAS
    // payout any more private. Denominations partition the crowd.
    const f = await loadFixture(shieldFixture);
    await f.vault.connect(f.payees[0]).insertShieldNote(BUCKETS[2], noteFor("rare"));
    const before = await zkSetSize(f.vault, BUCKETS[2]);

    for (let i = 0; i < 10; i++) await f.vault.connect(f.payees[i]).insertShieldNote(BUCKETS[0], noteFor(`fill${i}`));

    expect(await zkSetSize(f.vault, BUCKETS[2])).to.equal(before);
    expect(await zkSetSize(f.vault, BUCKETS[2])).to.equal(1);
    expect(await treeSize(f.vault)).to.equal(11); // …in a tree that grew tenfold
  });

  it("the set only ever grows", async () => {
    // The tree is append-only: a spend burns a nullifier, it does not remove a
    // leaf, so no one's set shrinks because someone else cashed out.
    const f = await loadFixture(shieldFixture);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      await f.vault.connect(f.payees[i]).insertShieldNote(BUCKETS[0], noteFor(`grow${i}`));
      const now = await zkSetSize(f.vault, BUCKETS[0]);
      expect(now).to.be.greaterThan(last);
      last = now;
    }
    expect(last).to.equal(6);
  });

  // ── the batch path (phases 1–2) ───────────────────────────────────────────

  it("the batch set is the seal size, and minBatch is its floor", async () => {
    const f = await loadFixture(shieldFixture);
    for (let i = 0; i < MIN_BATCH; i++) await f.vault.connect(f.payees[i]).queueShieldCredit(BUCKETS[0]);
    await time.increase(MIN_DWELL + 1);

    // Below the floor the chain refuses — the set cannot be smaller than this.
    await expect(f.vault.connect(f.keeper).sealShieldBatch(BUCKETS[0], MIN_BATCH - 1))
      .to.be.revertedWith("batch-too-small");

    await f.vault.connect(f.keeper).sealShieldBatch(BUCKETS[0], MIN_BATCH);
    expect(await f.vault.shieldOwed(BUCKETS[0])).to.equal(MIN_BATCH);
  });

  it("a quiet bucket cannot borrow a busy one's crowd", async () => {
    // Ten tickets exist, but only two are 5 PAS — and a 5 PAS payee waits,
    // because the floor applies per denomination. This is "anonymity is only as
    // large as usage" as a number: 2 < minBatch, so the batch never forms.
    const f = await loadFixture(shieldFixture);
    for (let i = 0; i < 8; i++) await f.vault.connect(f.payees[i]).queueShieldCredit(BUCKETS[0]);
    for (let i = 0; i < 2; i++) await f.vault.connect(f.payees[i]).queueShieldCredit(BUCKETS[1]);
    await time.increase(MIN_DWELL + 1);

    expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(8);
    expect(await f.vault.shieldPending(BUCKETS[1])).to.equal(2);

    // The busy bucket seals fine…
    await f.vault.connect(f.keeper).sealShieldBatch(BUCKETS[0], 8);
    // …and the quiet one still cannot, at any size it could actually fill.
    for (const n of [1, 2, 3]) {
      await expect(
        f.vault.connect(f.keeper).sealShieldBatch(BUCKETS[1], n),
        `bucket 1 should not seal ${n}`
      ).to.be.reverted;
    }
  });

  it("sealing a larger batch buys a larger set — the floor is not the ceiling", async () => {
    // A regression guard on the live-run finding: the per-transaction deposit
    // ceiling must not become the anonymity set. Sealing 8 gives a set of 8
    // even though deposits go out two at a time.
    const f = await loadFixture(shieldFixture);
    for (let i = 0; i < 8; i++) await f.vault.connect(f.payees[i]).queueShieldCredit(BUCKETS[0]);
    await time.increase(MIN_DWELL + 1);

    await f.vault.connect(f.keeper).sealShieldBatch(BUCKETS[0], 8);
    expect(await f.vault.shieldOwed(BUCKETS[0])).to.equal(8);
    expect(Number(await f.vault.shieldOwed(BUCKETS[0]))).to.be.greaterThan(MIN_BATCH);
  });
});
