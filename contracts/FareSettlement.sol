// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./lib/GeoLib.sol";
import "./lib/FareUpgradable.sol";
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
///         Dropoff privacy (ZK): the customer's drop coordinates NEVER touch
///         the chain — not calldata, not storage, not events. `confirmDropoffZK`
///         takes a Groth16 proof (circuits/proximity.circom) that, against the
///         Poseidon `dropCommit` published at order creation, the driver's
///         committed position is within `dropoffRadiusMeters` of the customer's
///         committed position. Both parties' coordinates are private circuit
///         witnesses. The adverse-interest model is preserved: the driver
///         ECDSA-signs a commitment to their OWN position (they won't sign a
///         false one that the proximity proof would then fail), and only the
///         customer can produce the proof (it needs the drop salt, which only
///         they hold) — so the proof is the customer's consent. See docs/GPS.md.
contract FareSettlement is Ownable2Step, EIP712, FareUpgradable {
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

    /// Signed by the driver at dropoff. Instead of plaintext coordinates the
    /// driver attests a Poseidon COMMITMENT to their position — the proximity
    /// proof binds against this without the coordinates ever going on-chain.
    struct DriverCommitAttestation {
        uint256 orderId;
        uint8 phase; // 2 = dropoff
        address actor; // driver
        bytes32 posCommit; // Poseidon(drvLatEnc, drvLonEnc, drvSalt)
        uint64 timestamp;
    }

    bytes32 public constant LOCATION_TYPEHASH =
        keccak256(
            "LocationAttestation(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp)"
        );
    bytes32 public constant DRIVER_COMMIT_TYPEHASH =
        keccak256(
            "DriverCommitAttestation(uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp)"
        );

    uint8 public constant PHASE_PICKUP = 1;
    uint8 public constant PHASE_DROPOFF = 2;

    IFareOrders public orders;
    IFareVenues public venues;
    IFareLocationVerifier public locationVerifier;
    IFarePauseRegistry public pauseRegistry;

    /// Poseidon(salt, orderId) → consumed. Single-use guard on the dropoff
    /// proof; a belt-and-suspenders complement to the status gate below.
    mapping(bytes32 => bool) public usedNullifiers;

    uint32 public pickupRadiusMeters = 150;
    uint32 public dropoffRadiusMeters = 100;
    uint64 public attestationMaxAgeSecs = 15 minutes;
    uint64 public attestationFutureSkewSecs = 5 minutes;

    /// No coordinates emitted. Driver position at pickup used to be emitted here,
    /// which made drivers' movements trivially indexable in bulk across jobs
    /// (docs/PRIVACY.md risk #2). The venue pin is public, so verification still
    /// happens against it in calldata — but the driver's coordinates are kept out
    /// of the log, and the client coarsens them before signing so the exact spot
    /// (~11 cm precision, risk #6) never lands in calldata either.
    event PickupConfirmed(
        uint256 indexed orderId,
        address indexed driver,
        address indexed venueSigner
    );
    /// No coordinates emitted — the ZK dropoff path keeps both parties'
    /// positions off-chain entirely (see docs/PRIVACY.md risk #2).
    event DropoffConfirmed(
        uint256 indexed orderId,
        address indexed driver,
        address indexed customer
    );
    event GeoParamsSet(uint32 pickupRadius, uint32 dropoffRadius, uint64 maxAge, uint64 futureSkew);
    event LocationVerifierSet(address indexed verifier);

    constructor(address _pauseRegistry) Ownable(msg.sender) EIP712("FareSettlement", "1") {
        pauseRegistry = IFarePauseRegistry(_pauseRegistry);
    }

    modifier whenNotPaused() {
        require(!pauseRegistry.isPaused(1), "paused"); // CAT_SETTLEMENT
        _;
    }

    // ---- wiring & params ----

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function configure(address _orders, address _venues) external onlyOwner {
        require(_orders != address(0) && _venues != address(0), "zero-addr");
        orders = IFareOrders(_orders);
        venues = IFareVenues(_venues);
    }

    /// @notice Wire the Groth16 proximity verifier. Kept separate from
    ///         `configure` so the verifier can be deployed after its trusted
    ///         setup, then bound (and re-bound to a fresh verifier if the VK
    ///         must ever be rotated — the verifier itself is lock-once).
    function setLocationVerifier(address _verifier) external onlyOwner {
        require(_verifier != address(0), "zero-addr");
        locationVerifier = IFareLocationVerifier(_verifier);
        emit LocationVerifierSet(_verifier);
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
    ) external whenNotPaused whenNotFrozen {
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

        // Geo: both parties within radius of the venue's registered (public) pin.
        // The driver's coordinates arrive coarsened (~33 m grid, client-side) —
        // far inside pickupRadiusMeters (default 150 m), so the check is
        // unaffected in practice while the exact spot never enters calldata.
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
        emit PickupConfirmed(orderId, driver, venueSigner);
    }

    /// @notice Zero-knowledge dropoff confirmation. NO coordinates go on-chain.
    ///
    ///         The driver ECDSA-signs a Poseidon commitment to their own
    ///         position (`driverAtt.posCommit`). The customer builds a Groth16
    ///         proof (circuits/proximity.circom) proving, entirely over private
    ///         witnesses, that:
    ///           - dropCommit  = Poseidon(their drop coords, salt)  [== on-chain commit]
    ///           - driverCommit = Poseidon(driver coords, drvSalt)  [== driverAtt.posCommit]
    ///           - dist(driver, customer) ≤ radiusMeters
    ///           - nullifier = Poseidon(salt, orderId)
    ///
    ///         This contract binds those public signals to the order, the
    ///         driver's signed commitment, and the governance radius, then
    ///         verifies the proof. Callable by anyone holding the proof + the
    ///         driver signature (relay-friendly).
    ///
    /// @param driverAtt  driver's signed commitment to their dropoff position
    /// @param driverSig  EIP-712 signature over driverAtt (recovers to driver)
    /// @param proof      256-byte ABI-encoded Groth16 proof
    /// @param pubSignals [orderId, dropCommit, driverCommit, radiusMeters, nullifier]
    function confirmDropoffZK(
        DriverCommitAttestation calldata driverAtt,
        bytes calldata driverSig,
        bytes calldata proof,
        uint256[5] calldata pubSignals
    ) external whenNotPaused whenNotFrozen {
        require(address(locationVerifier) != address(0), "no-verifier");
        uint256 orderId = driverAtt.orderId;
        require(pubSignals[0] == orderId, "order-mismatch");

        (address customer, address driver, ) = orders.partiesOf(orderId);
        require(orders.statusOf(orderId) == IFareOrders.Status.PickedUp, "bad-status");

        // Driver side: signed commitment to their own position.
        require(driverAtt.phase == PHASE_DROPOFF && driverAtt.actor == driver, "bad-driver-att");
        _verifyDriverCommitSig(driverAtt, driverSig);
        _requireFresh(driverAtt.timestamp);

        // Bind the public signals to on-chain truth.
        require(bytes32(pubSignals[1]) == orders.dropCommitOf(orderId), "commit-mismatch");
        require(bytes32(pubSignals[2]) == driverAtt.posCommit, "driver-commit-mismatch");
        require(pubSignals[3] == dropoffRadiusMeters, "radius-mismatch");

        // Single-use nullifier (the status gate already blocks replay; this is
        // an explicit, auditable second lock and matches the documented design).
        bytes32 nullifier = bytes32(pubSignals[4]);
        require(!usedNullifiers[nullifier], "nullifier-used");

        // The proof itself: proximity + both commitment openings, all private.
        require(locationVerifier.verifyProximity(proof, pubSignals), "bad-proof");

        usedNullifiers[nullifier] = true;
        orders.onDropoffConfirmed(orderId);
        emit DropoffConfirmed(orderId, driver, customer);
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

    function _verifyDriverCommitSig(DriverCommitAttestation calldata att, bytes calldata sig)
        internal
        view
    {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DRIVER_COMMIT_TYPEHASH,
                    att.orderId,
                    att.phase,
                    att.actor,
                    att.posCommit,
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
