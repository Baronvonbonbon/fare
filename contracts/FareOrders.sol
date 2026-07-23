// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IFare.sol";
import "./lib/FareUpgradable.sol";
import "./lib/GeoLib.sol";

/// @title FareOrders
/// @notice The order book: escrow, driver reverse auction, and lifecycle.
///
///         Money model (per the product decision: fare is the only required
///         flow, everything else zeroable for easy onboarding):
///           - orderValue — what the venue is owed for the goods. MAY be 0
///             (order paid off-chain at the venue's POS; the protocol is
///             then a pure driver marketplace for that order).
///           - fare       — the winning auction bid. Escrowed at acceptance.
///           - tip        — optional, escrowed at creation, increasable any
///             time before dropoff.
///
///         Lifecycle:
///           Open ──acceptBid──► Assigned ──pickup cosign──► PickedUp
///             │                    │                            │
///          cancelOpen      cancelAssigned/abandon          dropoff cosign
///             ▼                    ▼                            ▼
///          Cancelled           Cancelled                    Delivered
///           Assigned/PickedUp ──openDispute──► Disputed ──► Resolved
///
///         Escrow releases:
///           pickup cosign  → orderValue credited to venue payout
///           dropoff cosign → fare (minus protocol fee) + tip to driver
///         All value leaves through FareVault pull-payments.
contract FareOrders is Ownable2Step, ReentrancyGuard, FareUpgradable, ERC2771Context, IFareOrders {
    using SafeERC20 for IERC20;

    struct Order {
        address customer;
        uint64 venueId;
        Status status;
        address driver;
        uint96 orderValue;
        uint96 tip;
        uint96 fare;
        uint96 maxFare;
        uint96 escrow; // conservation tracker: everything not yet released
        bytes32 dropCommit; // Poseidon(latEnc, lonEnc, salt) — never revealed on-chain; proven in ZK at dropoff
        uint64 createdAt;
        uint64 pickupWindowSecs;
        uint64 deliveryWindowSecs;
        uint64 pickupDeadline; // set at assignment
        uint64 deliveryDeadline; // set at pickup
        // Escrow asset (C3): address(0) = native PAS; otherwise an accepted
        // ERC-20 stablecoin. Fixed at creation; fare/tip top-ups use the same one.
        address token;
    }

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    // Reverse auction: open bids, customer picks any bidder.
    mapping(uint256 => mapping(address => uint96)) public bidOf;
    mapping(uint256 => address[]) internal _bidders;

    IFareVault public vault;
    IFareDrivers public drivers;
    IFareVenues public venues;
    IFarePauseRegistry public pauseRegistry;
    address public settlement;
    address public disputes;
    address public treasury;

    uint16 public feeBps = 250; // protocol fee on fare only, max 10%
    uint16 public assignedCancelBps = 2000; // driver compensation when customer cancels post-assign
    // Share of the protocol fee rebated to the relay that settles an order (bps
    // of the fee, ≤ 10000). Offsets the gas a venue relay fronts for gasless
    // orders (F6); carved from the treasury's fee, so no new customer cost.
    // Defaults to 0 (dormant) — governance enables it via setRelayRebateBps.
    uint16 public relayRebateBps = 0;
    uint64 public constant MIN_WINDOW = 10 minutes;
    uint64 public constant MAX_WINDOW = 24 hours;
    uint64 public defaultPickupWindow = 45 minutes;
    uint64 public defaultDeliveryWindow = 90 minutes;

    // Stablecoin escrow allowlist (C3): only owner-approved ERC-20s can back an
    // order, so a malicious/rebasing token can never enter the escrow accounting.
    // Empty by default — native-PAS orders need no entry here.
    mapping(address => bool) public acceptedToken;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed customer,
        uint64 indexed venueId,
        uint96 orderValue,
        uint96 tip,
        uint96 maxFare,
        bytes32 dropCommit
    );
    event BidPlaced(uint256 indexed orderId, address indexed driver, uint96 amount);
    event BidWithdrawn(uint256 indexed orderId, address indexed driver);
    event OrderAssigned(uint256 indexed orderId, address indexed driver, uint96 fare, uint64 pickupDeadline);
    event TipIncreased(uint256 indexed orderId, uint96 added, uint96 newTip);
    event OrderPickedUp(uint256 indexed orderId, uint64 deliveryDeadline);
    event OrderDelivered(uint256 indexed orderId, uint96 driverPaid, uint96 protocolFee);
    /// Relay gas-rebate paid at settlement — a slice of `protocolFee` routed to
    /// the account that submitted the dropoff tx (F6). `amount` is included in
    /// the `protocolFee` reported by OrderDelivered; treasury received the rest.
    event RelayRebated(uint256 indexed orderId, address indexed relayer, uint96 amount);
    event RelayRebateSet(uint16 relayRebateBps);
    event OrderCancelled(uint256 indexed orderId, uint8 reason, uint96 refunded, uint96 driverComp);
    event OrderDisputed(uint256 indexed orderId);
    event OrderResolved(uint256 indexed orderId, uint96 customerAmount, uint96 driverAmount);
    event ParamsSet(uint16 feeBps, uint16 assignedCancelBps, uint64 defaultPickupWindow, uint64 defaultDeliveryWindow);
    event AcceptedTokenSet(address indexed token, bool accepted);
    /// Coarse pickup region (GeoLib.regionOf of the venue pin), indexed FIRST
    /// so clients can server-side filter open-order discovery by region.
    event OrderRegion(bytes32 indexed region, uint256 indexed orderId);

    // Cancellation reason codes for OrderCancelled
    uint8 public constant REASON_CUSTOMER_OPEN = 0;
    uint8 public constant REASON_CUSTOMER_ASSIGNED = 1;
    uint8 public constant REASON_DRIVER_NO_SHOW = 2;
    uint8 public constant REASON_DRIVER_ABANDON = 3;

    /// @param _forwarder trusted EIP-2771 forwarder (FareForwarder) for gasless
    ///        meta-txs on the non-value user actions — placeBid / withdrawBid /
    ///        cancels / abandon (F8). Pass address(0) to disable meta-txs; value
    ///        actions (createOrder / acceptBid / increaseTip) always use the
    ///        direct caller, so the relay can never front a customer's escrow.
    constructor(address _pauseRegistry, address _forwarder)
        Ownable(msg.sender)
        ERC2771Context(_forwarder)
    {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(0), "paused"); // CAT_ORDERS
        _;
    }

    // ---- wiring & params ----

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function configure(
        address _vault,
        address _drivers,
        address _venues,
        address _settlement,
        address _disputes,
        address _treasury
    ) external onlyOwner {
        require(
            _vault != address(0) &&
                _drivers != address(0) &&
                _venues != address(0) &&
                _settlement != address(0) &&
                _disputes != address(0) &&
                _treasury != address(0),
            "zero-addr"
        );
        vault = IFareVault(_vault);
        drivers = IFareDrivers(_drivers);
        venues = IFareVenues(_venues);
        settlement = _settlement;
        disputes = _disputes;
        treasury = _treasury;
    }

    function setParams(
        uint16 _feeBps,
        uint16 _assignedCancelBps,
        uint64 _defaultPickupWindow,
        uint64 _defaultDeliveryWindow
    ) external onlyOwner {
        require(_feeBps <= 1000, "fee-too-high"); // 10% hard cap
        require(_assignedCancelBps <= 5000, "comp-too-high"); // 50% hard cap
        require(
            _defaultPickupWindow >= MIN_WINDOW &&
                _defaultPickupWindow <= MAX_WINDOW &&
                _defaultDeliveryWindow >= MIN_WINDOW &&
                _defaultDeliveryWindow <= MAX_WINDOW,
            "bad-window"
        );
        feeBps = _feeBps;
        assignedCancelBps = _assignedCancelBps;
        defaultPickupWindow = _defaultPickupWindow;
        defaultDeliveryWindow = _defaultDeliveryWindow;
        emit ParamsSet(_feeBps, _assignedCancelBps, _defaultPickupWindow, _defaultDeliveryWindow);
    }

    /// @notice Set the share of the protocol fee rebated to the settling relay
    ///         (bps of the fee; 0 disables, 10000 = the whole fee). Carved from
    ///         the treasury's cut, so it never adds cost to an order (F6).
    function setRelayRebateBps(uint16 _bps) external onlyOwner {
        require(_bps <= 10_000, "rebate-too-high"); // ≤ 100% of the fee
        relayRebateBps = _bps;
        emit RelayRebateSet(_bps);
    }

    /// @notice Allow (or revoke) an ERC-20 as an escrow asset for stablecoin
    ///         orders (C3). On mainnet this is the bridged USDC/USDT precompile;
    ///         in tests/testnet, MockUSDC.
    function setAcceptedToken(address token, bool accepted) external onlyOwner {
        require(token != address(0), "zero-addr"); // address(0) is the native sentinel
        acceptedToken[token] = accepted;
        emit AcceptedTokenSet(token, accepted);
    }

    // ---- customer: create / tip / cancel ----

    /// @param venueId       registered pickup venue
    /// @param dropCommit    Poseidon(latEnc, lonEnc, salt) where
    ///                      latEnc = lat + 90_000_000, lonEnc = lon + 180_000_000
    ///                      (offset-encoded microdegrees, kept non-negative for the
    ///                      field). The exact drop location NEVER goes on-chain — at
    ///                      dropoff it is proven in zero knowledge (confirmDropoffZK)
    ///                      against this commitment. See circuits/proximity.circom.
    /// @param orderValue    goods value owed to the venue; 0 = paid off-chain
    /// @param tip           optional driver tip; 0 allowed
    /// @param maxFare       bid ceiling for the auction; must be > 0
    /// @param pickupWindowSecs    0 = protocol default
    /// @param deliveryWindowSecs  0 = protocol default
    function createOrder(
        uint64 venueId,
        bytes32 dropCommit,
        uint96 orderValue,
        uint96 tip,
        uint96 maxFare,
        uint64 pickupWindowSecs,
        uint64 deliveryWindowSecs
    ) external payable whenNotPaused whenNotFrozen returns (uint256 orderId) {
        require(msg.value == uint256(orderValue) + tip, "bad-value");
        orderId = _open(venueId, dropCommit, orderValue, tip, maxFare, pickupWindowSecs, deliveryWindowSecs, address(0));
    }

    /// @notice Stablecoin-escrowed order (C3): identical to `createOrder` but the
    ///         escrow (orderValue + tip) is pulled in `token` via transferFrom
    ///         instead of native value. Fare and tip top-ups use the same token.
    ///         The customer must have approved this contract for the escrow.
    function createOrderERC20(
        address token,
        uint64 venueId,
        bytes32 dropCommit,
        uint96 orderValue,
        uint96 tip,
        uint96 maxFare,
        uint64 pickupWindowSecs,
        uint64 deliveryWindowSecs
    ) external whenNotPaused whenNotFrozen returns (uint256 orderId) {
        require(acceptedToken[token], "token-not-accepted");
        uint256 escrow = uint256(orderValue) + tip;
        require(escrow > 0, "zero-escrow"); // a token order with nothing escrowed is a no-op
        IERC20(token).safeTransferFrom(msg.sender, address(this), escrow);
        orderId = _open(venueId, dropCommit, orderValue, tip, maxFare, pickupWindowSecs, deliveryWindowSecs, token);
    }

    /// @dev Shared order-open logic; the caller has already collected the escrow
    ///      (native msg.value or an ERC-20 transferIn) equal to orderValue + tip.
    function _open(
        uint64 venueId,
        bytes32 dropCommit,
        uint96 orderValue,
        uint96 tip,
        uint96 maxFare,
        uint64 pickupWindowSecs,
        uint64 deliveryWindowSecs,
        address token
    ) internal returns (uint256 orderId) {
        require(venues.isActive(venueId), "venue-inactive");
        require(dropCommit != bytes32(0), "no-drop-commit");
        require(maxFare > 0, "no-max-fare");

        uint64 pw = pickupWindowSecs == 0 ? defaultPickupWindow : pickupWindowSecs;
        uint64 dw = deliveryWindowSecs == 0 ? defaultDeliveryWindow : deliveryWindowSecs;
        require(pw >= MIN_WINDOW && pw <= MAX_WINDOW, "bad-pickup-window");
        require(dw >= MIN_WINDOW && dw <= MAX_WINDOW, "bad-delivery-window");

        orderId = nextOrderId++;
        Order storage o = orders[orderId];
        o.customer = msg.sender;
        o.venueId = venueId;
        o.status = Status.Open;
        o.orderValue = orderValue;
        o.tip = tip;
        o.maxFare = maxFare;
        o.escrow = uint96(uint256(orderValue) + tip);
        o.dropCommit = dropCommit;
        o.createdAt = uint64(block.timestamp);
        o.pickupWindowSecs = pw;
        o.deliveryWindowSecs = dw;
        o.token = token;

        emit OrderCreated(orderId, msg.sender, venueId, orderValue, tip, maxFare, dropCommit);

        // Localized discovery: region is the LEADING indexed topic so clients
        // can server-side filter by it (Paseo's eth-rpc can't filter a
        // non-leading indexed topic). Additive — OrderCreated is unchanged.
        (int32 vlat, int32 vlon) = venues.locationOf(venueId);
        emit OrderRegion(GeoLib.regionOf(vlat, vlon), orderId);
    }

    // whenNotFrozen intentionally absent from everything below createOrder/
    // placeBid/acceptBid/increaseTip: cancels, settlement callbacks, and
    // dispute hooks are drain paths that must keep working on a frozen v1.
    function increaseTip(uint256 orderId) external payable whenNotFrozen {
        Order storage o = orders[orderId];
        require(msg.sender == o.customer, "not-customer");
        require(o.token == address(0), "use-erc20-tip"); // native path only
        require(
            o.status == Status.Open || o.status == Status.Assigned || o.status == Status.PickedUp,
            "bad-status"
        );
        require(msg.value > 0, "zero-value");
        o.tip += uint96(msg.value);
        o.escrow += uint96(msg.value);
        emit TipIncreased(orderId, uint96(msg.value), o.tip);
    }

    /// @notice Top up the tip of a stablecoin order (C3); `amount` pulled in the
    ///         order's escrow token (customer must have approved this contract).
    function increaseTipERC20(uint256 orderId, uint96 amount) external whenNotFrozen {
        Order storage o = orders[orderId];
        require(msg.sender == o.customer, "not-customer");
        require(o.token != address(0), "use-native-tip"); // token path only
        require(
            o.status == Status.Open || o.status == Status.Assigned || o.status == Status.PickedUp,
            "bad-status"
        );
        require(amount > 0, "zero-value");
        IERC20(o.token).safeTransferFrom(msg.sender, address(this), amount);
        o.tip += amount;
        o.escrow += amount;
        emit TipIncreased(orderId, amount, o.tip);
    }

    /// @notice Cancel an unassigned order. Full refund, never pause-gated —
    ///         customers can always exit an open order.
    function cancelOpen(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(_msgSender() == o.customer, "not-customer"); // gasless via forwarder (F8)
        require(o.status == Status.Open, "bad-status");
        uint96 refund = o.escrow;
        o.escrow = 0;
        o.status = Status.Cancelled;
        _credit(o, o.customer, refund);
        emit OrderCancelled(orderId, REASON_CUSTOMER_OPEN, refund, 0);
    }

    /// @notice Cancel after assignment. Before the pickup deadline the driver
    ///         is compensated `assignedCancelBps` of the fare (the customer
    ///         changed their mind on a committed driver); after the deadline
    ///         it's a driver no-show — full refund and a reputation strike.
    function cancelAssigned(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(_msgSender() == o.customer, "not-customer"); // gasless via forwarder (F8)
        require(o.status == Status.Assigned, "bad-status");

        uint96 escrow = o.escrow;
        o.escrow = 0;
        o.status = Status.Cancelled;

        if (block.timestamp > o.pickupDeadline) {
            drivers.recordFailed(o.driver);
            _credit(o, o.customer, escrow);
            emit OrderCancelled(orderId, REASON_DRIVER_NO_SHOW, escrow, 0);
        } else {
            uint96 comp = uint96((uint256(o.fare) * assignedCancelBps) / 10_000);
            uint96 refund = escrow - comp;
            _credit(o, o.driver, comp);
            _credit(o, o.customer, refund);
            emit OrderCancelled(orderId, REASON_CUSTOMER_ASSIGNED, refund, comp);
        }
    }

    /// @notice Driver walks away from an assigned order before pickup.
    ///         Full customer refund + reputation strike. Always available —
    ///         a trapped assignment is worse than a strike.
    function abandonOrder(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(_msgSender() == o.driver, "not-driver"); // gasless via forwarder (F8)
        require(o.status == Status.Assigned, "bad-status");
        uint96 refund = o.escrow;
        o.escrow = 0;
        o.status = Status.Cancelled;
        drivers.recordFailed(o.driver);
        _credit(o, o.customer, refund);
        emit OrderCancelled(orderId, REASON_DRIVER_ABANDON, refund, 0);
    }

    // ---- drivers: reverse auction ----

    function placeBid(uint256 orderId, uint96 amount) external whenNotPaused whenNotFrozen {
        Order storage o = orders[orderId];
        address driver = _msgSender(); // gasless via forwarder (F8)
        require(o.status == Status.Open, "bad-status");
        require(drivers.isEligible(driver), "driver-not-eligible");
        require(amount > 0 && amount <= o.maxFare, "bad-amount");
        if (bidOf[orderId][driver] == 0) {
            _bidders[orderId].push(driver);
        }
        bidOf[orderId][driver] = amount;
        emit BidPlaced(orderId, driver, amount);
    }

    function withdrawBid(uint256 orderId) external {
        address driver = _msgSender(); // gasless via forwarder (F8)
        require(bidOf[orderId][driver] > 0, "no-bid");
        bidOf[orderId][driver] = 0;
        emit BidWithdrawn(orderId, driver);
    }

    /// @notice Customer picks the winning driver — any bid, not forced-lowest,
    ///         so reputation and stake can outweigh a marginally cheaper bid.
    ///         The winning fare is escrowed with this call.
    function acceptBid(uint256 orderId, address driver)
        external
        payable
        whenNotPaused
        whenNotFrozen
        nonReentrant
    {
        Order storage o = orders[orderId];
        require(o.token == address(0), "use-erc20-accept"); // native path only
        uint96 amount = _prepareAccept(o, orderId, driver);
        require(msg.value == amount, "bad-value");
        _assign(o, orderId, driver, amount);
    }

    /// @notice Accept a bid on a stablecoin order (C3): escrow the winning fare
    ///         in the order's token (customer must have approved this contract).
    function acceptBidERC20(uint256 orderId, address driver)
        external
        whenNotPaused
        whenNotFrozen
        nonReentrant
    {
        Order storage o = orders[orderId];
        require(o.token != address(0), "use-native-accept"); // token path only
        uint96 amount = _prepareAccept(o, orderId, driver);
        IERC20(o.token).safeTransferFrom(msg.sender, address(this), amount);
        _assign(o, orderId, driver, amount);
    }

    /// @dev Shared accept validation; returns the winning fare to escrow.
    function _prepareAccept(Order storage o, uint256 orderId, address driver) internal view returns (uint96 amount) {
        require(msg.sender == o.customer, "not-customer");
        require(o.status == Status.Open, "bad-status");
        amount = bidOf[orderId][driver];
        require(amount > 0, "no-bid");
        require(drivers.isEligible(driver), "driver-not-eligible");
    }

    /// @dev Shared assignment write once the fare escrow has been collected.
    function _assign(Order storage o, uint256 orderId, address driver, uint96 amount) internal {
        o.driver = driver;
        o.fare = amount;
        o.escrow += amount;
        o.status = Status.Assigned;
        o.pickupDeadline = uint64(block.timestamp) + o.pickupWindowSecs;
        emit OrderAssigned(orderId, driver, amount, o.pickupDeadline);
    }

    /// @dev Pay `amount` of the order's escrow asset to `to` through the vault —
    ///      native value transfer, or an ERC-20 approve+pull per `o.token` (C3).
    ///      One payout path, so every downstream release/refund/split is
    ///      asset-agnostic. Skips zero to avoid the vault's zero-value guard.
    function _credit(Order storage o, address to, uint96 amount) internal {
        if (amount == 0) return;
        if (o.token == address(0)) {
            vault.credit{value: amount}(to);
        } else {
            IERC20(o.token).forceApprove(address(vault), amount);
            vault.creditToken(o.token, to, amount);
        }
    }

    // ---- settlement callbacks ----

    modifier onlySettlement() {
        require(msg.sender == settlement, "not-settlement");
        _;
    }

    modifier onlyDisputes() {
        require(msg.sender == disputes, "not-disputes");
        _;
    }

    /// @notice Both pickup attestations verified by FareSettlement: release
    ///         the order value to the venue and start the delivery clock.
    function onPickupConfirmed(uint256 orderId) external onlySettlement nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == Status.Assigned, "bad-status");
        o.status = Status.PickedUp;
        o.deliveryDeadline = uint64(block.timestamp) + o.deliveryWindowSecs;
        uint96 toVenue = o.orderValue;
        if (toVenue > 0) {
            o.escrow -= toVenue;
            _credit(o, venues.payoutOf(o.venueId), toVenue);
        }
        venues.recordPickup(o.venueId);
        emit OrderPickedUp(orderId, o.deliveryDeadline);
    }

    /// @notice Both dropoff attestations verified by FareSettlement: pay the
    ///         driver (fare − protocol fee + tip), rebate a slice of the fee to
    ///         the settling relay (F6), send the rest to treasury, and close.
    /// @param relayer the account that submitted the dropoff tx (the gas-payer).
    function onDropoffConfirmed(uint256 orderId, address relayer) external onlySettlement nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == Status.PickedUp, "bad-status");
        o.status = Status.Delivered;

        uint96 fee = uint96((uint256(o.fare) * feeBps) / 10_000);
        // Carve the relay rebate out of the fee (never adds to the total). Skip
        // a zero/treasury relayer so we don't emit or double-credit needlessly.
        uint96 rebate = uint96((uint256(fee) * relayRebateBps) / 10_000);
        if (relayer == address(0) || relayer == treasury) rebate = 0;
        uint96 toTreasury = fee - rebate;
        uint96 toDriver = o.fare - fee + o.tip;
        o.escrow -= (o.fare + o.tip); // == toDriver + toTreasury + rebate

        _credit(o, o.driver, toDriver);
        _credit(o, treasury, toTreasury);
        _credit(o, relayer, rebate);
        drivers.recordDelivered(o.driver);

        emit OrderDelivered(orderId, toDriver, fee);
        if (rebate > 0) emit RelayRebated(orderId, relayer, rebate);
    }

    // ---- dispute hooks ----

    function markDisputed(uint256 orderId) external onlyDisputes {
        Order storage o = orders[orderId];
        require(o.status == Status.Assigned || o.status == Status.PickedUp, "bad-status");
        o.status = Status.Disputed;
        emit OrderDisputed(orderId);
    }

    /// @notice Arbiter split of whatever escrow remains (fare + tip, plus
    ///         order value when the dispute froze a pre-pickup order).
    function resolveDisputed(uint256 orderId, uint16 customerShareBps)
        external
        onlyDisputes
        nonReentrant
    {
        Order storage o = orders[orderId];
        require(o.status == Status.Disputed, "bad-status");
        require(customerShareBps <= 10_000, "bad-bps");

        uint96 escrow = o.escrow;
        o.escrow = 0;
        o.status = Status.Resolved;

        uint96 customerAmt = uint96((uint256(escrow) * customerShareBps) / 10_000);
        uint96 driverAmt = escrow - customerAmt;
        _credit(o, o.customer, customerAmt);
        _credit(o, o.driver, driverAmt);

        emit OrderResolved(orderId, customerAmt, driverAmt);
    }

    // ---- views ----

    function statusOf(uint256 orderId) external view returns (Status) {
        return orders[orderId].status;
    }

    function partiesOf(uint256 orderId)
        external
        view
        returns (address customer, address driver, uint64 venueId)
    {
        Order storage o = orders[orderId];
        return (o.customer, o.driver, o.venueId);
    }

    function dropCommitOf(uint256 orderId) external view returns (bytes32) {
        return orders[orderId].dropCommit;
    }

    function deadlinesOf(uint256 orderId)
        external
        view
        returns (uint64 pickupDeadline, uint64 deliveryDeadline)
    {
        Order storage o = orders[orderId];
        return (o.pickupDeadline, o.deliveryDeadline);
    }

    function biddersOf(uint256 orderId) external view returns (address[] memory) {
        return _bidders[orderId];
    }

    // ---- EIP-2771 context (F8) ----
    // Context is inherited via both Ownable and ERC2771Context; resolve to the
    // 2771 versions so `_msgSender()` unwraps the appended sender on a forwarded
    // call. Value functions above deliberately still read `msg.sender` directly.

    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}
