import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { readFileSync } from "fs";
import * as path from "path";

// A REAL Groth16 proof from the drop-proximity circuit, produced by
// `node scripts/setup-zk.mjs` (regenerate to refresh). This suite drives the
// production FareLocationVerifier through the BN254 precompiles (0x06/0x07/0x08)
// — the same path pallet-revive exposes on Asset Hub — so it exercises the true
// on-chain verification, not a mock.
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "zk-proximity.json"), "utf8")
);

const abi = ethers.AbiCoder.defaultAbiCoder();

function encodeProof(p: { pi_a: string[]; pi_b: string[]; pi_c: string[] }): string {
  return abi.encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [p.pi_a, p.pi_b, p.pi_c]
  );
}

describe("FareLocationVerifier (Groth16 / BN254)", () => {
  async function deployVerifier() {
    const verifier = await (await ethers.getContractFactory("FareLocationVerifier")).deploy();
    return { verifier };
  }

  async function deployWithVK() {
    const { verifier } = await deployVerifier();
    const vk = fixture.vkCalldata;
    await verifier.setVerifyingKey(
      vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
      vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5
    );
    return { verifier };
  }

  const proof = encodeProof(fixture.proof);
  const pubSignals = fixture.publicSignals.map((s: string) => BigInt(s)); // [orderId, dropCommit, driverCommit, radius, nullifier]

  it("fails safe before the VK is set", async () => {
    const { verifier } = await loadFixture(deployVerifier);
    expect(await verifier.vkSet()).to.equal(false);
    expect(await verifier.verifyProximity(proof, pubSignals)).to.equal(false);
  });

  it("the verification key is lock-once", async () => {
    const { verifier } = await loadFixture(deployWithVK);
    const vk = fixture.vkCalldata;
    await expect(
      verifier.setVerifyingKey(
        vk.alpha1, vk.beta2, vk.gamma2, vk.delta2,
        vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5
      )
    ).to.be.revertedWith("vk-set");
  });

  it("accepts a valid proof for its public signals", async () => {
    const { verifier } = await loadFixture(deployWithVK);
    expect(await verifier.verifyProximity(proof, pubSignals)).to.equal(true);
  });

  it("rejects the proof if any public signal is tampered", async () => {
    const { verifier } = await loadFixture(deployWithVK);
    for (let i = 0; i < pubSignals.length; i++) {
      const tampered = [...pubSignals];
      tampered[i] = tampered[i] + 1n;
      expect(
        await verifier.verifyProximity(proof, tampered),
        `signal[${i}] tamper should fail`
      ).to.equal(false);
    }
  });

  it("rejects a malformed (wrong-length) proof", async () => {
    const { verifier } = await loadFixture(deployWithVK);
    expect(await verifier.verifyProximity("0x1234", pubSignals)).to.equal(false);
  });

  it("rejects a proof whose points are mangled", async () => {
    const { verifier } = await loadFixture(deployWithVK);
    const bad = encodeProof({
      pi_a: [fixture.proof.pi_a[0], fixture.proof.pi_a[1]],
      pi_b: fixture.proof.pi_b,
      pi_c: ["1", "2"], // not on-curve / wrong → pairing fails
    });
    expect(await verifier.verifyProximity(bad, pubSignals)).to.equal(false);
  });
});
