// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title FareUpgradable
/// @notice Inheritance base for router-driven upgrades, following the DATUM
///         alpha-core ladder in its minimal form.
///
///         Upgrade model: **freeze-and-drain.** When the router promotes a
///         v2, the v1 contract is frozen — `whenNotFrozen` blocks *entry*
///         mutators (new orders, new bids, new registrations) while every
///         *exit and completion* path stays open (cancels, settlement
///         callbacks on in-flight orders, stake withdrawal, vault
///         withdrawal, dispute resolution). In-flight state drains
///         naturally; nothing is ever trapped behind an upgrade.
///
///         `migrate(old)` is the optional state-copy hook (default no-op),
///         called by the router on the NEW contract during promotion.
abstract contract FareUpgradable {
    /// The FareGovernanceRouter authorized to freeze/unfreeze/migrate.
    address public router;
    bool public frozen;

    event RouterSet(address indexed router);
    event FrozenSet(bool frozen);

    modifier onlyRouter() {
        require(msg.sender == router, "not-router");
        _;
    }

    /// Entry mutators only. NEVER put this on an exit path (cancel,
    /// withdraw, unstake, settlement completion, dispute resolution).
    modifier whenNotFrozen() {
        require(!frozen, "frozen");
        _;
    }

    /// @dev One-time router binding; children expose this behind onlyOwner.
    function _setRouterOnce(address _router) internal {
        require(router == address(0), "router-set");
        require(_router != address(0), "zero-addr");
        router = _router;
        emit RouterSet(_router);
    }

    /// @notice Router-only freeze toggle. `true` on promotion of a
    ///         successor; `false` is the rollback path.
    function setFrozen(bool _frozen) external onlyRouter {
        frozen = _frozen;
        emit FrozenSet(_frozen);
    }

    /// @notice State-copy hook, called by the router on the NEW contract
    ///         with the address of the one it replaces. Default no-op —
    ///         the freeze-and-drain model makes copying optional. Override
    ///         for cheap-to-copy state (reputation records, venue pins);
    ///         escrowed value is intentionally never copied (it drains).
    function migrate(address oldContract) external virtual onlyRouter {}

    function contractVersion() public pure virtual returns (uint256) {
        return 1;
    }
}
