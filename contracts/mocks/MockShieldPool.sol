// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title MockShieldPool
/// @notice Stand-in for the Kusama Shield pool's deposit surface, so the batched
///         shielded-payout path (FareVault, docs/PRIVACY-TIERS.md §4) is testable
///         without the live pool, its Poseidon precompile, or a Groth16 proving
///         key. It records what it was told, nothing more — the commitment is
///         opaque to the pool in production too.
/// @dev Tracks `treeSize` and exposes `sideNodes` because the batch keeper reads
///      both to snapshot the tree before a batch. The sideNodes values are
///      test-seeded rather than computed: the keeper only copies them through to
///      recipients, and the Poseidon path math they feed is checked against a
///      reference LeanIMT on the client side.
contract MockShieldPool {
    bytes32[] public commitments;
    mapping(bytes32 => uint256) public depositedValue;
    mapping(uint256 => uint256) private _sideNodes;

    event Deposit(address indexed asset, bytes32 commitment);
    event NewCommitment(bytes32 commitment);

    function depositNative(bytes32 commitment) external payable {
        require(msg.value > 0, "zero-value");
        commitments.push(commitment);
        depositedValue[commitment] += msg.value;
        emit Deposit(address(0), commitment);
    }

    /// Insert a leaf that is NOT ours — a third party depositing into the same
    /// pool, which shifts every index the keeper predicted.
    function foreignDeposit(bytes32 commitment) external payable {
        commitments.push(commitment);
        emit Deposit(address(0), commitment);
    }

    function treeSize() external view returns (uint256) {
        return commitments.length;
    }

    function sideNodes(uint256 level) external view returns (uint256) {
        return _sideNodes[level];
    }

    function setSideNode(uint256 level, uint256 value) external {
        _sideNodes[level] = value;
    }

    function depositCount() external view returns (uint256) {
        return commitments.length;
    }
}
