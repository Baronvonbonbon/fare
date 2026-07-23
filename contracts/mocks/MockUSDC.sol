// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice A 6-decimal ERC-20 standing in for Asset Hub USDC/USDT in tests and
///         on testnet (Paseo has no canonical stablecoin). Open `mint` so a demo
///         can fund customers. NEVER deploy to mainnet — there the real bridged
///         USDC precompile address goes into the accepted-token set instead.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
