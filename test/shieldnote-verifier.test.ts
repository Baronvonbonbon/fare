import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// FareShieldVerifier — Groth16 over the shield-note circuit (privacy phase 3).
//
// The fixture is a REAL proof from the real proving key
// (scripts/setup-shieldnote.mjs), so this checks the whole chain: circuit →
// trusted setup → VK encoding → BN254 precompile pairing. A verifier that
// accepts nothing and a verifier that accepts everything both pass a mocked
// test; only a real proof distinguishes them.

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "zk-shieldnote.json"), "utf8"));
const VK = JSON.parse(readFileSync(join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json"), "utf8"));

const encodeProof = (p: any) =>
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [p.pi_a, p.pi_b, p.pi_c]
  );

describe("FareShieldVerifier (Groth16 / BN254)", () => {
  async function fixture() {
    const verifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();
    return { verifier, proof: encodeProof(FIXTURE.proof), pubs: FIXTURE.publicSignals };
  }
  const setVK = (v: any) =>
    v.setVerifyingKey(VK.alpha1, VK.beta2, VK.gamma2, VK.delta2, VK.IC0, VK.IC1, VK.IC2, VK.IC3, VK.IC4);

  it("fails safe before the VK is set", async () => {
    const f = await loadFixture(fixture);
    expect(await f.verifier.verifyShieldNote(f.proof, f.pubs)).to.equal(false);
  });

  it("accepts a real proof for its public signals", async () => {
    const f = await loadFixture(fixture);
    await setVK(f.verifier);
    expect(await f.verifier.verifyShieldNote(f.proof, f.pubs)).to.equal(true);
  });

  it("rejects the proof if any public signal is tampered", async () => {
    const f = await loadFixture(fixture);
    await setVK(f.verifier);
    for (let i = 0; i < 4; i++) {
      const pubs = [...f.pubs];
      pubs[i] = (BigInt(pubs[i]) + 1n).toString();
      expect(await f.verifier.verifyShieldNote(f.proof, pubs), `signal ${i} not bound`).to.equal(false);
    }
  });

  it("binds ksCommitment — a valid proof cannot be re-pointed at another commitment", async () => {
    // The whole custody argument rests on this. ksCommitment takes no part in
    // the circuit's computation, so without the binding constraint the prover
    // could swap it and steal the deposit.
    const f = await loadFixture(fixture);
    await setVK(f.verifier);
    const pubs = [...f.pubs];
    pubs[3] = "12345678901234567890";
    expect(await f.verifier.verifyShieldNote(f.proof, pubs)).to.equal(false);
  });

  it("rejects a malformed or mangled proof", async () => {
    const f = await loadFixture(fixture);
    await setVK(f.verifier);
    expect(await f.verifier.verifyShieldNote("0x1234", f.pubs)).to.equal(false);

    const mangled = { ...FIXTURE.proof, pi_a: [FIXTURE.proof.pi_a[0], (BigInt(FIXTURE.proof.pi_a[1]) + 1n).toString()] };
    expect(await f.verifier.verifyShieldNote(encodeProof(mangled), f.pubs)).to.equal(false);
  });

  it("the verification key is lock-once", async () => {
    const f = await loadFixture(fixture);
    await setVK(f.verifier);
    await expect(setVK(f.verifier)).to.be.reverted;
  });
});
