// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title FarePauseRegistry
/// @notice Per-category emergency pause shared by every FARE contract.
///         Categories: 0 = orders, 1 = settlement, 2 = disputes, 3 = registry.
///
///         Guardians can fast-pause any category; only the owner can unpause
///         or change the guardian set. This is the MVP posture — the DATUM
///         alpha-core pattern (solo-pause windows, 2-of-3 consensus unpause,
///         re-engagement cooldowns) is the documented production upgrade.
contract FarePauseRegistry is Ownable2Step {
    uint8 public constant CAT_ORDERS = 0;
    uint8 public constant CAT_SETTLEMENT = 1;
    uint8 public constant CAT_DISPUTES = 2;
    uint8 public constant CAT_REGISTRY = 3;

    mapping(uint8 => bool) public paused;
    mapping(address => bool) public isGuardian;

    event CategoryPaused(uint8 indexed category, address indexed by);
    event CategoryUnpaused(uint8 indexed category, address indexed by);
    event GuardianSet(address indexed guardian, bool enabled);

    constructor() Ownable(msg.sender) {}

    function setGuardian(address guardian, bool enabled) external onlyOwner {
        require(guardian != address(0), "zero-addr");
        isGuardian[guardian] = enabled;
        emit GuardianSet(guardian, enabled);
    }

    function pause(uint8 category) external {
        require(msg.sender == owner() || isGuardian[msg.sender], "not-authorized");
        require(category <= CAT_REGISTRY, "bad-category");
        paused[category] = true;
        emit CategoryPaused(category, msg.sender);
    }

    function unpause(uint8 category) external onlyOwner {
        paused[category] = false;
        emit CategoryUnpaused(category, msg.sender);
    }

    function isPaused(uint8 category) external view returns (bool) {
        return paused[category];
    }
}
