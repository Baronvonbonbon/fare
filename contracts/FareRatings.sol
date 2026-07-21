// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IFare.sol";
import "./lib/FareUpgradable.sol";

/// @title FareRatings
/// @notice Verified-delivery ratings. A customer may rate the driver and the
///         venue for an order ONLY after that order is `Delivered`, and only for
///         an order they placed — the "verified purchase" gate that keeps the
///         aggregates honest. You cannot review-bomb without actually completing
///         (and paying for) deliveries; each order rates once.
///
///         Ratings are 1–5 stars; 0 = skip that target. Aggregates are stored as
///         (sum, count) per driver and per venue — clients compute sum/count.
///
///         Works with the per-order burner wallets: the order's `customer`
///         address (a fresh burner) is the authorized rater, so **no persistent
///         identity is required** — the gate is the *order*, not the account.
///         Aggregates accumulate across many one-shot burner raters.
///
///         Residual abuse (self-dealing: order from your own venue with a
///         colluding driver, deliver, self-rate) is bounded by the same economics
///         as the rest of the protocol — a real pickup+dropoff cosign is required,
///         and phantom deliveries map onto existing fraud shapes (see docs/GPS.md).
contract FareRatings is Ownable2Step, FareUpgradable {
    IFareOrders public orders;

    struct Agg {
        uint128 sum;
        uint128 count;
    }
    mapping(address => Agg) public driverAgg; // driver  => (Σ stars, n)
    mapping(uint64 => Agg) public venueAgg; // venueId => (Σ stars, n)
    mapping(uint256 => bool) public rated; // orderId => already rated

    event Configured(address orders);
    event Rated(
        uint256 indexed orderId,
        address indexed driver,
        uint64 indexed venueId,
        uint8 driverStars,
        uint8 venueStars,
        address customer
    );

    constructor() Ownable(msg.sender) {}

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function configure(address _orders) external onlyOwner {
        require(_orders != address(0), "zero-addr");
        orders = IFareOrders(_orders);
        emit Configured(_orders);
    }

    /// @notice Rate the driver and/or venue for a Delivered order you placed.
    /// @param driverStars 1–5, or 0 to skip rating the driver
    /// @param venueStars  1–5, or 0 to skip rating the venue
    function rate(uint256 orderId, uint8 driverStars, uint8 venueStars) external whenNotFrozen {
        require(!rated[orderId], "already-rated");
        require(driverStars <= 5 && venueStars <= 5, "bad-stars");
        require(driverStars != 0 || venueStars != 0, "nothing-to-rate");
        require(orders.statusOf(orderId) == IFareOrders.Status.Delivered, "not-delivered");

        (address customer, address driver, uint64 venueId) = orders.partiesOf(orderId);
        require(msg.sender == customer, "not-customer");

        rated[orderId] = true;
        if (driverStars != 0) {
            Agg storage a = driverAgg[driver];
            a.sum += driverStars;
            a.count += 1;
        }
        if (venueStars != 0) {
            Agg storage a = venueAgg[venueId];
            a.sum += venueStars;
            a.count += 1;
        }
        emit Rated(orderId, driver, venueId, driverStars, venueStars, customer);
    }

    /// @notice Average × 100 (centistars, so 437 = 4.37★) and the sample count.
    function driverRating(address driver) external view returns (uint256 avgX100, uint256 count) {
        Agg memory a = driverAgg[driver];
        return (a.count == 0 ? 0 : (uint256(a.sum) * 100) / a.count, a.count);
    }

    function venueRating(uint64 venueId) external view returns (uint256 avgX100, uint256 count) {
        Agg memory a = venueAgg[venueId];
        return (a.count == 0 ? 0 : (uint256(a.sum) * 100) / a.count, a.count);
    }
}
