import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Verifying-key provenance (TEST-PLAN C4).
//
// `setVerifyingKey` is LOCK-ONCE. Both trusted setups are still single-party.
// Together those make a swapped proving key both undetectable and
// unrecoverable: nothing on chain says which zkey a deployed VK came from, and
// nothing can re-point it afterwards.
//
// This closes the detectable half. It walks the whole chain of custody from the
// artifact a user actually downloads to the key a verifier is actually
// configured with:
//
//   web/public/**/*.zkey   the file the browser fetches and proves against
//        ↓ exportVerificationKey
//   circuits/build/*vk.json    the committed verification key
//        ↓ (must agree, point for point)
//   circuits/build/set*VK-calldata.json   what setVerifyingKey is called with
//        ↓ deploy + configure
//   FareLocationVerifier.getVK()   what the chain will actually check against
//
// A break anywhere in that chain means users prove against one key while the
// contract verifies with another. Every proof fails, permanently, and the fix
// is a redeploy because the setter is lock-once.
//
// ── What this does NOT establish ─────────────────────────────────────────────
//
// That the zkey came from an honest ceremony. It cannot: both setups are
// single-party, so whoever ran them could hold toxic waste and forge proofs
// against this very key. That is the remaining mainnet gate — a real MPC with a
// published transcript — and it is a ceremony rather than a test. What this
// gives you is that the key you review is the key that gets deployed.

const ROOT = join(__dirname, "..");
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

const CIRCUITS = [
  {
    name: "proximity",
    zkey: "web/public/zk/proximity.zkey",
    wasm: "web/public/zk/proximity.wasm",
    vk: "circuits/build/vk.json",
    calldata: "circuits/build/setVK-calldata.json",
    verifier: "FareLocationVerifier",
    nPublic: 5,
  },
  {
    name: "shieldnote",
    zkey: "web/public/shield/shieldnote.zkey",
    wasm: "web/public/shield/shieldnote.wasm",
    vk: "circuits/build/shieldnote-vk.json",
    calldata: "circuits/build/setShieldVK-calldata.json",
    verifier: "FareShieldVerifier",
    nPublic: 4,
  },
] as const;

const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// The three representations encode the same points DIFFERENTLY, and reconciling
// them is most of the work here:
//
//   vk.json     G1 [x, y, z]      G2 [[x0, x1], [y0, y1], [z…]]   (snarkjs)
//   calldata    G1 [x, y]         G2 [x1, x0, y1, y0]  flat, EIP-197 order
//   on chain    uint256[2]        uint256[4]           same as calldata
//
// The G2 halves are SWAPPED between the first and the other two. Comparing
// them without accounting for that would fail on correct artifacts — and,
// worse, a comparison written to make that failure go away could pass on
// mismatched ones.
const g1 = (p: any[]) => [String(p[0]), String(p[1])];

/// snarkjs G2 → the flat EIP-197 quad the calldata and the contract use.
const g2Flat = (p: any[][]) => [String(p[0][1]), String(p[0][0]), String(p[1][1]), String(p[1][0])];

/// A flat quad, from calldata or from the chain, as strings.
const quad = (p: any[]) => [String(p[0]), String(p[1]), String(p[2]), String(p[3])];

describe("verifying-key provenance", function () {
  this.timeout(300_000);

  for (const c of CIRCUITS) {
    describe(c.name, () => {
      let derived: any;

      before(async () => {
        // The VK is derived from the SHIPPED zkey — the exact bytes a user's
        // browser downloads — not from a build directory that may hold
        // something else.
        const snarkjs = await esmImport("snarkjs");
        derived = await snarkjs.zKey.exportVerificationKey(join(ROOT, c.zkey));
      });

      it("the shipped proving key derives the committed verification key", () => {
        // Link one. If these ever disagree, the committed vk.json describes a
        // key nobody is proving with — and reviewing it tells you nothing.
        const committed = read(c.vk);

        expect(derived.protocol).to.equal("groth16");
        expect(derived.curve).to.equal("bn128");
        expect(derived.nPublic, `${c.name}: nPublic drifted`).to.equal(c.nPublic);
        expect(committed.nPublic).to.equal(derived.nPublic);

        expect(g1(derived.vk_alpha_1), "alpha1 differs").to.deep.equal(g1(committed.vk_alpha_1));
        expect(g2Flat(derived.vk_beta_2), "beta2 differs").to.deep.equal(g2Flat(committed.vk_beta_2));
        expect(g2Flat(derived.vk_gamma_2), "gamma2 differs").to.deep.equal(g2Flat(committed.vk_gamma_2));
        expect(g2Flat(derived.vk_delta_2), "delta2 differs").to.deep.equal(g2Flat(committed.vk_delta_2));
        expect(derived.IC.map(g1), "the IC points differ").to.deep.equal(committed.IC.map(g1));
      });

      it("the committed key is what setVerifyingKey is called with", () => {
        // Link two, and the one an attacker would target: swapping the CALLDATA
        // rather than the key deploys a verifier that accepts proofs from a
        // zkey no user has, while every committed artifact still looks right.
        const committed = read(c.vk);
        const cd = read(c.calldata);

        expect(g1(cd.alpha1), "calldata alpha1 does not match the committed VK")
          .to.deep.equal(g1(committed.vk_alpha_1));
        expect(quad(cd.beta2), "calldata beta2 differs").to.deep.equal(g2Flat(committed.vk_beta_2));
        expect(quad(cd.gamma2), "calldata gamma2 differs").to.deep.equal(g2Flat(committed.vk_gamma_2));
        expect(quad(cd.delta2), "calldata delta2 differs").to.deep.equal(g2Flat(committed.vk_delta_2));

        // One IC point per public signal, plus IC0.
        const ics = Object.keys(cd).filter((k) => /^IC\d+$/.test(k)).sort(
          (a, b) => Number(a.slice(2)) - Number(b.slice(2))
        );
        expect(ics.length, `${c.name}: ${ics.length} IC points for nPublic=${committed.nPublic}`)
          .to.equal(committed.nPublic + 1);
        expect(ics.map((k) => g1(cd[k])), "an IC point differs")
          .to.deep.equal(committed.IC.map(g1));
      });

      it("a verifier configured from that calldata holds exactly those points", async () => {
        // Link three: the chain's own copy. `getVK()` reads back what the
        // deployed contract will verify against, so this is the last hop from
        // reviewed artifact to enforced key.
        const cd = read(c.calldata);
        const committed = read(c.vk);
        const v = await (await ethers.getContractFactory(c.verifier)).deploy();

        const ics = Object.keys(cd)
          .filter((k) => /^IC\d+$/.test(k))
          .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
          .map((k) => cd[k]);
        await (v as any).setVerifyingKey(cd.alpha1, cd.beta2, cd.gamma2, cd.delta2, ...ics);

        expect(await v.vkSet()).to.equal(true);
        const onChain: any = await (v as any).getVK();

        expect(g1(onChain.alpha1)).to.deep.equal(g1(committed.vk_alpha_1));
        expect(quad(onChain.beta2), "the deployed beta2 differs").to.deep.equal(g2Flat(committed.vk_beta_2));
        expect(quad(onChain.gamma2), "the deployed gamma2 differs").to.deep.equal(g2Flat(committed.vk_gamma_2));
        expect(quad(onChain.delta2), "the deployed delta2 differs").to.deep.equal(g2Flat(committed.vk_delta_2));

        // IC points are named struct fields (IC0..ICn), not an array.
        for (let i = 0; i <= committed.nPublic; i++) {
          expect(g1(onChain[`IC${i}`]), `the deployed IC${i} differs from the committed VK`)
            .to.deep.equal(g1(committed.IC[i]));
        }
      });

      it("the key is lock-once, so a swap is unrecoverable as well as undetectable", async () => {
        // Why the checks above matter more than they would otherwise. There is
        // no second chance to correct a wrong key — the contract has to be
        // redeployed and every client re-pointed.
        const cd = read(c.calldata);
        const v = await (await ethers.getContractFactory(c.verifier)).deploy();
        const ics = Object.keys(cd)
          .filter((k) => /^IC\d+$/.test(k))
          .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
          .map((k) => cd[k]);

        await (v as any).setVerifyingKey(cd.alpha1, cd.beta2, cd.gamma2, cd.delta2, ...ics);
        await expect(
          (v as any).setVerifyingKey(cd.alpha1, cd.beta2, cd.gamma2, cd.delta2, ...ics)
        ).to.be.revertedWith("vk-set");
      });
    });
  }

  // ── the whole chain, end to end ───────────────────────────────────────────

  it("a proof built with the SHIPPED key verifies against the DEPLOYED key", async () => {
    // Every link above compares representations. This one exercises them: build
    // a real Groth16 proof with the wasm and zkey a browser downloads, deploy a
    // verifier from the committed calldata, and let the pairing check decide.
    //
    // If any hop in the chain of custody were broken, this is what a user would
    // hit — except they would hit it in production, on a lock-once contract,
    // with no way back.
    const snarkjs = await esmImport("snarkjs");
    const c = CIRCUITS[0]; // proximity: cheap to prove, and the customer-facing path

    const enc = (v: number, off: bigint) => (BigInt(v) + off).toString();
    const { poseidon2, poseidon3 } = await esmImport("poseidon-lite");
    const DROP = { lat: 37_784_900, lon: -122_419_400 };
    const DRV = { lat: 37_784_940, lon: -122_419_400 };
    const salt = 1234567n, drvSalt = 7654321n, orderId = 1n, radius = 100n;

    const commit = (lat: number, lon: number, s: bigint) =>
      poseidon3([BigInt(lat) + 90_000_000n, BigInt(lon) + 180_000_000n, s]);
    const dropCommit = commit(DROP.lat, DROP.lon, salt);
    const driverCommit = commit(DRV.lat, DRV.lon, drvSalt);
    const nullifier = poseidon2([salt, orderId]);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      {
        orderId: orderId.toString(),
        dropCommit: dropCommit.toString(),
        driverCommit: driverCommit.toString(),
        radiusMeters: radius.toString(),
        nullifier: nullifier.toString(),
        custLatEnc: enc(DROP.lat, 90_000_000n), custLonEnc: enc(DROP.lon, 180_000_000n),
        salt: salt.toString(),
        drvLatEnc: enc(DRV.lat, 90_000_000n), drvLonEnc: enc(DRV.lon, 180_000_000n),
        drvSalt: drvSalt.toString(),
      },
      join(ROOT, c.wasm),
      join(ROOT, c.zkey)
    );

    const cd = read(c.calldata);
    const v = await (await ethers.getContractFactory(c.verifier)).deploy();
    const ics = Object.keys(cd)
      .filter((k) => /^IC\d+$/.test(k))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
      .map((k) => cd[k]);
    await (v as any).setVerifyingKey(cd.alpha1, cd.beta2, cd.gamma2, cd.delta2, ...ics);

    // G2 halves are swapped relative to snarkjs's ordering (EIP-197).
    const packed = ethers.solidityPacked(Array(8).fill("uint256"), [
      proof.pi_a[0], proof.pi_a[1],
      proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0],
      proof.pi_c[0], proof.pi_c[1],
    ]);

    expect(
      await (v as any).verifyProximity(packed, publicSignals.map((s: string) => BigInt(s))),
      "a proof from the shipped zkey was REJECTED by a verifier configured from the committed calldata — " +
        "the chain of custody is broken"
    ).to.equal(true);
  });

  // ── the part that is still open ───────────────────────────────────────────

  it("records that both setups remain single-party", () => {
    // Not a check — a marker, so the limit stays visible next to the guarantee.
    // Everything above proves the deployed key is the reviewed key. None of it
    // proves the reviewed key is TRUSTWORTHY: a single-party setup means
    // whoever ran it may hold toxic waste and can forge proofs against this
    // exact key.
    //
    // Closing that needs a multi-party ceremony with a published transcript,
    // and this assertion should be replaced by transcript verification when it
    // runs. It is the top mainnet gate (PRIVACY-STATUS.md, cross-cutting).
    const status = readFileSync(join(ROOT, "docs", "PRIVACY-STATUS.md"), "utf8");
    expect(
      status,
      "PRIVACY-STATUS.md no longer records the single-party setups — if a real " +
        "ceremony ran, replace this with transcript verification (C4)"
    ).to.include("**Both trusted setups are single-party**");
  });
});
