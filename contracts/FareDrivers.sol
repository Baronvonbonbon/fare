// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./lib/PaseoSafeSender.sol";
import "./lib/FareUpgradable.sol";
import "./interfaces/IFare.sol";

/// View surface of a previous FareDrivers used by `importRecords`.
interface IFareDriversLegacy {
    function drivers(address)
        external
        view
        returns (
            bool registered,
            bool banned,
            uint96 stake,
            uint64 unstakeRequestedAt,
            uint32 delivered,
            uint32 failed,
            string memory metadataURI
        );
}

/// @title FareDrivers
/// @notice Driver registry: identity, optional stake, reputation counters,
///         slash hook. Stake is OPTIONAL by default (`minStake = 0`) so
///         onboarding is a single free registration; governance can raise
///         the floor later without redeploying (easy onboarding now,
///         expandable economics later).
contract FareDrivers is Ownable2Step, PaseoSafeSender, FareUpgradable {
    struct Driver {
        bool registered;
        bool banned;
        uint96 stake;
        uint64 unstakeRequestedAt; // 0 = no pending request
        uint32 delivered;
        uint32 failed;
        string metadataURI; // off-chain profile (name, vehicle, contact route)
    }

    mapping(address => Driver) public drivers;
    mapping(address => bool) public authorized; // orders + disputes contracts
    IFarePauseRegistry public pauseRegistry;

    uint96 public minStake; // 0 = registration alone qualifies
    uint64 public unbondingSeconds = 3 days;

    event DriverRegistered(address indexed driver, uint96 stake, string metadataURI);
    event StakeAdded(address indexed driver, uint96 amount, uint96 newStake);
    event UnstakeRequested(address indexed driver, uint64 availableAt);
    event Unstaked(address indexed driver, uint96 amount);
    event DriverSlashed(address indexed driver, uint256 requested, uint256 taken, address recipient);
    event DriverBanned(address indexed driver, bool banned);
    event ReputationRecorded(address indexed driver, bool delivered, uint32 total);
    event AuthorizedSet(address indexed account, bool enabled);
    event MinStakeSet(uint96 minStake);
    event UnbondingSet(uint64 unbondingSeconds);

    constructor(address _pauseRegistry) Ownable(msg.sender) {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(3), "paused"); // CAT_REGISTRY
        _;
    }

    modifier onlyAuthorized() {
        require(authorized[msg.sender], "not-authorized");
        _;
    }

    // ---- admin ----

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    /// @notice Copy identity + reputation records from a predecessor during
    ///         an upgrade. Paginated (caller supplies address batches) so an
    ///         unbounded list can never brick the migration — the DATUM
    ///         multi-claim-fanout U3 lesson. Stake is deliberately NOT
    ///         copied: it stays withdrawable on the frozen v1 (unstake paths
    ///         are never freeze-gated), and drivers re-stake here.
    function importRecords(address oldContract, address[] calldata users) external onlyOwner {
        IFareDriversLegacy old = IFareDriversLegacy(oldContract);
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            Driver storage d = drivers[user];
            if (d.registered) continue; // never clobber live local state
            (
                bool registered,
                bool banned,
                ,
                ,
                uint32 delivered,
                uint32 failed,
                string memory metadataURI
            ) = old.drivers(user);
            if (!registered) continue;
            d.registered = true;
            d.banned = banned;
            d.delivered = delivered;
            d.failed = failed;
            d.metadataURI = metadataURI;
            emit DriverRegistered(user, 0, metadataURI);
        }
    }

    function setAuthorized(address account, bool enabled) external onlyOwner {
        require(account != address(0), "zero-addr");
        authorized[account] = enabled;
        emit AuthorizedSet(account, enabled);
    }

    function setMinStake(uint96 _minStake) external onlyOwner {
        minStake = _minStake;
        emit MinStakeSet(_minStake);
    }

    function setUnbondingSeconds(uint64 secs) external onlyOwner {
        require(secs <= 30 days, "too-long");
        unbondingSeconds = secs;
        emit UnbondingSet(secs);
    }

    function setBanned(address driver, bool banned) external onlyOwner {
        drivers[driver].banned = banned;
        emit DriverBanned(driver, banned);
    }

    // ---- driver lifecycle ----

    function register(string calldata metadataURI) external payable whenNotPaused whenNotFrozen {
        Driver storage d = drivers[msg.sender];
        require(!d.registered, "already-registered");
        d.registered = true;
        d.stake = uint96(msg.value);
        d.metadataURI = metadataURI;
        emit DriverRegistered(msg.sender, d.stake, metadataURI);
    }

    function setMetadata(string calldata metadataURI) external {
        require(drivers[msg.sender].registered, "not-registered");
        drivers[msg.sender].metadataURI = metadataURI;
    }

    // requestUnstake / withdrawStake / slash are deliberately NOT freeze-
    // gated: stake must always be able to leave a frozen v1.
    function addStake() external payable whenNotPaused whenNotFrozen {
        Driver storage d = drivers[msg.sender];
        require(d.registered, "not-registered");
        require(msg.value > 0, "zero-value");
        d.stake += uint96(msg.value);
        // Topping back up cancels any pending unbond so stake can't sit
        // simultaneously "active" for eligibility and "exiting" for withdrawal.
        d.unstakeRequestedAt = 0;
        emit StakeAdded(msg.sender, uint96(msg.value), d.stake);
    }

    /// @notice Begin the unbonding delay. Driver becomes ineligible for new
    ///         assignments immediately; funds withdrawable after the delay so
    ///         disputes on in-flight orders can still slash.
    function requestUnstake() external {
        Driver storage d = drivers[msg.sender];
        require(d.registered && d.stake > 0, "no-stake");
        d.unstakeRequestedAt = uint64(block.timestamp);
        emit UnstakeRequested(msg.sender, uint64(block.timestamp) + unbondingSeconds);
    }

    function withdrawStake() external nonReentrant {
        Driver storage d = drivers[msg.sender];
        require(d.unstakeRequestedAt != 0, "no-request");
        require(block.timestamp >= d.unstakeRequestedAt + unbondingSeconds, "unbonding");
        uint96 amount = d.stake;
        require(amount > 0, "zero-balance");
        d.stake = 0;
        d.unstakeRequestedAt = 0;
        emit Unstaked(msg.sender, amount);
        _safeSend(msg.sender, amount);
    }

    // ---- protocol hooks ----

    function recordDelivered(address driver) external onlyAuthorized {
        Driver storage d = drivers[driver];
        d.delivered += 1;
        emit ReputationRecorded(driver, true, d.delivered);
    }

    function recordFailed(address driver) external onlyAuthorized {
        Driver storage d = drivers[driver];
        d.failed += 1;
        emit ReputationRecorded(driver, false, d.failed);
    }

    /// @notice Slash up to `amount` from the driver's stake, sending the taken
    ///         value to `recipient` (dispute winner or treasury). Returns the
    ///         amount actually taken (stake may be smaller than requested).
    function slash(
        address driver,
        uint256 amount,
        address recipient
    ) external onlyAuthorized nonReentrant returns (uint256) {
        require(recipient != address(0), "zero-addr");
        Driver storage d = drivers[driver];
        uint256 taken = amount > d.stake ? d.stake : amount;
        if (taken > 0) {
            d.stake -= uint96(taken);
            _safeSend(recipient, taken);
        }
        emit DriverSlashed(driver, amount, taken, recipient);
        return taken;
    }

    // ---- views ----

    function isEligible(address driver) external view returns (bool) {
        Driver storage d = drivers[driver];
        return
            d.registered &&
            !d.banned &&
            d.stake >= minStake &&
            d.unstakeRequestedAt == 0; // exiting drivers can't take new work
    }

    function reputationOf(address driver) external view returns (uint32 delivered, uint32 failed) {
        Driver storage d = drivers[driver];
        return (d.delivered, d.failed);
    }
}
