// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    // Multi-asset half. The real pool derives the ERC-20 precompile address from
    // the asset ID it is handed (`getPrecompileAddress`, which reverts
    // "AssetId too large" above 2**64); the mock is told the mapping instead,
    // because a local chain has no asset precompiles. Recording the ID the
    // caller passed is the point: `depositAsset` takes the ID while the escrow
    // ledger and the note commitment key on the ADDRESS, and committing the
    // wrong one of that pair is what permanently stranded 0.3 USDC on Paseo.
    mapping(uint256 => address) public assetToken;
    mapping(bytes32 => uint256) public depositedAssetId;
    mapping(address => uint256) public credited; // token => value already accounted for

    event Deposit(address indexed asset, bytes32 commitment);
    event NewCommitment(bytes32 commitment);

    function depositNative(bytes32 commitment) external payable {
        require(msg.value > 0, "zero-value");
        commitments.push(commitment);
        depositedValue[commitment] += msg.value;
        emit Deposit(address(0), commitment);
    }

    function setAssetToken(uint256 assetId, address token) external {
        assetToken[assetId] = token;
    }

    function depositAsset(uint256 asset, uint256 value, bytes32 commitment) external {
        require(asset < 2 ** 64, "AssetId too large"); // the real pool's guard, verbatim
        require(value > 0, "zero-value");
        address token = assetToken[asset];
        require(token != address(0), "unknown-asset");
        IERC20(token).transferFrom(msg.sender, address(this), value);
        _record(asset, token, value, commitment);
    }

    /// Credit a balance the caller already transferred in. This — not
    /// `depositAsset` — is the path FareVault uses, because pallet-assets makes
    /// the approver reserve a native deposit and the vault may hold no PAS. The
    /// mock checks the value really arrived, which is the invariant the real
    /// pool's escrow accounting depends on.
    function depositAssetDirect(uint256 asset, uint256 value, bytes32 commitment) external {
        require(asset < 2 ** 64, "AssetId too large");
        require(value > 0, "zero-value");
        address token = assetToken[asset];
        require(token != address(0), "unknown-asset");
        require(IERC20(token).balanceOf(address(this)) >= credited[token] + value, "not-received");
        _record(asset, token, value, commitment);
    }

    function _record(uint256 asset, address token, uint256 value, bytes32 commitment) internal {
        commitments.push(commitment);
        depositedValue[commitment] += value;
        depositedAssetId[commitment] = asset;
        credited[token] += value;
        emit Deposit(token, commitment); // the EVENT carries the address, the CALL took the id
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

    /// Mirror a reference LeanIMT's sideNodes in one call. The real pool
    /// maintains these itself; the mock is told, because Poseidon lives in a
    /// precompile the test chain doesn't have.
    function setSideNodes(uint256[] calldata levels, uint256[] calldata values) external {
        require(levels.length == values.length, "length");
        for (uint256 i = 0; i < levels.length; i++) _sideNodes[levels[i]] = values[i];
    }

    function depositCount() external view returns (uint256) {
        return commitments.length;
    }
}
