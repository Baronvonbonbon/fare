// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./lib/FareUpgradable.sol";
import "./interfaces/IFare.sol";

/// @title FareDisputes
/// @notice Arbitrated escape hatch for orders that can't settle themselves:
///         food never handed over, delivery claimed but not received, venue
///         refused pickup, driver vanished mid-route.
///
///         MVP posture: a single `arbiter` (deployer, then a council multisig)
///         resolves disputes off-chain-evidence-first, on-chain-execution-
///         second. The DATUM governance ladder (Council N-of-M → conviction-
///         voted OpenGov) is the documented decentralization path — the
///         arbiter address is swappable, so the upgrade needs no redeploy.
///
///         Anti-grief: opening a dispute takes a bond (zeroable during
///         bootstrap). Winner gets the bond back; loser's bond goes to the
///         treasury.
contract FareDisputes is Ownable2Step, ReentrancyGuard, FareUpgradable {
    enum DisputeStatus {
        None,
        Open,
        Resolved
    }

    struct Dispute {
        uint256 orderId;
        address opener;
        uint96 bond;
        DisputeStatus status;
        string evidenceURI; // off-chain evidence bundle (IPFS)
    }

    uint256 public nextDisputeId = 1;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256) public disputeOfOrder; // orderId → disputeId (0 = none)

    IFareOrders public orders;
    IFareVault public vault;
    IFareDrivers public drivers;
    IFarePauseRegistry public pauseRegistry;
    address public arbiter;
    address public treasury;

    uint96 public disputeBond; // 0 during bootstrap; raise to deter griefing

    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed orderId,
        address indexed opener,
        uint96 bond,
        string evidenceURI
    );
    event DisputeResolved(
        uint256 indexed disputeId,
        uint256 indexed orderId,
        uint16 customerShareBps,
        bool openerWins,
        uint256 driverSlashed
    );
    event ArbiterSet(address arbiter);
    event DisputeBondSet(uint96 bond);

    constructor(address _pauseRegistry) Ownable(msg.sender) {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
        arbiter = msg.sender;
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(2), "paused"); // CAT_DISPUTES
        _;
    }

    // ---- wiring & params ----

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function configure(
        address _orders,
        address _vault,
        address _drivers,
        address _treasury
    ) external onlyOwner {
        require(
            _orders != address(0) && _vault != address(0) && _drivers != address(0) && _treasury != address(0),
            "zero-addr"
        );
        orders = IFareOrders(_orders);
        vault = IFareVault(_vault);
        drivers = IFareDrivers(_drivers);
        treasury = _treasury;
    }

    function setArbiter(address _arbiter) external onlyOwner {
        require(_arbiter != address(0), "zero-addr");
        arbiter = _arbiter;
        emit ArbiterSet(_arbiter);
    }

    function setDisputeBond(uint96 bond) external onlyOwner {
        disputeBond = bond;
        emit DisputeBondSet(bond);
    }

    // ---- dispute lifecycle ----

    /// @notice Open a dispute on an Assigned or PickedUp order. Customer or
    ///         driver only. Freezes the order's escrow until resolution.
    function openDispute(uint256 orderId, string calldata evidenceURI)
        external
        payable
        whenNotPaused
        whenNotFrozen // resolve() stays open: pending disputes always finish
        returns (uint256 disputeId)
    {
        require(disputeOfOrder[orderId] == 0, "already-disputed");
        require(msg.value == disputeBond, "bad-bond");
        (address customer, address driver, ) = orders.partiesOf(orderId);
        require(msg.sender == customer || msg.sender == driver, "not-party");

        orders.markDisputed(orderId); // reverts unless Assigned/PickedUp

        disputeId = nextDisputeId++;
        disputes[disputeId] = Dispute({
            orderId: orderId,
            opener: msg.sender,
            bond: uint96(msg.value),
            status: DisputeStatus.Open,
            evidenceURI: evidenceURI
        });
        disputeOfOrder[orderId] = disputeId;
        emit DisputeOpened(disputeId, orderId, msg.sender, uint96(msg.value), evidenceURI);
    }

    /// @notice Arbiter ruling.
    /// @param customerShareBps share of the frozen escrow refunded to the
    ///        customer; the remainder goes to the driver.
    /// @param openerWins       bond refunded to opener if true, else forfeited
    ///        to the treasury (anti-grief).
    /// @param driverAtFault    reputation strike for the driver.
    /// @param slashDriverAmount stake slashed from the driver and paid to the
    ///        customer as damages (0 = none; capped at actual stake).
    function resolve(
        uint256 disputeId,
        uint16 customerShareBps,
        bool openerWins,
        bool driverAtFault,
        uint256 slashDriverAmount
    ) external nonReentrant {
        require(msg.sender == arbiter, "not-arbiter");
        Dispute storage d = disputes[disputeId];
        require(d.status == DisputeStatus.Open, "bad-status");
        d.status = DisputeStatus.Resolved;

        orders.resolveDisputed(d.orderId, customerShareBps);

        (address customer, address driver, ) = orders.partiesOf(d.orderId);
        if (driverAtFault) {
            drivers.recordFailed(driver);
        }
        uint256 slashed = 0;
        if (slashDriverAmount > 0) {
            slashed = drivers.slash(driver, slashDriverAmount, customer);
        }

        if (d.bond > 0) {
            vault.credit{value: d.bond}(openerWins ? d.opener : treasury);
        }

        emit DisputeResolved(disputeId, d.orderId, customerShareBps, openerWins, slashed);
    }
}
