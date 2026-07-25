import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Privacy phase 1 — batched shielded payouts (docs/PRIVACY-TIERS.md §4).
//
// Drivers and venues are paid at persistent addresses, so `Withdrawn` publishes
// a permanent revenue graph. The fix is NOT a one-transaction
// withdrawToShield(commitment) — that emits the account and the pool commitment
// in the same receipt, so the note is attributable before it is ever spent
// (§3). Instead a payout is split into two transactions sharing no identity:
// queue a fixed bucket (names the account, no commitment), then a keeper
// deposits N commitments in one batch (names N commitments, no account).
//
// The tests that matter most are the invariant ones at the bottom: they assert
// the two halves stay disjoint, which is the entire privacy argument.

const PAS = (n: number) => ethers.parseEther(String(n));
const BUCKETS = [PAS(1), PAS(5), PAS(25)]; // governance defaults
const MIN_BATCH = 8;
const MIN_DWELL = 5 * 60;
const RECLAIM_AFTER = 24 * 60 * 60;

async function signShieldCredit(
  vault: any,
  signer: HardhatEthersSigner,
  account: string,
  bucket: bigint,
  nonce: bigint,
  deadline: bigint
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return signer.signTypedData(
    { name: "FareVault", version: "1", chainId, verifyingContract: vault.target as string },
    {
      ShieldCredit: [
        { name: "account", type: "address" },
        { name: "bucket", type: "uint96" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { account, bucket, nonce, deadline }
  );
}

const commitmentFor = (label: string) => ethers.keccak256(ethers.toUtf8Bytes(label));

describe("shielded payouts (batched vault → pool)", () => {
  async function fixture() {
    const [owner, keeper, crediter, ...accounts] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();

    // `crediter` stands in for FareOrders: the only way value enters the vault.
    await vault.setAuthorized(crediter.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets(BUCKETS);
    await vault.setShieldKeeper(keeper.address, true);

    // Fund enough accounts to fill a batch with room to spare.
    const drivers = accounts.slice(0, 12);
    for (const d of drivers) {
      await vault.connect(crediter).credit(d.address, { value: PAS(30) });
    }
    return { vault, pool, owner, keeper, crediter, drivers };
  }

  /// Queue `n` one-PAS tickets from distinct drivers and age them past dwell.
  async function queueAndAge(f: any, n: number, bucket = BUCKETS[0]) {
    for (let i = 0; i < n; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(bucket);
    await time.increase(MIN_DWELL + 1);
  }

  describe("queueing", () => {
    it("moves a bucket out of the balance and into the shared buffer", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      await expect(f.vault.connect(d).queueShieldCredit(BUCKETS[0]))
        .to.emit(f.vault, "ShieldQueued")
        .withArgs(d.address, BUCKETS[0], 0);

      expect(await f.vault.balanceOf(d.address)).to.equal(PAS(30) - BUCKETS[0]);
      expect(await f.vault.shieldBuffer()).to.equal(BUCKETS[0]);
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(1);
    });

    it("rejects a denomination outside the governance-set buckets", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.vault.connect(f.drivers[0]).queueShieldCredit(PAS(3))
      ).to.be.revertedWith("bad-bucket");
    });

    it("rejects queueing more than the balance covers", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      await f.vault.connect(d).queueShieldCredit(BUCKETS[2]); // 25 of 30
      await expect(
        f.vault.connect(d).queueShieldCredit(BUCKETS[2])
      ).to.be.revertedWith("insufficient-balance");
    });

    it("is off until governance points at a pool", async () => {
      const f = await loadFixture(fixture);
      await f.vault.setShieldPool(ethers.ZeroAddress);
      await expect(
        f.vault.connect(f.drivers[0]).queueShieldCredit(BUCKETS[0])
      ).to.be.revertedWith("shield-off");
    });

    it("lets a relay queue on a gasless driver's behalf, once per nonce", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      const deadline = BigInt(await time.latest()) + 3600n;
      const sig = await signShieldCredit(f.vault, d, d.address, BUCKETS[0], 0n, deadline);

      await expect(f.vault.connect(f.keeper).queueShieldCreditFor(d.address, BUCKETS[0], deadline, sig))
        .to.emit(f.vault, "ShieldQueued")
        .withArgs(d.address, BUCKETS[0], 0);
      expect(await f.vault.shieldNonce(d.address)).to.equal(1);

      // Replay of the same authorization must fail on the advanced nonce.
      await expect(
        f.vault.connect(f.keeper).queueShieldCreditFor(d.address, BUCKETS[0], deadline, sig)
      ).to.be.revertedWith("bad-sig");
    });

    it("rejects an authorization signed by anyone but the account", async () => {
      const f = await loadFixture(fixture);
      const [d, other] = f.drivers;
      const deadline = BigInt(await time.latest()) + 3600n;
      const sig = await signShieldCredit(f.vault, other, d.address, BUCKETS[0], 0n, deadline);
      await expect(
        f.vault.connect(f.keeper).queueShieldCreditFor(d.address, BUCKETS[0], deadline, sig)
      ).to.be.revertedWith("bad-sig");
    });

    it("rejects an expired authorization", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      const deadline = BigInt(await time.latest()) + 60n;
      const sig = await signShieldCredit(f.vault, d, d.address, BUCKETS[0], 0n, deadline);
      await time.increase(120);
      await expect(
        f.vault.connect(f.keeper).queueShieldCreditFor(d.address, BUCKETS[0], deadline, sig)
      ).to.be.revertedWith("expired");
    });

    it("queueing does not disturb a pending withdrawal authorization", async () => {
      // Separate nonce spaces: shielding some earnings must not silently
      // invalidate a withdrawFor signature the driver already handed a relay.
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      const deadline = BigInt(await time.latest()) + 3600n;
      const sig = await signShieldCredit(f.vault, d, d.address, BUCKETS[0], 0n, deadline);
      await f.vault.connect(f.keeper).queueShieldCreditFor(d.address, BUCKETS[0], deadline, sig);
      expect(await f.vault.shieldNonce(d.address)).to.equal(1);
      expect(await f.vault.withdrawNonce(d.address)).to.equal(0);
    });
  });

  describe("batch execution", () => {
    it("deposits every commitment and drains exactly the batch value", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`note-${i}`));

      await expect(f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments))
        .to.emit(f.vault, "ShieldBatchExecuted")
        .withArgs(f.keeper.address, BUCKETS[0], MIN_BATCH, 0);

      expect(await f.pool.depositCount()).to.equal(MIN_BATCH);
      for (const c of commitments) expect(await f.pool.depositedValue(c)).to.equal(BUCKETS[0]);
      expect(await ethers.provider.getBalance(f.pool.target)).to.equal(BUCKETS[0] * BigInt(MIN_BATCH));
      expect(await f.vault.shieldBuffer()).to.equal(0);
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(0);
    });

    it("refuses a batch small enough to be linkable", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH - 1 }, (_, i) => commitmentFor(`n${i}`));
      await expect(
        f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments)
      ).to.be.revertedWith("batch-too-small");
    });

    it("refuses to deposit more commitments than there are tickets", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH + 1 }, (_, i) => commitmentFor(`n${i}`));
      await expect(
        f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments)
      ).to.be.revertedWith("not-enough-tickets");
    });

    it("refuses to batch a ticket that has not aged (timing would re-link it)", async () => {
      const f = await loadFixture(fixture);
      for (let i = 0; i < MIN_BATCH; i++) {
        await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[0]);
      }
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`n${i}`));
      await expect(
        f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments)
      ).to.be.revertedWith("dwell-not-met");
    });

    it("only an authorized keeper can execute", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`n${i}`));
      await expect(
        f.vault.connect(f.drivers[0]).executeShieldBatch(BUCKETS[0], commitments)
      ).to.be.revertedWith("not-keeper");
    });

    it("keeps buckets independent — tickets in one never fund another", async () => {
      const f = await loadFixture(fixture);
      for (let i = 0; i < MIN_BATCH; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[0]);
      for (let i = 0; i < 2; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[1]);
      await time.increase(MIN_DWELL + 1);

      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`five-${i}`));
      await expect(
        f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[1], commitments)
      ).to.be.revertedWith("not-enough-tickets");

      // The 1-PAS queue is untouched by the failed 5-PAS attempt.
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(MIN_BATCH);
      expect(await f.vault.shieldPending(BUCKETS[1])).to.equal(2);
    });
  });

  describe("reclaim (keeper stall)", () => {
    it("cannot be reclaimed before the window", async () => {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.drivers[0]).queueShieldCredit(BUCKETS[0]);
      await time.increase(MIN_DWELL + 1);
      await expect(
        f.vault.connect(f.drivers[0]).reclaimShieldTicket(BUCKETS[0], 0)
      ).to.be.revertedWith("too-early");
    });

    it("returns the value as a normal balance once the window passes", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      await f.vault.connect(d).queueShieldCredit(BUCKETS[0]);
      await time.increase(RECLAIM_AFTER + 1);

      await expect(f.vault.connect(d).reclaimShieldTicket(BUCKETS[0], 0))
        .to.emit(f.vault, "ShieldReclaimed")
        .withArgs(d.address, BUCKETS[0], 0);
      expect(await f.vault.balanceOf(d.address)).to.equal(PAS(30));
      expect(await f.vault.shieldBuffer()).to.equal(0);
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(0);
    });

    it("only the ticket's owner can reclaim it", async () => {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.drivers[0]).queueShieldCredit(BUCKETS[0]);
      await time.increase(RECLAIM_AFTER + 1);
      await expect(
        f.vault.connect(f.drivers[1]).reclaimShieldTicket(BUCKETS[0], 0)
      ).to.be.revertedWith("not-owner");
    });

    it("cannot double-reclaim", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      await f.vault.connect(d).queueShieldCredit(BUCKETS[0]);
      await time.increase(RECLAIM_AFTER + 1);
      await f.vault.connect(d).reclaimShieldTicket(BUCKETS[0], 0);
      await expect(
        f.vault.connect(d).reclaimShieldTicket(BUCKETS[0], 0)
      ).to.be.revertedWith("already-reclaimed");
    });

    it("cannot reclaim a ticket the batch already deposited against", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`n${i}`));
      await f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments);
      await time.increase(RECLAIM_AFTER + 1);
      await expect(
        f.vault.connect(f.drivers[0]).reclaimShieldTicket(BUCKETS[0], 0)
      ).to.be.revertedWith("already-deposited");
    });

    it("a reclaimed ticket is skipped by the FIFO cursor without corrupting the queue", async () => {
      // The failure this guards: a reclaim in the middle of the queue must not
      // shift anyone else's ticket, or an owner loses their claim entirely.
      const f = await loadFixture(fixture);
      const total = MIN_BATCH + 2;
      for (let i = 0; i < total; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[0]);
      await time.increase(RECLAIM_AFTER + 1);

      // Driver 3 (mid-queue) gives up and reclaims.
      await f.vault.connect(f.drivers[3]).reclaimShieldTicket(BUCKETS[0], 3);
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(total - 1);

      // A full batch still executes, stepping over ticket 3.
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`n${i}`));
      await f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments);
      expect(await f.pool.depositCount()).to.equal(MIN_BATCH);
      expect(await f.vault.shieldPending(BUCKETS[0])).to.equal(total - 1 - MIN_BATCH);

      // Everyone else's ticket still resolves to them.
      for (const i of [0, 4, total - 1]) {
        const t = await f.vault.shieldTicket(BUCKETS[0], i);
        expect(t.owner).to.equal(f.drivers[i].address);
      }
    });
  });

  describe("accounting", () => {
    it("the buffer always equals the live tickets it stands behind", async () => {
      const f = await loadFixture(fixture);
      const live = async () => {
        let sum = 0n;
        for (const b of BUCKETS) sum += b * BigInt(await f.vault.shieldPending(b));
        return sum;
      };

      for (let i = 0; i < MIN_BATCH; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[0]);
      for (let i = 0; i < 3; i++) await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[1]);
      expect(await f.vault.shieldBuffer()).to.equal(await live());

      await time.increase(RECLAIM_AFTER + 1);
      await f.vault.connect(f.drivers[1]).reclaimShieldTicket(BUCKETS[1], 1);
      expect(await f.vault.shieldBuffer()).to.equal(await live());

      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`n${i}`));
      await f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments);
      expect(await f.vault.shieldBuffer()).to.equal(await live());
    });

    it("buffered value is never withdrawable as a balance", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      await f.vault.connect(d).queueShieldCredit(BUCKETS[2]); // 25 of 30 queued
      await expect(f.vault.connect(d).withdraw()).to.changeEtherBalance(d, PAS(5));
      expect(await f.vault.balanceOf(d.address)).to.equal(0);
      // The queued 25 stayed behind: it is buffer, not balance, and `withdraw`
      // drains a balance in full.
      expect(await f.vault.shieldBuffer()).to.equal(BUCKETS[2]);
      expect(await ethers.provider.getBalance(f.vault.target)).to.be.gte(BUCKETS[2]);
    });
  });

  describe("governance", () => {
    it("floors the batch size at 2 — a batch of 1 is the linkable design", async () => {
      const f = await loadFixture(fixture);
      await expect(f.vault.setShieldParams(1, MIN_DWELL, RECLAIM_AFTER)).to.be.revertedWith("batch-too-small");
      await expect(f.vault.setShieldParams(4, MIN_DWELL, RECLAIM_AFTER))
        .to.emit(f.vault, "ShieldParamsSet")
        .withArgs(4, MIN_DWELL, RECLAIM_AFTER);
      expect(await f.vault.shieldMinBatch()).to.equal(4);
    });

    it("ships with the documented defaults", async () => {
      const f = await loadFixture(fixture);
      expect(await f.vault.shieldMinBatch()).to.equal(MIN_BATCH);
      expect(await f.vault.shieldMinDwell()).to.equal(MIN_DWELL);
      expect(await f.vault.shieldReclaimAfter()).to.equal(RECLAIM_AFTER);
    });

    it("rejects buckets that are unordered, zero, or unsendable on Paseo", async () => {
      const f = await loadFixture(fixture);
      await expect(f.vault.setShieldBuckets([])).to.be.revertedWith("no-buckets");
      await expect(f.vault.setShieldBuckets([PAS(5), PAS(1)])).to.be.revertedWith("not-ascending");
      await expect(f.vault.setShieldBuckets([0n])).to.be.revertedWith("zero-bucket");
      // PaseoSafeSender: value % 1e6 >= 500_000 is rejected by the eth-rpc gateway,
      // so such a bucket would make every deposit in it revert at submission.
      await expect(f.vault.setShieldBuckets([PAS(1) + 600_000n])).to.be.revertedWith("bucket-unsendable");
    });

    it("only the owner configures the shield", async () => {
      const f = await loadFixture(fixture);
      const d = f.drivers[0];
      await expect(f.vault.connect(d).setShieldPool(ethers.ZeroAddress)).to.be.reverted;
      await expect(f.vault.connect(d).setShieldKeeper(d.address, true)).to.be.reverted;
      await expect(f.vault.connect(d).setShieldParams(2, 0, 0)).to.be.reverted;
    });
  });

  // ── the privacy invariants ────────────────────────────────────────────────
  // These are the reason the design is two transactions. A future change that
  // "helpfully" reunites the account with the commitment — a convenience
  // one-shot method, an extra event arg — reintroduces docs/PRIVACY-TIERS.md §3
  // and must fail here rather than in production.
  describe("privacy invariants", () => {
    it("the queue transaction names no commitment", async () => {
      const f = await loadFixture(fixture);
      const [d] = f.drivers;
      const commitment = commitmentFor("secret-note");
      const tx = await f.vault.connect(d).queueShieldCredit(BUCKETS[0]);
      const receipt = await tx.wait();

      expect(tx.data.toLowerCase()).to.not.include(commitment.slice(2).toLowerCase());
      for (const log of receipt!.logs) {
        expect(log.data.toLowerCase()).to.not.include(commitment.slice(2).toLowerCase());
      }
    });

    it("the batch transaction names no account", async () => {
      const f = await loadFixture(fixture);
      await queueAndAge(f, MIN_BATCH);
      const commitments = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`note-${i}`));
      const tx = await f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], commitments);
      const receipt = await tx.wait();

      // No ticket owner may appear in the calldata or in any log of the batch —
      // topics included, which is where an `indexed account` would surface.
      for (let i = 0; i < MIN_BATCH; i++) {
        const addr = f.drivers[i].address.slice(2).toLowerCase();
        expect(tx.data.toLowerCase(), "calldata leaks an account").to.not.include(addr);
        for (const log of receipt!.logs) {
          const blob = (log.data + log.topics.join("")).toLowerCase();
          expect(blob, "a batch log leaks an account").to.not.include(addr);
        }
      }
    });

    it("no single transaction ever carries both an account and its commitment", async () => {
      // End-to-end walk of the real flow, asserting the disjointness that makes
      // the pool's anonymity set usable at all.
      const f = await loadFixture(fixture);
      const notes = Array.from({ length: MIN_BATCH }, (_, i) => commitmentFor(`walk-${i}`));
      const txs: { data: string; logs: string }[] = [];

      for (let i = 0; i < MIN_BATCH; i++) {
        const tx = await f.vault.connect(f.drivers[i]).queueShieldCredit(BUCKETS[0]);
        const r = await tx.wait();
        txs.push({ data: tx.data, logs: r!.logs.map((l) => l.data + l.topics.join("")).join("") });
      }
      await time.increase(MIN_DWELL + 1);
      const batch = await f.vault.connect(f.keeper).executeShieldBatch(BUCKETS[0], notes);
      const batchReceipt = await batch.wait();
      txs.push({
        data: batch.data,
        logs: batchReceipt!.logs.map((l) => l.data + l.topics.join("")).join(""),
      });

      for (const tx of txs) {
        const blob = (tx.data + tx.logs).toLowerCase();
        const hasAccount = f.drivers
          .slice(0, MIN_BATCH)
          .some((d: HardhatEthersSigner) => blob.includes(d.address.slice(2).toLowerCase()));
        const hasCommitment = notes.some((c) => blob.includes(c.slice(2).toLowerCase()));
        expect(hasAccount && hasCommitment, "a transaction pairs an account with a commitment").to.equal(false);
      }
    });
  });
});
