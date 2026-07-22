// Tile-less proximity map: an equirectangular projection of venue pins around
// the viewer, drawn as inline SVG. No external tiles/fonts — keeps the app
// self-contained and offline-friendly (in step with the light-client ethos)
// and shows, at a glance, which nearby venues have open pickups.
import { MicroDeg } from "./geo";

export interface VenuePin {
  id: string;
  lat: number; // microdegrees
  lon: number;
  name: string;
  openCount: number;
}

const SIZE = 300;
const C = SIZE / 2;
const MARGIN = 26;

export function MiniMap({
  center,
  venues,
  radiusKm,
}: {
  center: MicroDeg;
  venues: VenuePin[];
  radiusKm: number;
}) {
  const cLatDeg = center.lat / 1e6;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((cLatDeg * Math.PI) / 180);

  // East/north metres from the viewer for each pin.
  const projected = venues.map((v) => ({
    v,
    dx: ((v.lon - center.lon) / 1e6) * mPerDegLon,
    dy: ((v.lat - center.lat) / 1e6) * mPerDegLat,
  }));

  // Fit the farthest pin (and the radius ring, when set) inside the viewport.
  const farthest = projected.reduce((m, p) => Math.max(m, Math.hypot(p.dx, p.dy)), 0);
  const range = Math.max(farthest, radiusKm > 0 ? radiusKm * 1000 : 0, 400) * 1.15;
  const scale = (C - MARGIN) / range; // px per metre
  const px = (dx: number) => C + dx * scale;
  const py = (dy: number) => C - dy * scale; // screen y is inverted
  const ringR = radiusKm > 0 ? radiusKm * 1000 * scale : 0;

  return (
    <div className="minimap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="nearby venues map">
        {/* range rings for scale */}
        <circle cx={C} cy={C} r={(C - MARGIN) * 0.5} className="mm-grid" />
        <circle cx={C} cy={C} r={C - MARGIN} className="mm-grid" />
        {ringR > 0 && ringR <= C - MARGIN + 1 && (
          <circle cx={C} cy={C} r={ringR} className="mm-radius" />
        )}
        {/* north tick */}
        <line x1={C} y1={6} x2={C} y2={16} className="mm-grid" />
        <text x={C} y={5} className="mm-n" textAnchor="middle">N</text>

        {/* venue pins */}
        {projected.map(({ v, dx, dy }) => {
          const x = px(dx);
          const y = py(dy);
          const hot = v.openCount > 0;
          return (
            <g key={v.id} className={hot ? "mm-pin hot" : "mm-pin"}>
              <title>{`${v.name} — ${v.openCount} open`}</title>
              <circle cx={x} cy={y} r={hot ? 7 : 4.5} />
              {hot && (
                <text x={x} y={y + 3} textAnchor="middle" className="mm-count">
                  {v.openCount}
                </text>
              )}
            </g>
          );
        })}

        {/* the viewer */}
        <circle cx={C} cy={C} r={5} className="mm-you" />
        <circle cx={C} cy={C} r={5} className="mm-you-ring" />
      </svg>
      <div className="mm-legend">
        <span><i className="mm-dot you" /> you</span>
        <span><i className="mm-dot hot" /> open pickups</span>
        <span><i className="mm-dot venue" /> venue</span>
        {radiusKm > 0 && <span><i className="mm-dot radius" /> {radiusKm} km</span>}
      </div>
    </div>
  );
}

/// Live-tracking map (B2): centered on the customer's door (drop), showing the
/// venue (pickup), the driver's current position, and a trace of where they've
/// been. Same tile-less SVG projection as MiniMap — the driver's location arrives
/// E2E over the channel and is rendered locally; it never touches the chain.
export function TrackMap({
  drop,
  venue,
  driver,
  trace = [],
}: {
  drop: MicroDeg;
  venue?: MicroDeg | null;
  driver?: MicroDeg | null;
  trace?: MicroDeg[];
}) {
  const cLatDeg = drop.lat / 1e6;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((cLatDeg * Math.PI) / 180);
  const proj = (p: MicroDeg) => ({
    dx: ((p.lon - drop.lon) / 1e6) * mPerDegLon,
    dy: ((p.lat - drop.lat) / 1e6) * mPerDegLat,
  });
  const marks = [venue, driver, ...trace].filter(Boolean).map((p) => proj(p as MicroDeg));
  const farthest = marks.reduce((m, p) => Math.max(m, Math.hypot(p.dx, p.dy)), 0);
  const range = Math.max(farthest, 400) * 1.15;
  const scale = (C - MARGIN) / range;
  const px = (dx: number) => C + dx * scale;
  const py = (dy: number) => C - dy * scale;
  const d = driver ? proj(driver) : null;
  const v = venue ? proj(venue) : null;
  const tracePts = trace.map(proj).map((p) => `${px(p.dx)},${py(p.dy)}`).join(" ");

  return (
    <div className="minimap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="driver tracking map">
        <circle cx={C} cy={C} r={(C - MARGIN) * 0.5} className="mm-grid" />
        <circle cx={C} cy={C} r={C - MARGIN} className="mm-grid" />
        <line x1={C} y1={6} x2={C} y2={16} className="mm-grid" />
        <text x={C} y={5} className="mm-n" textAnchor="middle">N</text>
        {trace.length > 1 && <polyline points={tracePts} fill="none" stroke="#b57bff" strokeWidth={2} strokeOpacity={0.55} />}
        {v && (
          <g className="mm-pin"><title>venue (pickup)</title><circle cx={px(v.dx)} cy={py(v.dy)} r={5} /></g>
        )}
        {d && (
          <g className="mm-pin hot"><title>driver</title><circle cx={px(d.dx)} cy={py(d.dy)} r={6.5} /></g>
        )}
        <circle cx={C} cy={C} r={5} className="mm-you" />
        <circle cx={C} cy={C} r={5} className="mm-you-ring" />
      </svg>
      <div className="mm-legend">
        <span><i className="mm-dot you" /> your door</span>
        <span><i className="mm-dot hot" /> driver</span>
        <span><i className="mm-dot venue" /> venue</span>
      </div>
    </div>
  );
}
