// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./lib/GeoLib.sol";
import "./lib/FareUpgradable.sol";
import "./interfaces/IFare.sol";

/// View surface of a previous FareVenues used by `importVenues`.
interface IFareVenuesLegacy {
    function venues(uint64)
        external
        view
        returns (
            address operator,
            address signer,
            address payout,
            int32 lat,
            int32 lon,
            bool active,
            uint32 pickups,
            string memory metadataURI
        );
}

/// @title FareVenues
/// @notice Venue (restaurant / store) registry. One operator can run many
///         venues. Each venue pins a public location — venue coordinates are
///         inherently public information, unlike customer drop locations —
///         plus a hot signer key for cosigning pickups at the counter and a
///         payout address for order-value releases.
contract FareVenues is Ownable2Step, FareUpgradable {
    using GeoLib for int32;

    struct Venue {
        address operator; // controls the venue record
        address signer;   // hot key that cosigns pickup attestations
        address payout;   // receives order-value releases (via FareVault)
        int32 lat;        // microdegrees
        int32 lon;        // microdegrees
        bool active;
        uint32 pickups;   // completed pickups (reputation)
        string metadataURI; // off-chain profile (name, menu, hours)
    }

    uint64 public nextVenueId = 1;
    mapping(uint64 => Venue) public venues;
    mapping(address => uint64[]) public venuesByOperator;
    mapping(address => bool) public authorized; // settlement contract
    IFarePauseRegistry public pauseRegistry;

    event VenueRegistered(
        uint64 indexed venueId,
        address indexed operator,
        int32 lat,
        int32 lon,
        string metadataURI
    );
    event VenueUpdated(uint64 indexed venueId, address signer, address payout, bool active);
    event VenueLocationUpdated(uint64 indexed venueId, int32 lat, int32 lon);
    event PickupRecorded(uint64 indexed venueId, uint32 totalPickups);
    event AuthorizedSet(address indexed account, bool enabled);

    constructor(address _pauseRegistry) Ownable(msg.sender) {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(3), "paused"); // CAT_REGISTRY
        _;
    }

    modifier onlyOperator(uint64 venueId) {
        require(venues[venueId].operator == msg.sender, "not-operator");
        _;
    }

    function setAuthorized(address account, bool enabled) external onlyOwner {
        require(account != address(0), "zero-addr");
        authorized[account] = enabled;
        emit AuthorizedSet(account, enabled);
    }

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    /// @notice Copy venue records (IDs preserved) from a predecessor during
    ///         an upgrade. Paginated by ID batch; never clobbers a locally
    ///         registered slot. Operator/signer/payout carry over so venue
    ///         key custody is uninterrupted.
    function importVenues(address oldContract, uint64[] calldata ids) external onlyOwner {
        IFareVenuesLegacy old = IFareVenuesLegacy(oldContract);
        for (uint256 i = 0; i < ids.length; i++) {
            uint64 id = ids[i];
            if (venues[id].operator != address(0)) continue;
            (
                address operator,
                address signer,
                address payout,
                int32 lat,
                int32 lon,
                bool active,
                uint32 pickups,
                string memory metadataURI
            ) = old.venues(id);
            if (operator == address(0)) continue;
            venues[id] = Venue(operator, signer, payout, lat, lon, active, pickups, metadataURI);
            venuesByOperator[operator].push(id);
            if (id >= nextVenueId) nextVenueId = id + 1;
            emit VenueRegistered(id, operator, lat, lon, metadataURI);
        }
    }

    // ---- venue lifecycle ----

    function registerVenue(
        int32 lat,
        int32 lon,
        address signer,
        address payout,
        string calldata metadataURI
    ) external whenNotPaused whenNotFrozen returns (uint64 venueId) {
        GeoLib.requireValid(lat, lon);
        venueId = nextVenueId++;
        venues[venueId] = Venue({
            operator: msg.sender,
            signer: signer == address(0) ? msg.sender : signer,
            payout: payout == address(0) ? msg.sender : payout,
            lat: lat,
            lon: lon,
            active: true,
            pickups: 0,
            metadataURI: metadataURI
        });
        venuesByOperator[msg.sender].push(venueId);
        emit VenueRegistered(venueId, msg.sender, lat, lon, metadataURI);
    }

    function setSigner(uint64 venueId, address signer) external onlyOperator(venueId) {
        require(signer != address(0), "zero-addr");
        venues[venueId].signer = signer;
        emit VenueUpdated(venueId, signer, venues[venueId].payout, venues[venueId].active);
    }

    function setPayout(uint64 venueId, address payout) external onlyOperator(venueId) {
        require(payout != address(0), "zero-addr");
        venues[venueId].payout = payout;
        emit VenueUpdated(venueId, venues[venueId].signer, payout, venues[venueId].active);
    }

    function setActive(uint64 venueId, bool active) external onlyOperator(venueId) {
        venues[venueId].active = active;
        emit VenueUpdated(venueId, venues[venueId].signer, venues[venueId].payout, active);
    }

    function setLocation(uint64 venueId, int32 lat, int32 lon) external onlyOperator(venueId) {
        GeoLib.requireValid(lat, lon);
        venues[venueId].lat = lat;
        venues[venueId].lon = lon;
        emit VenueLocationUpdated(venueId, lat, lon);
    }

    function setMetadata(uint64 venueId, string calldata metadataURI) external onlyOperator(venueId) {
        venues[venueId].metadataURI = metadataURI;
    }

    // ---- protocol hooks ----

    function recordPickup(uint64 venueId) external {
        require(authorized[msg.sender], "not-authorized");
        Venue storage v = venues[venueId];
        v.pickups += 1;
        emit PickupRecorded(venueId, v.pickups);
    }

    // ---- views ----

    function isActive(uint64 venueId) external view returns (bool) {
        return venues[venueId].active;
    }

    function operatorOf(uint64 venueId) external view returns (address) {
        return venues[venueId].operator;
    }

    function signerOf(uint64 venueId) external view returns (address) {
        return venues[venueId].signer;
    }

    function payoutOf(uint64 venueId) external view returns (address) {
        return venues[venueId].payout;
    }

    function locationOf(uint64 venueId) external view returns (int32 lat, int32 lon) {
        Venue storage v = venues[venueId];
        return (v.lat, v.lon);
    }

    function venueCountOf(address operator) external view returns (uint256) {
        return venuesByOperator[operator].length;
    }
}
