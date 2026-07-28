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

describe("anonymity set, measured", () => {
  async function shieldFixture() {
    const [owner, crediter, ...accounts] = await ethers.getSigners();
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
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(verifier.target);

    const payees = accounts.slice(0, 12);
    for (const p of payees) await vault.connect(crediter).credit(p.address, { value: PAS(60) });
    return { vault, pool, owner, crediter, payees };
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

  // The batch path (phases 1–2) had three tests here, measuring the seal size as
  // its anonymity set and the per-denomination floor. That path is gone: its set
  // was only ever the seal, and a keeper could substitute its own commitments.
  // What replaced it is measured above — a ZK spend hides among every unspent
  // note of its bucket, with no keeper in the picture at all.
});
