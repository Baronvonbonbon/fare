// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/// @title GeoLib
/// @notice Fixed-point geodesic helpers for on-chain proximity checks.
///
///         Coordinates are microdegrees (degrees × 10^6) stored as int32:
///         lat ∈ [-90_000_000, 90_000_000], lon ∈ [-180_000_000, 180_000_000].
///         One microdegree of latitude ≈ 0.111 m, so int32 gives ~11 cm
///         resolution — far below GPS accuracy.
///
///         Distance uses the equirectangular approximation:
///             dx = Δlon · cos(lat)
///             dy = Δlat
///             d² = (dx² + dy²) · METERS_PER_UDEG²
///         valid to well under 1% error at geofence scales (< a few km),
///         which is all a delivery proximity check needs. cos() uses the
///         Bhaskara I rational approximation (max error ≈ 0.16%) to avoid
///         storage lookup tables.
library GeoLib {
    /// One degree of latitude in meters (WGS-84 mean).
    uint256 internal constant METERS_PER_DEGREE = 111_320;
    int256 internal constant MICRO = 1_000_000;
    /// Scale used for the cosine fixed point.
    int256 internal constant COS_SCALE = 100_000;

    /// Region grid cell size in microdegrees (~0.5° ≈ 55 km). Coarse buckets
    /// for localized order discovery (see regionOf).
    int256 internal constant REGION_CELL = 500_000;

    error GeoInvalidLatitude(int32 lat);
    error GeoInvalidLongitude(int32 lon);

    function requireValid(int32 lat, int32 lon) internal pure {
        if (lat < -90_000_000 || lat > 90_000_000) revert GeoInvalidLatitude(lat);
        if (lon < -180_000_000 || lon > 180_000_000) revert GeoInvalidLongitude(lon);
    }

    /// @dev cos(x) for x in microdegrees via Bhaskara I:
    ///      cos(d°) = (32400 - 4d²) / (32400 + d²), d ∈ [-90, 90].
    ///      Input beyond ±90° is folded by symmetry (only |lat| ≤ 90 occurs).
    ///      Returns cos scaled by COS_SCALE.
    function cosMicroDeg(int32 microDeg) internal pure returns (int256) {
        int256 d = int256(microDeg);
        if (d < 0) d = -d;
        // Work in centidegrees (degrees × 100) so d² stays comfortably in range
        // while keeping ~0.01° input resolution, plenty for cos().
        int256 c = d / 10_000; // centidegrees, 0..9000
        // Bhaskara with degrees scaled by 100: constants scale by 100² = 10^4.
        int256 num = (324_000_000 - 4 * c * c) * COS_SCALE;
        int256 den = 324_000_000 + c * c;
        return num / den;
    }

    /// @notice Squared distance in m² between two coordinates.
    /// @dev Equirectangular; suitable for ranges up to a few km.
    function distanceSquaredMeters(
        int32 lat1,
        int32 lon1,
        int32 lat2,
        int32 lon2
    ) internal pure returns (uint256) {
        // Mean latitude for the cosine correction.
        int256 meanLat = (int256(lat1) + int256(lat2)) / 2;
        int256 cosLat = cosMicroDeg(int32(meanLat));

        int256 dLat = int256(lat2) - int256(lat1); // microdegrees
        int256 dLon = ((int256(lon2) - int256(lon1)) * cosLat) / COS_SCALE;

        // Convert microdegrees → meters: udeg * 111_320 / 1e6.
        int256 dyM = (dLat * int256(METERS_PER_DEGREE)) / MICRO;
        int256 dxM = (dLon * int256(METERS_PER_DEGREE)) / MICRO;

        return uint256(dxM * dxM + dyM * dyM);
    }

    /// @notice Coarse geographic region id for a coordinate, for localized
    ///         order discovery. Points in the same ~0.5° cell share a region.
    /// @dev    Truncated (toward zero) grid indices, hashed for a flat id.
    ///         Clients mirror this with Math.trunc(coord / REGION_CELL) and
    ///         keccak256(abi.encode(int256 latCell, int256 lonCell)).
    function regionOf(int32 lat, int32 lon) internal pure returns (bytes32) {
        int256 latCell = int256(lat) / REGION_CELL;
        int256 lonCell = int256(lon) / REGION_CELL;
        return keccak256(abi.encode(latCell, lonCell));
    }

    /// @notice True when the two points are within `radiusMeters` of each other.
    function withinRadius(
        int32 lat1,
        int32 lon1,
        int32 lat2,
        int32 lon2,
        uint256 radiusMeters
    ) internal pure returns (bool) {
        return distanceSquaredMeters(lat1, lon1, lat2, lon2) <= radiusMeters * radiusMeters;
    }
}
