// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "../lib/GeoLib.sol";

/// Test-only harness exposing GeoLib's internal functions.
contract GeoHarness {
    function cosMicroDeg(int32 microDeg) external pure returns (int256) {
        return GeoLib.cosMicroDeg(microDeg);
    }

    function distanceSquaredMeters(
        int32 lat1,
        int32 lon1,
        int32 lat2,
        int32 lon2
    ) external pure returns (uint256) {
        return GeoLib.distanceSquaredMeters(lat1, lon1, lat2, lon2);
    }

    function withinRadius(
        int32 lat1,
        int32 lon1,
        int32 lat2,
        int32 lon2,
        uint256 radiusMeters
    ) external pure returns (bool) {
        return GeoLib.withinRadius(lat1, lon1, lat2, lon2, radiusMeters);
    }

    function requireValid(int32 lat, int32 lon) external pure {
        GeoLib.requireValid(lat, lon);
    }
}
