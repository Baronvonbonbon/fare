// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// Minimal cross-contract interfaces for the FARE protocol.
/// Each concrete contract exposes more; consumers bind to only what they use.

interface IFareVault {
    function credit(address to) external payable;
    /// @notice ERC-20 analogue of `credit` for stablecoin-escrowed orders (C3).
    ///         The authorized caller must have approved `amount` of `token` to
    ///         the vault; the vault pulls it and attributes the balance to `to`.
    function creditToken(address token, address to, uint256 amount) external;
}

/// @notice Groth16 verifier for the drop-proximity circuit (circuits/proximity.circom).
///         Public signals, in circuit order:
///           [0] orderId       — binds the proof to one order
///           [1] dropCommit     — Poseidon(latEnc, lonEnc, salt) == orders.dropCommitOf
///           [2] driverCommit   — Poseidon(drvLatEnc, drvLonEnc, drvSalt), == the
///                                driver's signed position commitment
///           [3] radiusMeters   — the geofence radius the proof enforces
///           [4] nullifier      — Poseidon(salt, orderId); single-use replay guard
interface IFareLocationVerifier {
    function verifyProximity(bytes calldata proof, uint256[5] calldata pubSignals)
        external
        view
        returns (bool);
}

interface IFarePauseRegistry {
    function isPaused(uint8 category) external view returns (bool);
}

interface IFareDrivers {
    function isEligible(address driver) external view returns (bool);
    function recordDelivered(address driver) external;
    function recordFailed(address driver) external;
    function slash(address driver, uint256 amount, address recipient) external returns (uint256);
}

interface IFareVenues {
    function isActive(uint64 venueId) external view returns (bool);
    function operatorOf(uint64 venueId) external view returns (address);
    function signerOf(uint64 venueId) external view returns (address);
    function payoutOf(uint64 venueId) external view returns (address);
    function locationOf(uint64 venueId) external view returns (int32 lat, int32 lon);
    function recordPickup(uint64 venueId) external;
}

interface IFareOrders {
    enum Status {
        None,
        Open,
        Assigned,
        PickedUp,
        Delivered,
        Cancelled,
        Disputed,
        Resolved
    }

    function statusOf(uint256 orderId) external view returns (Status);
    function partiesOf(uint256 orderId)
        external
        view
        returns (address customer, address driver, uint64 venueId);
    function dropCommitOf(uint256 orderId) external view returns (bytes32);
    function deadlinesOf(uint256 orderId)
        external
        view
        returns (uint64 pickupDeadline, uint64 deliveryDeadline);

    // Settlement callbacks (onlySettlement)
    function onPickupConfirmed(uint256 orderId) external;
    // `relayer` is the account that submitted the dropoff settlement tx (the
    // gas-payer) — used for the relay gas-rebate (F6).
    function onDropoffConfirmed(uint256 orderId, address relayer) external;

    // Dispute hooks (onlyDisputes)
    function markDisputed(uint256 orderId) external;
    function resolveDisputed(uint256 orderId, uint16 customerShareBps) external;
}
