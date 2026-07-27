import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poseidon2 as p2, poseidon3 as p3 } from "poseidon-lite";
import { encLat, encLon, positionCommit, nullifier, encodeProofCalldata } from "./zk";

// Client-side ZK commitments and proof encoding (TEST-PLAN D2).
//
// These four functions decide whether a dropoff proof can be verified on chain
// at all, and none of them was covered. They are also the kind of code that
// fails silently in the worst direction: a wrong offset or a swapped G2
// coordinate produces a perfectly well-formed value that the verifier simply
// rejects, at the moment a driver is standing at a door trying to get paid.
//
// So the assertions are DIFFERENTIAL, not self-consistent. The expected values
// come from `test/fixtures/zk-proximity.json` — a real proof, produced by the
// real circom circuit, and the same fixture the contract-tier verifier test
// feeds to `FareLocationVerifier` and watches return true. If the client's
// Poseidon or its encoding ever drifts from the circuit's, these fail; a test
// that only checked the client against itself would not.

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "test", "fixtures", "zk-proximity.json"), "utf8")
);

const b32 = (x: string | bigint) => "0x" + BigInt(x).toString(16).padStart(64, "0");

// The circuit takes ENCODED coordinates; the client takes raw µdegrees and
// applies the offsets itself. Recovering the raw values is what lets the two be
// compared at all.
const OFF_LAT = 90_000_000n;
const OFF_LON = 180_000_000n;
const custLat = Number(BigInt(FIXTURE.input.custLatEnc) - OFF_LAT);
const custLon = Number(BigInt(FIXTURE.input.custLonEnc) - OFF_LON);
const drvLat = Number(BigInt(FIXTURE.input.drvLatEnc) - OFF_LAT);
const drvLon = Number(BigInt(FIXTURE.input.drvLonEnc) - OFF_LON);

describe("ZK commitments, against the real circuit's output", () => {
  it("the offset encoding matches what the circuit was fed", () => {
    // Not a tautology: these two constants live in circuits/proximity.circom,
    // in FareOrders' NatSpec, and here. The fixture is the circuit's copy.
    expect(encLat(custLat)).to.equal(BigInt(FIXTURE.input.custLatEnc));
    expect(encLon(custLon)).to.equal(BigInt(FIXTURE.input.custLonEnc));
    expect(encLat(drvLat)).to.equal(BigInt(FIXTURE.input.drvLatEnc));
    expect(encLon(drvLon)).to.equal(BigInt(FIXTURE.input.drvLonEnc));
  });

  it("encodes the full coordinate range without going negative", () => {
    // The offsets exist so a negative µdegree becomes a field element. A
    // negative input to Poseidon is the bug the encoding prevents, and the
    // southern/western hemispheres are where it would appear.
    for (const lat of [-90_000_000, -1, 0, 1, 90_000_000]) {
      expect(encLat(lat)).to.be.greaterThanOrEqual(0n);
    }
    for (const lon of [-180_000_000, -1, 0, 1, 180_000_000]) {
      expect(encLon(lon)).to.be.greaterThanOrEqual(0n);
    }
    expect(encLat(-90_000_000)).to.equal(0n);
    expect(encLon(-180_000_000)).to.equal(0n);
  });

  it("reproduces the drop commitment the circuit proved", () => {
    // THE assertion of this file. If it fails, the client is committing to a
    // different value than the circuit opens, and every dropoff proof is
    // rejected on chain.
    expect(positionCommit(custLat, custLon, BigInt(FIXTURE.input.salt)))
      .to.equal(b32(FIXTURE.input.dropCommit));
  });

  it("reproduces the driver commitment too", () => {
    expect(positionCommit(drvLat, drvLon, BigInt(FIXTURE.input.drvSalt)))
      .to.equal(b32(FIXTURE.input.driverCommit));
  });

  it("reproduces the nullifier", () => {
    expect(nullifier(BigInt(FIXTURE.input.salt), BigInt(FIXTURE.input.orderId)))
      .to.equal(b32(FIXTURE.input.nullifier));
  });

  it("commits to position with a THREE-input hash, not nested pairs", () => {
    // poseidon3([lat, lon, salt]) and poseidon2([poseidon2([lat, lon]), salt])
    // are both plausible readings of "hash these three things", and only one
    // matches the circuit. Pinning it against the fixture is what makes the
    // difference detectable — the nested form yields a valid-looking hash.
    const nested = "0x" + p2([p2([encLat(custLat), encLon(custLon)]), BigInt(FIXTURE.input.salt)])
      .toString(16).padStart(64, "0");
    expect(nested).to.not.equal(b32(FIXTURE.input.dropCommit));
    expect("0x" + p3([encLat(custLat), encLon(custLon), BigInt(FIXTURE.input.salt)])
      .toString(16).padStart(64, "0")).to.equal(b32(FIXTURE.input.dropCommit));
  });

  it("a different salt gives a different commitment", () => {
    // The salt is what stops the commitment being a lookup table over a city's
    // worth of coordinates. If it were ignored, every drop at the same address
    // would commit identically and the scheme would be a plain hash of a
    // location.
    const a = positionCommit(custLat, custLon, 1n);
    const b = positionCommit(custLat, custLon, 2n);
    expect(a).to.not.equal(b);
    expect(positionCommit(custLat, custLon, 1n)).to.equal(a); // and it is deterministic
  });

  it("commitments are full-width bytes32, left-padded", () => {
    // A field element that happens to be small must not shorten the hex, or the
    // on-chain comparison against a bytes32 fails for one drop in many.
    const small = positionCommit(custLat, custLon, 0n);
    expect(small).to.match(/^0x[0-9a-f]{64}$/);
    expect(nullifier(0n, 0n)).to.match(/^0x[0-9a-f]{64}$/);
  });
});

describe("proof calldata encoding", () => {
  it("packs the fixture's proof to 8 words in EIP-197 order", () => {
    const hex = encodeProofCalldata(FIXTURE.proof);
    expect(hex).to.match(/^0x[0-9a-f]{512}$/); // 8 × 32 bytes

    const words = hex.slice(2).match(/.{64}/g)!.map((w) => BigInt("0x" + w));
    const p = FIXTURE.proof;
    // Written out independently rather than by calling the function again: the
    // G2 halves are SWAPPED relative to snarkjs's order, and that swap is the
    // single most common way this encoding is got wrong.
    expect(words).to.deep.equal([
      BigInt(p.pi_a[0]), BigInt(p.pi_a[1]),
      BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0]),
      BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0]),
      BigInt(p.pi_c[0]), BigInt(p.pi_c[1]),
    ]);
  });

  it("the G2 halves really are swapped — an unswapped encoding differs", () => {
    // A control. The assertion above would pass against an implementation that
    // did NOT swap, if the fixture happened to have equal halves; this proves
    // the two encodings are actually distinguishable for this proof.
    const hex = encodeProofCalldata(FIXTURE.proof);
    const p = FIXTURE.proof;
    const unswapped = "0x" + [
      p.pi_a[0], p.pi_a[1],
      p.pi_b[0][0], p.pi_b[0][1], p.pi_b[1][0], p.pi_b[1][1],
      p.pi_c[0], p.pi_c[1],
    ].map((x: string) => BigInt(x).toString(16).padStart(64, "0")).join("");
    expect(hex).to.not.equal(unswapped);
  });

  it("pads every word, whatever its magnitude", () => {
    const hex = encodeProofCalldata({
      pi_a: ["1", "0"], pi_b: [["2", "3"], ["0", "5"]], pi_c: ["0", "7"],
    });
    expect(hex).to.match(/^0x[0-9a-f]{512}$/);
    expect(hex.slice(2).match(/.{64}/g)!.every((w) => w.length === 64)).to.equal(true);
  });
});
