// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title MockShieldPool
/// @notice Stand-in for the Kusama Shield pool's `depositNative` surface, so the
///         batched shielded-payout path (FareVault, docs/PRIVACY-TIERS.md §4)
///         is testable without the live pool, its Poseidon precompile, or a
///         Groth16 proving key. It records what it was told, nothing more —
///         the commitment is opaque to the pool in production too.
contract MockShieldPool {
    bytes32[] public commitments;
    mapping(bytes32 => uint256) public depositedValue;

    event Deposit(address indexed asset, bytes32 commitment);

    function depositNative(bytes32 commitment) external payable {
        require(msg.value > 0, "zero-value");
        commitments.push(commitment);
        depositedValue[commitment] += msg.value;
        emit Deposit(address(0), commitment);
    }

    function depositCount() external view returns (uint256) {
        return commitments.length;
    }
}
