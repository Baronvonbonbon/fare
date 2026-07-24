// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title MockUSDC
/// @notice A 6-decimal ERC-20 standing in for Asset Hub USDC/USDT in tests and
///         on testnet (Paseo has no canonical stablecoin). Open `mint` so a demo
///         can fund customers. Supports EIP-2612 `permit` so a gasless (Option C)
///         stablecoin order needs no separate approve. NEVER deploy to mainnet —
///         there the real bridged USDC precompile address goes into the
///         accepted-token set instead.
contract MockUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Mock USD Coin", "USDC") ERC20Permit("Mock USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
