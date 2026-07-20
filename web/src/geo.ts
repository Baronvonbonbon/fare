// Geolocation → microdegree fixed-point (the contract's coordinate format).

export interface MicroDeg {
  lat: number;
  lon: number;
}

export function toMicroDeg(latDeg: number, lonDeg: number): MicroDeg {
  return { lat: Math.round(latDeg * 1e6), lon: Math.round(lonDeg * 1e6) };
}

export function fromMicroDeg(m: MicroDeg): { lat: number; lon: number } {
  return { lat: m.lat / 1e6, lon: m.lon / 1e6 };
}

export function fmtCoord(m: MicroDeg): string {
  const { lat, lon } = fromMicroDeg(m);
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/// Current device position in microdegrees. High accuracy — this feeds a
/// signed on-chain attestation, so we want the GPS fix, not the IP guess.
export function getPosition(): Promise<MicroDeg> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation unavailable in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toMicroDeg(pos.coords.latitude, pos.coords.longitude)),
      (err) => reject(new Error(`Geolocation failed: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 }
    );
  });
}

/// Human distance: metres under 1 km, else 1-decimal km.
export function fmtDist(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

/// Haversine distance in meters — client-side preview of what the contract
/// will conclude (the contract uses an equirectangular approximation; at
/// geofence ranges they agree to well under 1%).
export function distanceMeters(a: MicroDeg, b: MicroDeg): number {
  const R = 6371000;
  const toRad = (u: number) => (u / 1e6) * (Math.PI / 180);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
