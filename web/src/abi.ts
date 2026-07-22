// Hand-maintained human-readable ABI fragments — only what the app calls.
// Keep in sync with contracts/ (source of truth: the Solidity files).

export const ORDERS_ABI = [
  "function nextOrderId() view returns (uint256)",
  "function orders(uint256) view returns (address customer, uint64 venueId, uint8 status, address driver, uint96 orderValue, uint96 tip, uint96 fare, uint96 maxFare, uint96 escrow, bytes32 dropCommit, uint64 createdAt, uint64 pickupWindowSecs, uint64 deliveryWindowSecs, uint64 pickupDeadline, uint64 deliveryDeadline)",
  "function biddersOf(uint256) view returns (address[])",
  "function bidOf(uint256, address) view returns (uint96)",
  "function createOrder(uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pickupWindowSecs, uint64 deliveryWindowSecs) payable returns (uint256)",
  "function placeBid(uint256 orderId, uint96 amount)",
  "function withdrawBid(uint256 orderId)",
  "function acceptBid(uint256 orderId, address driver) payable",
  "function increaseTip(uint256 orderId) payable",
  "function cancelOpen(uint256 orderId)",
  "function cancelAssigned(uint256 orderId)",
  "function abandonOrder(uint256 orderId)",
  // Discovery: enumerate orders per role from indexed topics instead of
  // scanning every id — by customer, by venue, or (for a driver's own jobs)
  // by assigned driver.
  "event OrderCreated(uint256 indexed orderId, address indexed customer, uint64 indexed venueId, uint96 orderValue, uint96 tip, uint96 maxFare, bytes32 dropCommit)",
  "event OrderAssigned(uint256 indexed orderId, address indexed driver, uint96 fare, uint64 pickupDeadline)",
  // region indexed FIRST → server-side filterable on Paseo (localized discovery)
  "event OrderRegion(bytes32 indexed region, uint256 indexed orderId)",
];

export const VENUES_ABI = [
  "function nextVenueId() view returns (uint64)",
  "function venues(uint64) view returns (address operator, address signer, address payout, int32 lat, int32 lon, bool active, uint32 pickups, string metadataURI)",
  "function registerVenue(int32 lat, int32 lon, address signer, address payout, string metadataURI) returns (uint64)",
  "function setActive(uint64 venueId, bool active)",
  "function setLocation(uint64 venueId, int32 lat, int32 lon)",
  "function setPayout(uint64 venueId, address payout)",
  "function setSigner(uint64 venueId, address signer)",
  "function setMetadata(uint64 venueId, string metadataURI)",
  // event-driven menu-update replication (F1)
  "event VenueMetadataUpdated(uint64 indexed venueId, string metadataURI)",
];

export const DRIVERS_ABI = [
  "function drivers(address) view returns (bool registered, bool banned, uint96 stake, uint64 unstakeRequestedAt, uint32 delivered, uint32 failed, string metadataURI)",
  "function isEligible(address) view returns (bool)",
  "function register(string metadataURI) payable",
  "function addStake() payable",
  "function requestUnstake()",
  "function withdrawStake()",
  "function setMetadata(string metadataURI)",
  "function minStake() view returns (uint96)",
  "function unbondingSeconds() view returns (uint64)",
];

export const SETTLEMENT_ABI = [
  "function confirmPickup((uint256 orderId, uint8 phase, address actor, int32 lat, int32 lon, uint64 timestamp) driverAtt, bytes driverSig, (uint256 orderId, uint8 phase, address actor, int32 lat, int32 lon, uint64 timestamp) venueAtt, bytes venueSig)",
  // ZK dropoff: no coordinates on-chain. Driver signs a Poseidon commitment to
  // their position; the customer submits a Groth16 proximity proof.
  // pubSignals = [orderId, dropCommit, driverCommit, radiusMeters, nullifier].
  "function confirmDropoffZK((uint256 orderId, uint8 phase, address actor, bytes32 posCommit, uint64 timestamp) driverAtt, bytes driverSig, bytes proof, uint256[5] pubSignals)",
  "function usedNullifiers(bytes32) view returns (bool)",
  "function pickupRadiusMeters() view returns (uint32)",
  "function dropoffRadiusMeters() view returns (uint32)",
];

export const VAULT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw()",
  "function withdrawTo(address recipient)",
  // gasless withdraw (F8): driver signs, relay submits withdrawFor
  "function withdrawNonce(address) view returns (uint256)",
  "function withdrawFor(address account, address recipient, uint256 deadline, bytes signature)",
  "function pendingPaseoDust(address) view returns (uint256)",
  "function claimPaseoDust()",
];

export const ROUTER_ABI = [
  "function currentAddrOf(bytes32) view returns (address)",
  "function versionOf(bytes32) view returns (uint64)",
];

export const RATINGS_ABI = [
  "function rate(uint256 orderId, uint8 driverStars, uint8 venueStars)",
  "function rated(uint256) view returns (bool)",
  "function driverRating(address) view returns (uint256 avgX100, uint256 count)",
  "function venueRating(uint64) view returns (uint256 avgX100, uint256 count)",
];

export const DISPUTES_ABI = [
  "function disputeBond() view returns (uint96)",
  "function openDispute(uint256 orderId, string evidenceURI) payable returns (uint256)",
  "function disputeOfOrder(uint256 orderId) view returns (uint256)",
  "function disputes(uint256) view returns (uint256 orderId, address opener, uint96 bond, uint8 status, string evidenceURI)",
  // Arbiter console (D1): queue enumeration + the ruling call.
  "function nextDisputeId() view returns (uint256)",
  "function arbiter() view returns (address)",
  "function treasury() view returns (address)",
  "function resolve(uint256 disputeId, uint16 customerShareBps, bool openerWins, bool driverAtFault, uint256 slashDriverAmount)",
  "event DisputeResolved(uint256 indexed disputeId, uint256 indexed orderId, uint16 customerShareBps, bool openerWins, uint256 driverSlashed)",
];
