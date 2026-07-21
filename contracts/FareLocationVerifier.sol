// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IFare.sol";

/// @title FareLocationVerifier
/// @notice Groth16 verifier for the drop-proximity circuit
///         (circuits/proximity.circom), using the BN254 precompiles that
///         pallet-revive exposes on Polkadot/Asset Hub:
///           0x06 — ecAdd     (G1 addition)
///           0x07 — ecMul     (G1 scalar multiply)
///           0x08 — ecPairing (BN254 pairing check)
///
///         Ported from the DATUM alpha-core `DatumZKVerifier` (same precompile
///         path, already proven live on Paseo Hub), specialized to this
///         circuit's five public signals.
///
///         Proof format (256 bytes, ABI-encoded as in snarkjs → EIP-197 order):
///           pi_a : uint256[2]  — G1 point            (64 bytes)
///           pi_b : uint256[4]  — G2 point, EIP-197 order
///                                [x_imag, x_real, y_imag, y_real] (128 bytes)
///           pi_c : uint256[2]  — G1 point            (64 bytes)
///
///         Public signals (5), truncated mod SCALAR_ORDER before pairing —
///         they are already field elements, this is defence in depth:
///           pub0 = orderId
///           pub1 = dropCommit    — Poseidon(latEnc, lonEnc, salt)
///           pub2 = driverCommit  — Poseidon(drvLatEnc, drvLonEnc, drvSalt)
///           pub3 = radiusMeters
///           pub4 = nullifier     — Poseidon(salt, orderId)
///
///         The verification key is set once by the owner after the trusted
///         setup (`node scripts/setup-zk.mjs`). While unset, verifyProximity
///         returns false — fail-safe, so a mis-wired deploy never settles on a
///         zero VK.
contract FareLocationVerifier is Ownable2Step, IFareLocationVerifier {
    // -------------------------------------------------------------------------
    // BN254 constants
    // -------------------------------------------------------------------------

    uint256 private constant FIELD_PRIME =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant SCALAR_ORDER =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant NUM_PUBLIC_INPUTS = 5;

    // -------------------------------------------------------------------------
    // Verification key
    // -------------------------------------------------------------------------

    /// @dev G2 points stored in EIP-197 order: [x_imag, x_real, y_imag, y_real].
    struct VerifyingKey {
        uint256[2] alpha1;
        uint256[4] beta2;
        uint256[4] gamma2;
        uint256[4] delta2;
        uint256[2] IC0; // constant
        uint256[2] IC1; // orderId
        uint256[2] IC2; // dropCommit
        uint256[2] IC3; // driverCommit
        uint256[2] IC4; // radiusMeters
        uint256[2] IC5; // nullifier
    }

    VerifyingKey private _vk;
    bool public vkSet;

    event VerifyingKeySet(bytes32 indexed vkHash);

    constructor() Ownable(msg.sender) {}

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @notice Set the Groth16 verification key after trusted setup.
    ///         6 IC points (IC0..IC5) for 5 public signals + the constant.
    ///         G2 arrays in EIP-197 order: [x_imag, x_real, y_imag, y_real].
    ///         Run `node scripts/setup-zk.mjs` to generate these (values land
    ///         in circuits/setVK-calldata.json).
    ///
    ///         Lock-once: to rotate the VK, deploy a fresh verifier and re-wire
    ///         FareSettlement.setLocationVerifier — this prevents a trusted-setup
    ///         VK being silently swapped for one that accepts arbitrary proofs.
    function setVerifyingKey(
        uint256[2] calldata alpha1,
        uint256[4] calldata beta2,
        uint256[4] calldata gamma2,
        uint256[4] calldata delta2,
        uint256[2] calldata IC0,
        uint256[2] calldata IC1,
        uint256[2] calldata IC2,
        uint256[2] calldata IC3,
        uint256[2] calldata IC4,
        uint256[2] calldata IC5
    ) external onlyOwner {
        require(!vkSet, "vk-set");
        _vk.alpha1 = alpha1;
        _vk.beta2 = beta2;
        _vk.gamma2 = gamma2;
        _vk.delta2 = delta2;
        _vk.IC0 = IC0;
        _vk.IC1 = IC1;
        _vk.IC2 = IC2;
        _vk.IC3 = IC3;
        _vk.IC4 = IC4;
        _vk.IC5 = IC5;
        vkSet = true;
        bytes32 vkHash = keccak256(
            abi.encode(alpha1, beta2, gamma2, delta2, IC0, IC1, IC2, IC3, IC4, IC5)
        );
        emit VerifyingKeySet(vkHash);
    }

    // -------------------------------------------------------------------------
    // Verify
    // -------------------------------------------------------------------------

    /// @inheritdoc IFareLocationVerifier
    function verifyProximity(bytes calldata proof, uint256[5] calldata pubSignals)
        external
        view
        override
        returns (bool)
    {
        if (!vkSet) return false;
        if (proof.length != 256) return false;

        (uint256 vkx, uint256 vky) = _computeVKX(pubSignals);
        if (vkx == 0 && vky == 0) return false;

        return _pairing(proof, vkx, vky);
    }

    function _computeVKX(uint256[NUM_PUBLIC_INPUTS] calldata pubs)
        internal
        view
        returns (uint256 vkx, uint256 vky)
    {
        vkx = _vk.IC0[0];
        vky = _vk.IC0[1];
        (vkx, vky) = _acc(vkx, vky, _vk.IC1[0], _vk.IC1[1], pubs[0]);
        (vkx, vky) = _acc(vkx, vky, _vk.IC2[0], _vk.IC2[1], pubs[1]);
        (vkx, vky) = _acc(vkx, vky, _vk.IC3[0], _vk.IC3[1], pubs[2]);
        (vkx, vky) = _acc(vkx, vky, _vk.IC4[0], _vk.IC4[1], pubs[3]);
        (vkx, vky) = _acc(vkx, vky, _vk.IC5[0], _vk.IC5[1], pubs[4]);
    }

    function _pairing(bytes calldata proof, uint256 vkx, uint256 vky)
        internal
        view
        returns (bool)
    {
        (uint256[2] memory pi_a, uint256[4] memory pi_b, uint256[2] memory pi_c) =
            abi.decode(proof, (uint256[2], uint256[4], uint256[2]));

        uint256 neg_pi_ay = pi_a[1] == 0 ? 0 : FIELD_PRIME - pi_a[1];

        bytes memory inp = abi.encodePacked(
            pi_a[0], neg_pi_ay,
            pi_b[0], pi_b[1], pi_b[2], pi_b[3],
            _vk.alpha1[0], _vk.alpha1[1],
            _vk.beta2[0], _vk.beta2[1], _vk.beta2[2], _vk.beta2[3],
            vkx, vky,
            _vk.gamma2[0], _vk.gamma2[1], _vk.gamma2[2], _vk.gamma2[3],
            pi_c[0], pi_c[1],
            _vk.delta2[0], _vk.delta2[1], _vk.delta2[2], _vk.delta2[3]
        );
        (bool pok, bytes memory pout) = address(0x08).staticcall(inp);
        if (!pok || pout.length < 32) return false;
        return abi.decode(pout, (uint256)) == 1;
    }

    /// @dev vk += IC * (pub mod SCALAR_ORDER). Returns (0,0) on any precompile
    ///      failure, which _verify treats as an invalid proof (fail-safe).
    function _acc(uint256 vkx, uint256 vky, uint256 icx, uint256 icy, uint256 pubRaw)
        internal
        view
        returns (uint256, uint256)
    {
        uint256 pub = pubRaw % SCALAR_ORDER;
        (bool ok, bytes memory out) = address(0x07).staticcall(abi.encode(icx, icy, pub));
        if (!ok || out.length < 64) return (0, 0);
        (uint256 mx, uint256 my) = abi.decode(out, (uint256, uint256));
        (bool ok2, bytes memory out2) = address(0x06).staticcall(abi.encode(vkx, vky, mx, my));
        if (!ok2 || out2.length < 64) return (0, 0);
        return abi.decode(out2, (uint256, uint256));
    }

    function getVK() external view returns (VerifyingKey memory) {
        return _vk;
    }
}
