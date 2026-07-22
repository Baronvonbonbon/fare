// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title FareForwarder
/// @notice EIP-2771 trusted forwarder for gasless meta-transactions (F8). A
///         venue relay calls `execute` with a user-signed `ForwardRequest`; the
///         relay pays gas while the target (FareOrders / FareRatings) sees the
///         *user* as `_msgSender()`. Only the non-value-bearing user actions are
///         forwarded this way — placeBid / withdrawBid / cancels / rate — so the
///         relay never fronts a customer's escrow (value actions stay on the
///         gas-sponsored funded-burner path). See docs/NETWORK-ARCHITECTURE.md.
///
/// @dev    Thin wrapper over OpenZeppelin's audited ERC2771Forwarder: it already
///         verifies the EIP-712 signature, a per-signer nonce, and the deadline
///         before forwarding, so signature/replay safety is not hand-rolled here.
contract FareForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("FareForwarder") {}
}
