// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title PoseidonT3Adapter
/// @notice Test-only stand-in for Paseo's PVM-native PoseidonT3 precompile.
///         Paseo exposes `hash(uint256[2])` at
///         0x1d165f6fE5A30422E0E2140e91C8A9B800380637; a local chain has no such
///         precompile, so tests deploy circomlib's generated Poseidon contract
///         (which exposes `poseidon(uint256[2])`) and put this adapter in front
///         of it so FareVault sees the same ABI either way.
/// @dev The hash MUST be circomlib-compatible, not merely "a hash": the note
///      tree and circuits/shieldnote.circom have to agree on every digest or no
///      proof will ever verify.
interface ICircomPoseidon {
    function poseidon(uint256[2] calldata input) external pure returns (uint256);
}

contract PoseidonT3Adapter {
    ICircomPoseidon public immutable impl;

    constructor(address _impl) {
        impl = ICircomPoseidon(_impl);
    }

    function hash(uint256[2] calldata input) external view returns (uint256) {
        return impl.poseidon(input);
    }
}
