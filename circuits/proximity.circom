pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

/// @title DropProximity
/// @notice FARE zero-knowledge dropoff proof. Proves — without revealing any
///         coordinate — that a driver's committed position is within a geofence
///         radius of the customer's committed drop location, where that drop
///         location is the exact one the customer committed to at order
///         creation.
///
/// Coordinate encoding (must match web/src/zk.ts and FareOrders NatSpec):
///   Coordinates are microdegrees (degrees × 1e6), OFFSET-ENCODED to stay
///   non-negative in the field:
///       latEnc = lat + 90_000_000    ∈ [0, 180_000_000]   (lat ∈ [-90, 90])
///       lonEnc = lon + 180_000_000   ∈ [0, 360_000_000]   (lon ∈ [-180, 180])
///   Differences are offset-invariant, so distance is computed directly on the
///   encoded values.
///
/// Public signals (order fixed — matches IFareLocationVerifier / IC indexing):
///   [0] orderId        — binds the proof to one order (also nullifier input)
///   [1] dropCommit      — Poseidon(custLatEnc, custLonEnc, salt)
///   [2] driverCommit    — Poseidon(drvLatEnc,  drvLonEnc,  drvSalt)
///   [3] radiusMeters    — geofence radius (contract pins == dropoffRadiusMeters)
///   [4] nullifier       — Poseidon(salt, orderId); single-use replay guard
///
/// Private witnesses:
///   custLatEnc, custLonEnc, salt      — customer drop position + drop salt
///   drvLatEnc,  drvLonEnc,  drvSalt   — driver position + driver salt
///
/// Distance model — equirectangular with a Bhaskara-I rational cosine, the
/// SAME approximation GeoLib.sol uses on-chain (max cosine error ≈ 0.16%; at
/// geofence scales < a few km the whole approximation is well under 1% vs
/// haversine — far below GPS noise). Made division-free by cross-multiplying
/// the inequality dx² + dy² ≤ R² through the cosine denominator and the
/// microdegree→meter scale:
///
///   Bhaskara (scaled ×4 on numerator and denominator to clear the /4 from the
///   half-sum mean latitude; the ×4 cancels in the ratio):
///     xmu2   = custLatEnc + drvLatEnc - 180_000_000   (= 2·meanLat, microdeg)
///     cosNum = 129_600_000_000_000_000 - 4·xmu2²       (≥ 0 for |lat| ≤ 90°)
///     cosDen = 129_600_000_000_000_000 +   xmu2²       (> 0 always)
///     cos ≈ cosNum / cosDen
///
///   With M = 111_320 (m per degree) and 1e6 microdeg per degree:
///     dyM = diffLat · M / 1e6
///     dxM = diffLon · (cosNum/cosDen) · M / 1e6
///   Multiply dx²+dy² ≤ R² through (cosDen·1e6)²:
///     termX = diffLon · cosNum · M
///     termY = diffLat · cosDen · M
///     lhs   = termX² + termY²
///     rhs   = (radiusMeters · cosDen · 1e6)²
///     require lhs ≤ rhs
///
/// All intermediate magnitudes stay < 2^210 given the range checks below, well
/// inside the BN254 field, so the field arithmetic is exact integer arithmetic
/// (squares of "negative" field elements equal the integer square mod r).
template DropProximity() {
    // ── Public ──────────────────────────────────────────────────────────
    signal input orderId;
    signal input dropCommit;
    signal input driverCommit;
    signal input radiusMeters;
    signal input nullifier;

    // ── Private ─────────────────────────────────────────────────────────
    signal input custLatEnc;
    signal input custLonEnc;
    signal input salt;
    signal input drvLatEnc;
    signal input drvLonEnc;
    signal input drvSalt;

    var LAT_MAX = 180000000;  // 180e6  (lat ∈ [-90, 90])
    var LON_MAX = 360000000;  // 360e6  (lon ∈ [-180, 180])
    var M       = 111320;     // meters per degree (WGS-84 mean, as in GeoLib)
    var BHASK4  = 129600000000000000; // 4 × 32400 × 1e12 = 1.296e17

    // ── 1. Range-check encoded coordinates ──────────────────────────────
    // Bounds are load-bearing: they keep the mean latitude within ±90° (so the
    // Bhaskara numerator stays ≥ 0) and keep every product below the field.
    component latC = Bounded(28); latC.in <== custLatEnc; latC.max <== LAT_MAX;
    component latD = Bounded(28); latD.in <== drvLatEnc;  latD.max <== LAT_MAX;
    component lonC = Bounded(29); lonC.in <== custLonEnc; lonC.max <== LON_MAX;
    component lonD = Bounded(29); lonD.in <== drvLonEnc;  lonD.max <== LON_MAX;

    // ── 2. Commitment openings ──────────────────────────────────────────
    component commitC = Poseidon(3);
    commitC.inputs[0] <== custLatEnc;
    commitC.inputs[1] <== custLonEnc;
    commitC.inputs[2] <== salt;
    commitC.out === dropCommit;

    component commitD = Poseidon(3);
    commitD.inputs[0] <== drvLatEnc;
    commitD.inputs[1] <== drvLonEnc;
    commitD.inputs[2] <== drvSalt;
    commitD.out === driverCommit;

    // ── 3. Nullifier ────────────────────────────────────────────────────
    component nullH = Poseidon(2);
    nullH.inputs[0] <== salt;
    nullH.inputs[1] <== orderId;
    nullH.out === nullifier;

    // ── 4. Cosine (Bhaskara, ×4-scaled) at the mean latitude ────────────
    signal xmu2;
    xmu2 <== custLatEnc + drvLatEnc - LAT_MAX;  // 2·meanLat in microdeg
    signal xmu2sq;
    xmu2sq <== xmu2 * xmu2;
    signal cosNum;
    signal cosDen;
    cosNum <== BHASK4 - 4 * xmu2sq;
    cosDen <== BHASK4 + xmu2sq;

    // ── 5. Cross-multiplied distance terms ──────────────────────────────
    signal diffLat;
    signal diffLon;
    diffLat <== custLatEnc - drvLatEnc;
    diffLon <== custLonEnc - drvLonEnc;

    signal termX;   // diffLon · cosNum · M
    signal termY;   // diffLat · cosDen · M
    signal tX0;
    signal tY0;
    tX0   <== diffLon * cosNum;
    termX <== tX0 * M;
    tY0   <== diffLat * cosDen;
    termY <== tY0 * M;

    signal lhs;
    signal tXsq;
    signal tYsq;
    tXsq <== termX * termX;
    tYsq <== termY * termY;
    lhs  <== tXsq + tYsq;

    signal rhsBase;   // radiusMeters · cosDen · 1e6
    signal rB0;
    rB0     <== radiusMeters * cosDen;
    rhsBase <== rB0 * 1000000;
    signal rhs;
    rhs <== rhsBase * rhsBase;

    // ── 6. Geofence: lhs ≤ rhs ──────────────────────────────────────────
    // Both operands are provably < 2^210 given the range checks; 240 bits of
    // comparator headroom is comfortable and sound.
    component within = LessEqThan(240);
    within.in[0] <== lhs;
    within.in[1] <== rhs;
    within.out === 1;
}

/// @notice Constrain `in ∈ [0, max]` with `max < 2^bits`. Num2Bits pins the
///         width; LessEqThan enforces the exact upper bound.
template Bounded(bits) {
    signal input in;
    signal input max;
    component n2b = Num2Bits(bits);
    n2b.in <== in;
    component le = LessEqThan(bits);
    le.in[0] <== in;
    le.in[1] <== max;
    le.out === 1;
}

component main {public [orderId, dropCommit, driverCommit, radiusMeters, nullifier]} = DropProximity();
