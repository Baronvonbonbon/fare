// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./lib/FareUpgradable.sol";

/// @title FareGovernanceRouter
/// @notice Stable-address contract registry + upgrade authority — the slim
///         port of DATUM's DatumGovernanceRouter for a 7-contract system.
///
///         Clients (web app, integrators, other contracts) resolve live
///         addresses from `currentAddrOf[name]` instead of hardcoding, so
///         an upgrade is one transaction and every consumer follows.
///
///         Upgrade flow (freeze-and-drain, see FareUpgradable):
///           1. deploy v2, wire its config
///           2. `upgradeContract(name, v2, freezeOld)`
///              → optionally freeze v1 (entry mutators blocked, exits open)
///              → v2.migrate(v1) copies cheap state (records, not escrow)
///              → registry re-points, version bumps
///           3. operator re-points cached refs in dependent contracts
///              (e.g. `orders.configure`) — same posture as DATUM, where
///              cached references are updated via setter post-upgrade.
///
///         Ownership is the governance ladder: deployer → Safe/council →
///         (if ever needed) conviction governance. Ownable2Step so the
///         handoff can't fat-finger to a dead address.
contract FareGovernanceRouter is Ownable2Step {
    mapping(bytes32 => address) public currentAddrOf;
    mapping(bytes32 => uint64) public versionOf;
    mapping(bytes32 => address[]) internal _history;

    event ContractRegistered(bytes32 indexed name, address indexed addr, uint64 version);
    event ContractUpgraded(
        bytes32 indexed name,
        address indexed oldAddr,
        address indexed newAddr,
        uint64 version,
        bool oldFrozen
    );
    event ContractUnfrozen(bytes32 indexed name, address indexed addr);

    constructor() Ownable(msg.sender) {}

    /// @notice Initial registration (or discovery-only overwrite for
    ///         contracts that don't inherit FareUpgradable, like the pause
    ///         registry). Does not touch freeze state or call migrate.
    function register(bytes32 name, address addr) external onlyOwner {
        require(addr != address(0), "zero-addr");
        address old = currentAddrOf[name];
        if (old != address(0)) _history[name].push(old);
        currentAddrOf[name] = addr;
        versionOf[name] += 1;
        emit ContractRegistered(name, addr, versionOf[name]);
    }

    /// @notice Promote a successor for an upgradable contract.
    /// @param freezeOld false for contracts that must never freeze — the
    ///        vault's withdraw/credit paths are load-bearing for OTHER
    ///        contracts' drains, so a vault upgrade re-points consumers and
    ///        leaves v1 fully live.
    function upgradeContract(bytes32 name, address newAddr, bool freezeOld) external onlyOwner {
        address old = currentAddrOf[name];
        require(old != address(0), "not-registered");
        require(newAddr != address(0) && newAddr != old, "bad-addr");

        if (freezeOld) FareUpgradable(old).setFrozen(true);
        FareUpgradable(newAddr).migrate(old);

        _history[name].push(old);
        currentAddrOf[name] = newAddr;
        versionOf[name] += 1;
        emit ContractUpgraded(name, old, newAddr, versionOf[name], freezeOld);
    }

    /// @notice Rollback path: unfreeze a previously frozen contract (e.g.
    ///         the v2 turned out bad and the registry was re-pointed back).
    function setContractFrozen(bytes32 name, address addr, bool frozenState) external onlyOwner {
        FareUpgradable(addr).setFrozen(frozenState);
        if (!frozenState) emit ContractUnfrozen(name, addr);
    }

    function historyOf(bytes32 name) external view returns (address[] memory) {
        return _history[name];
    }
}
