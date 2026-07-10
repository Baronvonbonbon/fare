// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./lib/PaseoSafeSender.sol";
import "./lib/FareUpgradable.sol";

/// @title FareVault
/// @notice Single pull-payment vault for every native-token payout in the
///         protocol: venue order-value releases, driver fares + tips,
///         customer refunds, dispute splits, protocol fees. Authorized
///         protocol contracts push value in via `credit{value:}`; recipients
///         pull with `withdraw`. One money-out path keeps the escrow
///         invariants auditable and removes push-payment griefing
///         (a reverting recipient can never block a settlement).
/// @dev Inherits FareUpgradable for registry/version consistency, but NO
///      function here is `whenNotFrozen`: the vault is the drain path for
///      every other contract's freeze-and-drain upgrade, so it must never
///      block. Upgrade it with `freezeOld = false` — re-point consumers via
///      their configure() setters and leave v1 live until balances hit zero.
contract FareVault is Ownable2Step, PaseoSafeSender, FareUpgradable {
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public authorized;
    uint256 public totalCredited;
    uint256 public totalWithdrawn;

    event Credited(address indexed to, address indexed from, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event AuthorizedSet(address indexed account, bool enabled);

    constructor() Ownable(msg.sender) {}

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function setAuthorized(address account, bool enabled) external onlyOwner {
        require(account != address(0), "zero-addr");
        authorized[account] = enabled;
        emit AuthorizedSet(account, enabled);
    }

    /// @notice Credit `to` with the attached value. Protocol contracts only.
    function credit(address to) external payable {
        require(authorized[msg.sender], "not-authorized");
        require(to != address(0), "zero-addr");
        require(msg.value > 0, "zero-value");
        balanceOf[to] += msg.value;
        totalCredited += msg.value;
        emit Credited(to, msg.sender, msg.value, balanceOf[to]);
    }

    /// @notice Pull full balance to self.
    function withdraw() external nonReentrant {
        _withdraw(msg.sender);
    }

    /// @notice Pull full balance to a chosen recipient (cold wallet).
    function withdrawTo(address recipient) external nonReentrant {
        require(recipient != address(0), "zero-addr");
        _withdraw(recipient);
    }

    function _withdraw(address recipient) internal {
        uint256 amount = balanceOf[msg.sender];
        require(amount > 0, "zero-balance");
        balanceOf[msg.sender] = 0;
        totalWithdrawn += amount;
        emit Withdrawn(msg.sender, recipient, amount);
        _safeSend(recipient, amount);
    }
}
