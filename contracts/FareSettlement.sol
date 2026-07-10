// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./lib/GeoLib.sol";
import "./interfaces/IFare.sol";

/// @title FareSettlement
/// @notice Dual-signature GPS attestation verification — the protocol's
///         "proof a delivery physically happened".
///
///         The contract cannot sense location; it verifies that two parties
///         with ADVERSE interests each signed coordinates, and that those
///         coordinates are mutually consistent:
///
///         PICKUP:  driver + venue signer both attest they are at the venue.
///                  Both must be within `pickupRadiusMeters` of the venue's
///                  registered location.
///         DROPOFF: driver + customer both attest the handoff. The customer's
///                  attestation reveals the drop coordinates + salt matching
///                  the `dropCommit` published at order creation; the driver
///                  must be within `dropoffRadiusMeters` of those coordinates.
///
///         Collusion between the cosigners is handled economically (stake,
///         reputation, disputes) — not cryptographically. See docs/GPS.md.
///
///         Anyone may submit a confirmation (both signatures are required
///         anyway), which keeps the path relay-friendly: a driver's phone, a
///         venue tablet, or a gasless relay can carry the transaction.
///
///         Privacy note (MVP posture): the customer's revealed coordinates
///         appear in calldata, which is public. The commit scheme keeps them
///         off-chain until the delivery moment, but a ZK proximity circuit
///         (proving dist < R against the commitment without revealing
///         coordinates) is the documented production upgrade.
contract FareSettlement is Ownable2Step, EIP712 {
    using GeoLib for int32;

    /// Signed by the driver (phases 1 and 2) and the venue signer (phase 1).
    struct LocationAttestation {
        uint256 orderId;
        uint8 phase; // 1 = pickup, 2 = dropoff
        address actor;
        int32 lat; // microdegrees
        int32 lon; // microdegrees
        uint64 timestamp;
    }

    /// Signed by the customer at dropoff; reveals the committed drop location.
    struct DropoffReveal {
        uint256 orderId;
        int32 lat;
        int32 lon;
        uint256 salt;
        uint64 timestamp;
    }

    bytes32 public constant LOCATION_TYPEHASH =
        keccak256(
            "LocationAttestation(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp)"
        );
    bytes32 public constant DROPOFF_REVEAL_TYPEHASH =
        keccak256(
            "DropoffReveal(uint256 orderId,int32 lat,int32 lon,uint256 salt,uint64 timestamp)"
        );

    uint8 public constant PHASE_PICKUP = 1;
    uint8 public constant PHASE_DROPOFF = 2;

    IFareOrders public orders;
    IFareVenues public venues;
    IFarePauseRegistry public pauseRegistry;

    uint32 public pickupRadiusMeters = 150;
    uint32 public dropoffRadiusMeters = 100;
    uint64 public attestationMaxAgeSecs = 15 minutes;
    uint64 public attestationFutureSkewSecs = 5 minutes;

    event PickupConfirmed(
        uint256 indexed orderId,
        address indexed driver,
        address indexed venueSigner,
        int32 driverLat,
        int32 driverLon
    );
    event DropoffConfirmed(
        uint256 indexed orderId,
        address indexed driver,
        address indexed customer,
        int32 driverLat,
        int32 driverLon
    );
    event GeoParamsSet(uint32 pickupRadius, uint32 dropoffRadius, uint64 maxAge, uint64 futureSkew);

    constructor(address _pauseRegistry) Ownable(msg.sender) EIP712("FareSettlement", "1") {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(1), "paused"); // CAT_SETTLEMENT
        _;
    }

    // ---- wiring & params ----

    function configure(address _orders, address _venues) external onlyOwner {
        require(_orders != address(0) && _venues != address(0), "zero-addr");
        orders = IFareOrders(_orders);
        venues = IFareVenues(_venues);
    }

    function setGeoParams(
        uint32 _pickupRadiusMeters,
        uint32 _dropoffRadiusMeters,
        uint64 _maxAgeSecs,
        uint64 _futureSkewSecs
    ) external onlyOwner {
        // Radii bounded to keep the check meaningful: tight enough to matter,
        // loose enough for urban-canyon GPS error.
        require(_pickupRadiusMeters >= 25 && _pickupRadiusMeters <= 2000, "bad-pickup-radius");
        require(_dropoffRadiusMeters >= 25 && _dropoffRadiusMeters <= 2000, "bad-dropoff-radius");
        require(_maxAgeSecs >= 1 minutes && _maxAgeSecs <= 2 hours, "bad-max-age");
        require(_futureSkewSecs <= 30 minutes, "bad-skew");
        pickupRadiusMeters = _pickupRadiusMeters;
        dropoffRadiusMeters = _dropoffRadiusMeters;
        attestationMaxAgeSecs = _maxAgeSecs;
        attestationFutureSkewSecs = _futureSkewSecs;
        emit GeoParamsSet(_pickupRadiusMeters, _dropoffRadiusMeters, _maxAgeSecs, _futureSkewSecs);
    }

    // ---- confirmation entrypoints ----

    /// @notice Verify driver + venue pickup attestations and release the
    ///         order value. Callable by anyone holding both signatures.
    function confirmPickup(
        LocationAttestation calldata driverAtt,
        bytes calldata driverSig,
        LocationAttestation calldata venueAtt,
        bytes calldata venueSig
    ) external whenNotPaused {
        require(driverAtt.orderId == venueAtt.orderId, "order-mismatch");
        uint256 orderId = driverAtt.orderId;
        (, address driver, uint64 venueId) = orders.partiesOf(orderId);
        require(orders.statusOf(orderId) == IFareOrders.Status.Assigned, "bad-status");

        // Driver side
        require(driverAtt.phase == PHASE_PICKUP && driverAtt.actor == driver, "bad-driver-att");
        _verifyLocationSig(driverAtt, driverSig);
        _requireFresh(driverAtt.timestamp);

        // Venue side — must be the venue's registered hot signer
        address venueSigner = venues.signerOf(venueId);
        require(venueAtt.phase == PHASE_PICKUP && venueAtt.actor == venueSigner, "bad-venue-att");
        _verifyLocationSig(venueAtt, venueSig);
        _requireFresh(venueAtt.timestamp);

        // Geo: both parties within radius of the venue's registered pin
        (int32 vLat, int32 vLon) = venues.locationOf(venueId);
        GeoLib.requireValid(driverAtt.lat, driverAtt.lon);
        GeoLib.requireValid(venueAtt.lat, venueAtt.lon);
        require(
            GeoLib.withinRadius(driverAtt.lat, driverAtt.lon, vLat, vLon, pickupRadiusMeters),
            "driver-out-of-range"
        );
        require(
            GeoLib.withinRadius(venueAtt.lat, venueAtt.lon, vLat, vLon, pickupRadiusMeters),
            "venue-out-of-range"
        );

        orders.onPickupConfirmed(orderId);
        emit PickupConfirmed(orderId, driver, venueSigner, driverAtt.lat, driverAtt.lon);
    }

    /// @notice Verify driver + customer dropoff attestations. The customer's
    ///         reveal must match the drop commitment from order creation, and
    ///         the driver must be within radius of the revealed coordinates.
    function confirmDropoff(
        LocationAttestation calldata driverAtt,
        bytes calldata driverSig,
        DropoffReveal calldata reveal,
        bytes calldata customerSig
    ) external whenNotPaused {
        require(driverAtt.orderId == reveal.orderId, "order-mismatch");
        uint256 orderId = driverAtt.orderId;
        (address customer, address driver, ) = orders.partiesOf(orderId);
        require(orders.statusOf(orderId) == IFareOrders.Status.PickedUp, "bad-status");

        // Driver side
        require(driverAtt.phase == PHASE_DROPOFF && driverAtt.actor == driver, "bad-driver-att");
        _verifyLocationSig(driverAtt, driverSig);
        _requireFresh(driverAtt.timestamp);

        // Customer side: signature + commitment binding
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DROPOFF_REVEAL_TYPEHASH,
                    reveal.orderId,
                    reveal.lat,
                    reveal.lon,
                    reveal.salt,
                    reveal.timestamp
                )
            )
        );
        require(ECDSA.recover(digest, customerSig) == customer, "bad-customer-sig");
        _requireFresh(reveal.timestamp);
        require(
            keccak256(abi.encode(reveal.lat, reveal.lon, reveal.salt)) ==
                orders.dropCommitOf(orderId),
            "commit-mismatch"
        );

        // Geo: driver within radius of the revealed drop location
        GeoLib.requireValid(driverAtt.lat, driverAtt.lon);
        GeoLib.requireValid(reveal.lat, reveal.lon);
        require(
            GeoLib.withinRadius(driverAtt.lat, driverAtt.lon, reveal.lat, reveal.lon, dropoffRadiusMeters),
            "driver-out-of-range"
        );

        orders.onDropoffConfirmed(orderId);
        emit DropoffConfirmed(orderId, driver, customer, driverAtt.lat, driverAtt.lon);
    }

    // ---- helpers ----

    function _verifyLocationSig(LocationAttestation calldata att, bytes calldata sig) internal view {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LOCATION_TYPEHASH,
                    att.orderId,
                    att.phase,
                    att.actor,
                    att.lat,
                    att.lon,
                    att.timestamp
                )
            )
        );
        require(ECDSA.recover(digest, sig) == att.actor, "bad-signature");
    }

    function _requireFresh(uint64 ts) internal view {
        require(ts + attestationMaxAgeSecs >= block.timestamp, "attestation-stale");
        require(ts <= block.timestamp + attestationFutureSkewSecs, "attestation-future");
    }

    /// @notice EIP-712 domain separator for client-side signing.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
