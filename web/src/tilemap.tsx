// Interactive tile map (MapLibre GL + OpenFreeMap dark vector tiles) for
// dropping a location pin and for the proximity view. MapLibre is dynamically
// imported so it stays out of the main bundle; tiles come from OpenFreeMap
// (open data, no API key, no cookies, no tracking). If the map can't load
// (offline / tiles blocked / light-client purity), we fall back to the
// self-contained SVG map / the GPS button, so nothing hard-breaks.
import { useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { MicroDeg, fmtCoord, getPosition, toMicroDeg } from "./geo";
import { MiniMap, VenuePin } from "./map";

const DARK_STYLE = "https://tiles.openfreemap.org/styles/dark";
const DEFAULT: [number, number] = [-122.4194, 37.7749]; // SF, if no GPS

const toLngLat = (m: MicroDeg): [number, number] => [m.lon / 1e6, m.lat / 1e6];
const fromLngLat = (l: { lng: number; lat: number }): MicroDeg => toMicroDeg(l.lat, l.lng);

const loadMaplibre = () => import("maplibre-gl").then((m) => m.default);

/// GeoJSON polygon approximating a `radiusKm` circle around `center`.
function circle(center: MicroDeg, radiusKm: number) {
  const lat = center.lat / 1e6;
  const lon = center.lon / 1e6;
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
  const ring: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [ring] }, properties: {} };
}

// ---- pin drop ----

/// Fullscreen overlay: pan/tap to drop a pin, confirm to return coordinates.
export function PinMap({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: MicroDeg | null;
  onConfirm: (m: MicroDeg) => void;
  onCancel: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [coord, setCoord] = useState<MicroDeg | null>(initial);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let map: any;
    let cancelled = false;
    (async () => {
      try {
        const maplibregl = await loadMaplibre();
        if (cancelled || !container.current) return;
        let center: [number, number];
        if (initial) center = toLngLat(initial);
        else {
          try {
            const p = await getPosition();
            center = toLngLat(p);
            setCoord(p);
          } catch {
            center = DEFAULT;
          }
        }
        map = new maplibregl.Map({ container: container.current, style: DARK_STYLE, center, zoom: 14 });
        const marker = new maplibregl.Marker({ color: "#ff2670", draggable: true }).setLngLat(center).addTo(map);
        marker.on("dragend", () => setCoord(fromLngLat(marker.getLngLat())));
        map.on("click", (e: any) => {
          marker.setLngLat(e.lngLat);
          setCoord(fromLngLat(e.lngLat));
        });
      } catch {
        setErr("Map couldn't load — use the GPS button instead.");
      }
    })();
    return () => {
      cancelled = true;
      if (map) map.remove();
    };
  }, [initial]);

  return (
    <div className="tilemap-overlay">
      <div className="tilemap-canvas" ref={container} />
      {err && <div className="tilemap-err">{err}</div>}
      <div className="tilemap-bar">
        <span className="mono">{coord ? fmtCoord(coord) : "tap the map to drop a pin"}</span>
        <span style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost small" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn small" disabled={!coord} onClick={() => coord && onConfirm(coord)}>
            Use this location
          </button>
        </span>
      </div>
    </div>
  );
}

// ---- proximity view ----

/// Tile map of nearby venues + radius, replacing the SVG MiniMap when tiles
/// are reachable (falls back to MiniMap otherwise). The map inits once; venue
/// markers and the radius update in place as data refreshes.
export function AreaMap({ center, venues, radiusKm }: { center: MicroDeg; venues: VenuePin[]; radiusKm: number }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const mlRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // init once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const maplibregl = await loadMaplibre();
        if (cancelled || !container.current) return;
        mlRef.current = maplibregl;
        const map = new maplibregl.Map({
          container: container.current,
          style: DARK_STYLE,
          center: toLngLat(center),
          zoom: 12,
        });
        map.on("load", () => {
          if (cancelled) return;
          mapRef.current = map;
          setReady(true);
        });
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      if (mapRef.current) mapRef.current.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (re)draw markers + radius on data change
  useEffect(() => {
    const map = mapRef.current;
    const maplibregl = mlRef.current;
    if (!ready || !map || !maplibregl) return;

    // radius circle
    const data = radiusKm > 0 ? circle(center, radiusKm) : { type: "FeatureCollection" as const, features: [] };
    if (map.getSource("radius")) {
      map.getSource("radius").setData(data as any);
    } else {
      map.addSource("radius", { type: "geojson", data: data as any });
      map.addLayer({ id: "radius-fill", type: "fill", source: "radius", paint: { "fill-color": "#07ffff", "fill-opacity": 0.06 } });
      map.addLayer({
        id: "radius-line",
        type: "line",
        source: "radius",
        paint: { "line-color": "#07ffff", "line-opacity": 0.5, "line-dasharray": [2, 2] },
      });
    }

    // markers: clear + rebuild
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const bounds = new maplibregl.LngLatBounds();
    const you = document.createElement("div");
    you.className = "map-you";
    markersRef.current.push(new maplibregl.Marker({ element: you }).setLngLat(toLngLat(center)).addTo(map));
    bounds.extend(toLngLat(center));
    for (const v of venues) {
      const el = document.createElement("div");
      el.className = v.openCount > 0 ? "map-venue hot" : "map-venue";
      if (v.openCount > 0) el.textContent = String(v.openCount);
      const ll: [number, number] = [v.lon / 1e6, v.lat / 1e6];
      markersRef.current.push(
        new maplibregl.Marker({ element: el })
          .setLngLat(ll)
          .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setText(`${v.name} · ${v.openCount} open`))
          .addTo(map)
      );
      bounds.extend(ll);
    }
    try {
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 44, maxZoom: 14, animate: false });
    } catch {
      /* single point / degenerate bounds */
    }
  }, [ready, center, venues, radiusKm]);

  if (failed) return <MiniMap center={center} venues={venues} radiusKm={radiusKm} />;
  return <div className="tilemap-area" ref={container} />;
}
