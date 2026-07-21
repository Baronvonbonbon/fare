// Client-side zero-knowledge dropoff proving.
//
// Commitments use Poseidon (poseidon-lite — pure JS, circom-compatible; verified
// bit-identical to the circuit's circomlib Poseidon). The proximity proof is
// produced with snarkjs against the artifacts published to /zk/ by
// `scripts/setup-zk.mjs`. Neither party's coordinates ever leave the device in
// the clear once the proof is built — only the proof + hashed public signals go
// on-chain (see docs/PRIVACY.md).

import { poseidon2, poseidon3 } from "poseidon-lite";

// Offset encoding — must match circuits/proximity.circom and FareOrders NatSpec.
const OFF_LAT = 90_000_000n; // lat ∈ [-90, 90]  → [0, 180e6]
const OFF_LON = 180_000_000n; // lon ∈ [-180, 180] → [0, 360e6]

export const encLat = (latMicro: number | bigint): bigint => BigInt(latMicro) + OFF_LAT;
export const encLon = (lonMicro: number | bigint): bigint => BigInt(lonMicro) + OFF_LON;

/// bytes32 hex of a field element, for on-chain commitment comparison.
const toBytes32 = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");

/// Poseidon(latEnc, lonEnc, salt) — the drop / driver position commitment.
export function positionCommit(latMicro: number, lonMicro: number, salt: string | bigint): string {
  return toBytes32(poseidon3([encLat(latMicro), encLon(lonMicro), BigInt(salt)]));
}

/// Poseidon(salt, orderId) — single-use dropoff nullifier.
export function nullifier(salt: string | bigint, orderId: string | bigint): string {
  return toBytes32(poseidon2([BigInt(salt), BigInt(orderId)]));
}

export interface ProximityInputs {
  orderId: string | bigint;
  radiusMeters: number | bigint;
  cust: { lat: number; lon: number; salt: string | bigint }; // customer drop
  driver: { lat: number; lon: number; salt: string | bigint }; // driver position
}

export interface ProximityProof {
  /// ABI-encodable 256-byte proof for FareLocationVerifier / confirmDropoffZK.
  proof: string;
  /// [orderId, dropCommit, driverCommit, radiusMeters, nullifier] as bigints.
  pubSignals: bigint[];
}

// snarkjs is heavy (~1 MB) and only needed at the dropoff moment — load it, the
// wasm, and the zkey lazily so they never touch the create/browse critical path.
let snarkjsP: Promise<any> | null = null;
function loadSnarkjs(): Promise<any> {
  if (!snarkjsP) snarkjsP = import("snarkjs");
  return snarkjsP;
}

/// Build the Groth16 proximity proof entirely in-browser. Throws if the driver
/// is actually outside the fence (the circuit constraint is unsatisfiable), so
/// a thrown proof IS the on-chain "driver-out-of-range" rejection, caught early.
export async function proveProximity(inp: ProximityInputs): Promise<ProximityProof> {
  const orderId = BigInt(inp.orderId);
  const radiusMeters = BigInt(inp.radiusMeters);

  const dropCommit = positionCommit(inp.cust.lat, inp.cust.lon, inp.cust.salt);
  const driverCommit = positionCommit(inp.driver.lat, inp.driver.lon, inp.driver.salt);
  const nul = nullifier(inp.cust.salt, orderId);

  const witness = {
    orderId: orderId.toString(),
    dropCommit: BigInt(dropCommit).toString(),
    driverCommit: BigInt(driverCommit).toString(),
    radiusMeters: radiusMeters.toString(),
    nullifier: BigInt(nul).toString(),
    custLatEnc: encLat(inp.cust.lat).toString(),
    custLonEnc: encLon(inp.cust.lon).toString(),
    salt: BigInt(inp.cust.salt).toString(),
    drvLatEnc: encLat(inp.driver.lat).toString(),
    drvLonEnc: encLon(inp.driver.lon).toString(),
    drvSalt: BigInt(inp.driver.salt).toString(),
  };

  const snarkjs = await loadSnarkjs();
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness,
      "/zk/proximity.wasm",
      "/zk/proximity.zkey"
    ));
  } catch (e: any) {
    // The most common cause is the geofence constraint failing (driver too far).
    throw new Error(
      "Could not build the delivery proof — you may be outside the drop radius. " +
        "Move to the customer's door and retry. (" + (e?.message ?? e) + ")"
    );
  }

  return {
    proof: encodeProofCalldata(proof),
    pubSignals: publicSignals.map((s: string) => BigInt(s)),
  };
}

/// snarkjs proof → the 256-byte ABI encoding FareLocationVerifier expects
/// (G2 in EIP-197 order). Kept dependency-free (no ethers import) so callers
/// pass the hex straight to the contract method.
export function encodeProofCalldata(proof: any): string {
  const w = (x: string | number | bigint) => BigInt(x).toString(16).padStart(64, "0");
  // uint256[2] pi_a, uint256[4] pi_b (x_imag,x_real,y_imag,y_real), uint256[2] pi_c
  const words = [
    proof.pi_a[0], proof.pi_a[1],
    proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0],
    proof.pi_c[0], proof.pi_c[1],
  ];
  return "0x" + words.map(w).join("");
}
