"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";

const Globe = dynamic(() => import("react-globe.gl"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000008",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            border: "2px solid rgba(34,211,238,0.4)",
            margin: "0 auto 16px",
            animation: "spin 1.5s linear infinite",
          }}
        />
        <p
          style={{
            color: "rgba(34,211,238,0.7)",
            fontFamily: "monospace",
            fontSize: 11,
            letterSpacing: "0.3em",
            textTransform: "uppercase",
          }}
        >
          Initialising Globe
        </p>
      </div>
    </div>
  ),
});

const API = "http://127.0.0.1:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SatPoint {
  norad_id: string;
  name: string;
  lat: number;
  lon: number;
  alt: number;
  speed: number;
  category?: string;
  riskLevel: "HIGH" | "MEDIUM" | "NONE";
}

interface OrbitPoint {
  lat: number;
  lon: number;
  alt: number;
}

interface ConjArc {
  sat1_name: string;
  sat2_name: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  risk: "HIGH" | "MEDIUM" | "LOW";
  distance: number;
  layer?: string;
}

interface ConjunctionEvent {
  sat1: string;
  sat2: string;
  sat1_name: string;
  sat2_name: string;
  risk: "HIGH" | "MEDIUM" | "LOW";
  distance: number;
}

interface ProximityPair {
  sat1: string;
  sat1_name: string;
  sat1_lat: number;
  sat1_lon: number;
  sat2: string;
  sat2_name: string;
  sat2_lat: number;
  sat2_lon: number;
  distance: number;
  risk: "HIGH" | "MEDIUM" | "LOW";
}

interface PathDatum {
  pts: [number, number, number][];
  type: "grid" | "orbit" | "track";
}

export interface Props {
  selectedNoradId: string | null;
  onSelectSatellite: (norad_id: string, name: string) => void;
  flyToSatellite: (norad_id: string) => void;
}

// ── Colour helpers ────────────────────────────────────────────────────────────

function getSatColor(s: SatPoint, selectedId: string | null): string {
  if (s.norad_id === selectedId) return "#ffffff";
  if (s.riskLevel === "HIGH") return "#ef4444";
  if (s.riskLevel === "MEDIUM") return "#fbbf24";
  const cat = (s.category ?? "").toLowerCase();
  if (cat === "stations") return "#22d3ee";
  if (cat === "starlink") return "#a5b4fc";
  if (cat === "debris") return "#f87171";
  if (cat === "oneweb") return "#fb923c";
  if (cat === "planet") return "#c084fc";
  if (cat === "spire") return "#34d399";
  return "#4ade80";
}

// ── Stable Globe prop accessors (module-level, never change reference) ────────

const PATH_COLOR_FN = (d: object) => {
  const t = (d as PathDatum).type;
  if (t === "grid") return "rgba(80,140,255,0.07)";
  if (t === "orbit") return "rgba(255,165,40,0.13)";
  return "rgba(0,240,255,0.9)";
};

const PATH_STROKE_FN = (d: object) => {
  const t = (d as PathDatum).type;
  if (t === "grid") return 0.2;
  if (t === "orbit") return 0.45;
  return 1.4;
};

const PATH_DASH_LENGTH_FN = (d: object) =>
  (d as PathDatum).type === "track" ? 0.06 : 0;

const PATH_DASH_GAP_FN = (d: object) =>
  (d as PathDatum).type === "track" ? 0.04 : 0;

const PATH_DASH_ANIMATE_FN = (d: object) =>
  (d as PathDatum).type === "track" ? 2000 : 0;

const RING_COLOR_FN = (d: object) =>
  (d as any).isSelection
    ? "rgba(255,255,255,0.7)"
    : "rgba(239,68,68,0.65)";

const ARC_COLOR_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return "rgba(74,222,128,0.35)";
  if (a.risk === "MEDIUM") return "rgba(251,191,36,0.80)";
  return a.layer === "glow"
    ? "rgba(239,68,68,0.18)"
    : "rgba(239,68,68,0.9)";
};

const ARC_STROKE_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return 0.4;
  if (a.risk === "MEDIUM") return 0.9;
  return a.layer === "glow" ? 2.0 : 1.2;
};

const ARC_ALT_AUTO_SCALE_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return 0.12;
  if (a.risk === "MEDIUM") return 0.22;
  return 0.32;
};

const ARC_DASH_LENGTH_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return 1;
  if (a.risk === "MEDIUM") return 0.7;
  return a.layer === "glow" ? 1 : 0.5;
};

const ARC_DASH_GAP_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return 0;
  if (a.risk === "MEDIUM") return 0.2;
  return a.layer === "glow" ? 0 : 0.3;
};

const ARC_DASH_ANIMATE_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.risk === "LOW") return 6000;
  if (a.risk === "MEDIUM") return 3500;
  return 2000;
};

const ARC_LABEL_FN = (d: object) => {
  const a = d as ConjArc;
  if (a.layer === "glow") return "";
  return `<div style="background:rgba(8,0,0,0.95);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:7px 11px;font-family:ui-monospace,monospace;font-size:11px;pointer-events:none">
    <div style="color:${a.risk === "HIGH" ? "#ef4444" : a.risk === "MEDIUM" ? "#fbbf24" : "#4ade80"};font-weight:700;margin-bottom:4px">⚠ ${a.risk}</div>
    <div style="color:#94a3b8">${a.sat1_name}</div>
    <div style="color:#475569;font-size:9px">↕ ${a.distance.toFixed(1)} km</div>
    <div style="color:#94a3b8">${a.sat2_name}</div>
  </div>`;
};

// ── Spatial index for fast nearest-neighbor lookup on globe click ─────────────

interface GridCell {
  sats: SatPoint[];
}

function buildGrid(points: SatPoint[], cellSize = 5): Map<string, GridCell> {
  const grid = new Map<string, GridCell>();
  for (const s of points) {
    const cx = Math.floor(s.lat / cellSize);
    const cy = Math.floor(s.lon / cellSize);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, { sats: [] });
    grid.get(key)!.sats.push(s);
  }
  return grid;
}

function findNearestInGrid(
  grid: Map<string, GridCell>,
  lat: number,
  lon: number,
  cellSize = 5,
  maxRadius = 3,
): SatPoint | null {
  const cx = Math.floor(lat / cellSize);
  const cy = Math.floor(lon / cellSize);
  const toRad = (d: number) => (d * Math.PI) / 180;

  let best: SatPoint | null = null;
  let bestDist = Infinity;

  for (let dx = -maxRadius; dx <= maxRadius; dx++) {
    for (let dy = -maxRadius; dy <= maxRadius; dy++) {
      const key = `${cx + dx},${cy + dy}`;
      const cell = grid.get(key);
      if (!cell) continue;

      for (const s of cell.sats) {
        const dLat = toRad(s.lat - lat);
        const dLon = toRad(s.lon - lon);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(lat)) *
            Math.cos(toRad(s.lat)) *
            Math.sin(dLon / 2) ** 2;
        const dist = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (dist < bestDist) {
          bestDist = dist;
          best = s;
        }
      }
    }
  }

  return bestDist < 0.05 ? best : null;
}

// ── Orbit geometry helpers ────────────────────────────────────────────────────

function buildOrbitRing(
  inclDeg: number,
  altKm: number,
  raanDeg = 0,
): [number, number, number][] {
  const i = (inclDeg * Math.PI) / 180;
  const Ω = (raanDeg * Math.PI) / 180;
  // Keep altitude very small — just above the globe surface
  const alt = Math.max(0.01, Math.min(0.12, (altKm / 6371) * 0.5));
  const pts: [number, number, number][] = [];
  for (let deg = 0; deg <= 362; deg += 2) {
    const θ = (deg * Math.PI) / 180;
    const x =
      Math.cos(Ω) * Math.cos(θ) - Math.sin(Ω) * Math.cos(i) * Math.sin(θ);
    const y =
      Math.sin(Ω) * Math.cos(θ) + Math.cos(Ω) * Math.cos(i) * Math.sin(θ);
    const z = Math.sin(i) * Math.sin(θ);
    const lat = (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI;
    const lon = (Math.atan2(y, x) * 180) / Math.PI;
    pts.push([lat, lon, alt]);
  }
  return pts;
}

function splitAnti(
  pts: [number, number, number][],
): [number, number, number][][] {
  const segs: [number, number, number][][] = [];
  let cur: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && Math.abs(pts[i][1] - pts[i - 1][1]) > 90) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    }
    cur.push(pts[i]);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

function splitOrbitTrack(pts: OrbitPoint[]): OrbitPoint[][] {
  const segs: OrbitPoint[][] = [];
  let cur: OrbitPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && Math.abs(pts[i].lon - pts[i - 1].lon) > 90) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    }
    cur.push(pts[i]);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// ── Static geometry (module-level, computed once) ─────────────────────────────

const GRATICULE: [number, number, number][][] = (() => {
  const lines: [number, number, number][][] = [];
  for (let lat = -80; lat <= 80; lat += 20) {
    const seg: [number, number, number][] = [];
    for (let lon = -180; lon <= 178; lon += 3) seg.push([lat, lon, 0]);
    lines.push(seg);
  }
  for (let lon = -180; lon <= 180; lon += 30) {
    const seg: [number, number, number][] = [];
    for (let lat = -88; lat <= 88; lat += 3) seg.push([lat, lon, 0]);
    lines.push(seg);
  }
  return lines;
})();

const ORBIT_RINGS: [number, number, number][][] = (() => {
  const rings: [number, number, number][][] = [];
  const cfgs: [number, number, number][] = [
    [51.6, 420, 0],
    [51.6, 420, 90],
    [51.6, 420, 180],
    [42.0, 400, 45],
    [42.0, 400, 135],
    [53.0, 550, 0],
    [53.0, 550, 60],
    [53.0, 550, 120],
    [28.5, 550, 0],
    [28.5, 550, 120],
    [28.5, 550, 240],
    [97.0, 600, 0],
    [97.0, 600, 60],
    [97.0, 600, 120],
  ];
  for (const [incl, alt, raan] of cfgs) {
    rings.push(...splitAnti(buildOrbitRing(incl, alt, raan)));
  }
  return rings;
})();

// ── Component ─────────────────────────────────────────────────────────────────

export function GlobeView({ selectedNoradId, onSelectSatellite, flyToSatellite }: Props) {
  const globeRef = useRef<any>(null);

  // Use window dimensions directly — globe is always full screen
  const [dims, setDims] = useState({ w: 1280, h: 800 });
  const [loading, setLoading] = useState(true);
  const [satPoints, setSatPoints] = useState<SatPoint[]>([]);
  const [orbitTrack, setOrbitTrack] = useState<OrbitPoint[][]>([]);
  const [conjArcs, setConjArcs] = useState<ConjArc[]>([]);
  const [conjCount, setConjCount] = useState(0);

  // ── Hover state for satellite dots ────────────────────────────────────────
  const [hoveredSat, setHoveredSat] = useState<SatPoint | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const hoveredSatRef = useRef<SatPoint | null>(null);

  // ── Window resize — globe fills the whole viewport (debounced via rAF) ──────
  useEffect(() => {
    let rafId: number | undefined;
    const update = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setDims({ w: window.innerWidth, h: window.innerHeight });
        rafId = undefined;
      });
    };
    window.addEventListener("resize", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // ── Data fetch helpers ─────────────────────────────────────────────────────

  const fetchConjunctions = useCallback(async (): Promise<
    ConjunctionEvent[]
  > => {
    try {
      const r = await fetch(`${API}/conjunctions?limit=200`);
      return r.ok ? ((await r.json()).events ?? []) : [];
    } catch {
      return [];
    }
  }, []);

  const fetchProximity = useCallback(async (): Promise<ProximityPair[]> => {
    try {
      const r = await fetch(`${API}/proximity?limit=300`);
      return r.ok ? ((await r.json()).pairs ?? []) : [];
    } catch {
      return [];
    }
  }, []);

  const fetchPositions = useCallback(
    async (conjEvents: ConjunctionEvent[]) => {
      try {
        const r = await fetch(`${API}/positions/all`);
        if (!r.ok) return;
        const data = await r.json();

        // Build risk map from conjunction events
        const riskMap: Record<string, "HIGH" | "MEDIUM"> = {};
        for (const ev of conjEvents) {
          if (ev.risk === "LOW") continue;
          const up = (id: string) => {
            if (
              !riskMap[id] ||
              (ev.risk === "HIGH" && riskMap[id] === "MEDIUM")
            )
              riskMap[id] = ev.risk as "HIGH" | "MEDIUM";
          };
          up(ev.sat1);
          up(ev.sat2);
        }

        const posById: Record<string, { lat: number; lon: number }> = {};
        for (const s of data.satellites) posById[s.norad_id] = s;

        // Build arcs from stored conjunctions
        let arcs: ConjArc[] = [];
        for (const ev of conjEvents) {
          const p1 = posById[ev.sat1],
            p2 = posById[ev.sat2];
          if (!p1 || !p2) continue;
          arcs.push({
            sat1_name: ev.sat1_name,
            sat2_name: ev.sat2_name,
            startLat: p1.lat,
            startLng: p1.lon,
            endLat: p2.lat,
            endLng: p2.lon,
            risk: ev.risk,
            distance: ev.distance,
          });
        }

        // Fallback: proximity pairs for visual arcs
        if (arcs.length === 0) {
          const prox = await fetchProximity();
          arcs = prox.map((pp) => ({
            sat1_name: pp.sat1_name,
            sat2_name: pp.sat2_name,
            startLat: pp.sat1_lat,
            startLng: pp.sat1_lon,
            endLat: pp.sat2_lat,
            endLng: pp.sat2_lon,
            risk: pp.risk,
            distance: pp.distance,
          }));
        }

        setConjArcs(arcs);
        setConjCount(conjEvents.length);
        setSatPoints(
          data.satellites.map((s: any) => ({
            ...s,
            riskLevel: riskMap[s.norad_id] ?? "NONE",
          })),
        );
        setLoading(false);
      } catch {
        /* ignore */
      }
    },
    [fetchProximity],
  );

  const fetchOrbit = useCallback(async (noradId: string) => {
    try {
      const r = await fetch(`${API}/orbit/${noradId}?hours=2&step=30`);
      if (!r.ok) {
        setOrbitTrack([]);
        return;
      }
      const data = await r.json();
      setOrbitTrack(splitOrbitTrack(data.track ?? []));
    } catch {
      setOrbitTrack([]);
    }
  }, []);

  // ── Main data loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const conj = await fetchConjunctions();
      if (!cancelled) await fetchPositions(conj);
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchPositions, fetchConjunctions]);

  useEffect(() => {
    if (selectedNoradId) fetchOrbit(selectedNoradId);
    else setOrbitTrack([]);
  }, [selectedNoradId, fetchOrbit]);

  // ── Camera fly-to ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!globeRef.current || !selectedNoradId) return;
    const sat = satPoints.find((s) => s.norad_id === selectedNoradId);
    if (sat)
      globeRef.current.pointOfView(
        { lat: sat.lat, lng: sat.lon, altitude: 1.8 },
        1200,
      );
  }, [selectedNoradId, satPoints]);

  // ── Derived data ───────────────────────────────────────────────────────────

  // Spatial grid for O(1) nearest-neighbor on globe click
  const satGrid = useMemo(() => buildGrid(satPoints), [satPoints]);

  // ── LOD: Adjust point radius based on camera altitude ─────────────────────
  const [cameraAltitude, setCameraAltitude] = useState(2.5);
  const cameraAltRef = useRef(2.5);
  const [cameraPos, setCameraPos] = useState({ lat: 0, lng: 0 });
  const cameraPosRef = useRef({ lat: 0, lng: 0 });

  // Track camera state by polling the Three.js camera directly
  useEffect(() => {
    let rafId: number;

    const toLatLng = (x: number, y: number, z: number) => {
      const r = Math.sqrt(x * x + y * y + z * z);
      const lat = (Math.asin(y / r) * 180) / Math.PI;
      const lng = (Math.atan2(-z, x) * 180) / Math.PI;
      const alt = r - 1; // globe radius = 1
      return { lat, lng, alt };
    };

    const poll = () => {
      if (globeRef.current) {
        const camera = globeRef.current.camera();
        if (camera) {
          const { lat, lng, alt } = toLatLng(
            camera.position.x,
            camera.position.y,
            camera.position.z
          );

          if (
            Math.abs(alt - cameraAltRef.current) > 0.01 ||
            Math.abs(lat - cameraPosRef.current.lat) > 0.1 ||
            Math.abs(lng - cameraPosRef.current.lng) > 0.1
          ) {
            cameraAltRef.current = alt;
            cameraPosRef.current = { lat, lng };
            setCameraAltitude(alt);
            setCameraPos({ lat, lng });
          }
        }
      }
      rafId = requestAnimationFrame(poll);
    };

    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // LOD-filtered satellites: only render visible ones based on camera position
  const lodPoints = useMemo(() => {
    if (satPoints.length === 0) return [];

    const camAlt = cameraAltRef.current;
    const camLat = cameraPosRef.current.lat;
    const camLng = cameraPosRef.current.lng;

    // Calculate visible cone angle based on altitude
    const visibleAngle = Math.min(90, 30 + camAlt * 25);
    const cosMaxDist = Math.cos((visibleAngle * Math.PI) / 180);

    const camLatRad = (camLat * Math.PI) / 180;
    const camLngRad = (camLng * Math.PI) / 180;
    const sinCamLat = Math.sin(camLatRad);
    const cosCamLat = Math.cos(camLatRad);

    const result: SatPoint[] = [];

    for (const s of satPoints) {
      if (
        s.norad_id === selectedNoradId ||
        s.riskLevel === "HIGH" ||
        s.riskLevel === "MEDIUM"
      ) {
        result.push(s);
        continue;
      }

      const satLatRad = (s.lat * Math.PI) / 180;
      const satLngRad = (s.lon * Math.PI) / 180;

      const dot =
        sinCamLat * Math.sin(satLatRad) +
        cosCamLat * Math.cos(satLatRad) * Math.cos(satLngRad - camLngRad);

      if (dot > cosMaxDist) {
        result.push(s);
      }
    }

    return result;
  }, [satPoints, selectedNoradId, cameraAltitude, cameraPos.lat, cameraPos.lng]);

  // Point radius scales with zoom level
  const pointRadius = useMemo(() => {
    const alt = cameraAltRef.current;
    // Closer = smaller dots, farther = larger dots (but capped)
    return Math.max(0.12, Math.min(0.35, 0.15 + alt * 0.08));
  }, [cameraAltitude]);

  // ── Hover handling — onPointHover (globe.gl) + global mouse tracking ──────
  const lastHoverTimeRef = useRef(0);
  const lastHoveredIdRef = useRef<string | null>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });

  // Track mouse globally so we have pixel coords when onPointHover fires
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  const handlePointHover = useCallback(
    (sat: object | null) => {
      const now = Date.now();
      if (now - lastHoverTimeRef.current < 100) return;
      lastHoverTimeRef.current = now;

      if (!sat) {
        if (lastHoveredIdRef.current) {
          lastHoveredIdRef.current = null;
          setHoveredSat(null);
          setHoverPos(null);
        }
        return;
      }

      const s = sat as SatPoint;
      if (lastHoveredIdRef.current !== s.norad_id) {
        lastHoveredIdRef.current = s.norad_id;
        setHoveredSat(s);
        setHoverPos({ x: mousePosRef.current.x + 16, y: mousePosRef.current.y - 10 });
      }
    },
    [],
  );

  // ALL satellites as merged points (fast, no interaction — just the particle cloud)
  // pointAltitude = 0 means dots sit flat ON the surface — no cylinders/spikes
  // lodPoints filters to only visible satellites for performance
  const mergedPoints = lodPoints;

  // Clickable overlay: only selected + risk satellites (small set, merge=false)
  const interactivePoints = useMemo(
    () =>
      satPoints.filter(
        (s) => s.norad_id === selectedNoradId || s.riskLevel !== "NONE",
      ),
    [satPoints, selectedNoradId],
  );

  // Danger rings on HIGH-risk sats — only rebuild when the SET of HIGH-risk NORAD IDs changes
  const prevHighRiskIdsRef = useRef<Set<string>>(new Set());
  const dangerRingsRef = useRef<Array<{ lat: number; lng: number; maxR: number; propagationSpeed: number; repeatPeriod: number }>>([]);

  const highRiskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of satPoints) {
      if (s.riskLevel === "HIGH") ids.add(s.norad_id);
    }
    return ids;
  }, [satPoints]);

  // Only rebuild rings when the set of HIGH-risk satellites actually changes
  if (
    highRiskIds.size !== prevHighRiskIdsRef.current.size ||
    ![...highRiskIds].every((id) => prevHighRiskIdsRef.current.has(id))
  ) {
    dangerRingsRef.current = satPoints
      .filter((s) => s.riskLevel === "HIGH")
      .map((s) => ({
        lat: s.lat,
        lng: s.lon,
        maxR: 3,
        propagationSpeed: 0.7,
        repeatPeriod: 1600,
      }));
    prevHighRiskIdsRef.current = highRiskIds;
  }
  const dangerRings = dangerRingsRef.current;

  // Paths: graticule + orbital shells + selected orbit track
  // Static geometry is pre-computed at module level, only orbit track changes
  const allPaths = useMemo<PathDatum[]>(() => {
    const paths: PathDatum[] = [];
    for (const seg of GRATICULE) paths.push({ pts: seg, type: "grid" });
    for (const seg of ORBIT_RINGS) paths.push({ pts: seg, type: "orbit" });
    for (const seg of orbitTrack) {
      const alt = 0.03; // thin line just above surface
      paths.push({
        pts: seg.map((p) => [p.lat, p.lon, alt] as [number, number, number]),
        type: "track",
      });
    }
    return paths;
  }, [orbitTrack]);

  // Arc layers — avoid duplicating HIGH-risk arcs as glow+core
  // Instead, use a single arc with layered rendering via the color/stroke accessors
  const arcData = useMemo<ConjArc[]>(() => {
    const hi = conjArcs.filter((a) => a.risk === "HIGH");
    const med = conjArcs.filter((a) => a.risk === "MEDIUM");
    const lo = conjArcs.filter((a) => a.risk === "LOW");
    return [
      ...lo,
      ...med,
      ...hi.map((a) => ({ ...a, layer: "glow" })),
      ...hi.map((a) => ({ ...a, layer: "core" })),
    ];
  }, [conjArcs]);

  const highCount = useMemo(
    () => conjArcs.filter((a) => a.risk === "HIGH").length,
    [conjArcs],
  );

  // ── Loading screen ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#000008",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <div style={{ position: "relative", width: 72, height: 72 }}>
          {[0, 200, 400].map((delay) => (
            <div
              key={delay}
              style={{
                position: "absolute",
                inset: delay / 20,
                borderRadius: "50%",
                border: `1px solid rgba(34,211,238,${0.6 - delay / 1000})`,
                animation: `ping 1.5s ${delay}ms cubic-bezier(0,0,0.2,1) infinite`,
              }}
            />
          ))}
          <div
            style={{
              position: "absolute",
              inset: 28,
              borderRadius: "50%",
              background: "#22d3ee",
              animation: "pulse 2s infinite",
            }}
          />
        </div>
        <p
          style={{
            color: "rgba(34,211,238,0.75)",
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            letterSpacing: "0.35em",
            textTransform: "uppercase",
          }}
        >
          Initialising Globe
        </p>
        <style>{`
          @keyframes ping {
            75%, 100% { transform: scale(2); opacity: 0; }
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}</style>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#000008",
      }}
    >
      <Globe
        ref={globeRef}
        width={dims.w}
        height={dims.h}
        // ── Earth
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
        bumpImageUrl="//unpkg.com/three-globe/example/img/earth-topology.png"
        backgroundImageUrl="//unpkg.com/three-globe/example/img/night-sky.png"
        atmosphereColor="#1059d5"
        atmosphereAltitude={0.18}
        // ── Graticule + orbital shell rings + orbit track
        pathsData={allPaths}
        pathPoints={(d: object) => (d as PathDatum).pts}
        pathColor={PATH_COLOR_FN}
        pathStroke={PATH_STROKE_FN}
        pathDashLength={PATH_DASH_LENGTH_FN}
        pathDashGap={PATH_DASH_GAP_FN}
        pathDashAnimateTime={PATH_DASH_ANIMATE_FN}
        pathTransitionDuration={0}
        // ── MERGED particle cloud — ALL 17k sats, altitude=0, no cylinders
        // pointsMerge=true merges into one THREE mesh: tiny flat circles,
        // zero altitude means they sit ON the globe surface like dots.
        pointsData={mergedPoints}
        pointLat="lat"
        pointLng="lon"
        pointAltitude={0}
        pointColor={(d: object) => getSatColor(d as SatPoint, selectedNoradId)}
        pointRadius={pointRadius}
        pointResolution={4}
        pointsMerge={false}
        onPointHover={handlePointHover}
        // ── INTERACTIVE overlay — risk/selected sats only (merge=false → clickable)
        // We render these on top of the merged layer at slight altitude so they
        // are always visible and can receive click/hover events.
        // (react-globe.gl supports only ONE pointsData layer, so we use
        //  the rings layer as a proxy hover indicator — clicks handled via
        //  the rings/custom mechanism below)
        // NOTE: We use ringsData for selection indication (no extra layer needed).

        // ── Pulsing rings on HIGH-risk satellites
        ringsData={[
          ...dangerRings,
          // Hover ring for the currently-hovered satellite
          ...(hoveredSat
            ? [{
                lat: hoveredSat.lat,
                lng: hoveredSat.lon,
                maxR: 1.5,
                propagationSpeed: 1.5,
                repeatPeriod: 800,
              }]
            : []),
          // Selection ring for the currently-selected satellite
          ...(selectedNoradId
            ? satPoints
                .filter((s) => s.norad_id === selectedNoradId)
                .map((s) => ({
                  lat: s.lat,
                  lng: s.lon,
                  maxR: 2.5,
                  propagationSpeed: -0.5,
                  repeatPeriod: 2000,
                  isSelection: true,
                }))
            : []),
        ]}
        ringLat="lat"
        ringLng="lng"
        ringMaxRadius="maxR"
        ringPropagationSpeed="propagationSpeed"
        ringRepeatPeriod="repeatPeriod"
        ringColor={RING_COLOR_FN}
        ringResolution={48}
        ringAltitude={0.001}
        // ── Conjunction arcs
        arcsData={arcData}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor={ARC_COLOR_FN}
        arcStroke={ARC_STROKE_FN}
        arcAltitudeAutoScale={ARC_ALT_AUTO_SCALE_FN}
        arcDashLength={ARC_DASH_LENGTH_FN}
        arcDashGap={ARC_DASH_GAP_FN}
        arcDashAnimateTime={ARC_DASH_ANIMATE_FN}
        arcLabel={ARC_LABEL_FN}
        // ── Globe click → pick nearest satellite using spatial grid ─────────
        onGlobeClick={({ lat, lng }: { lat: number; lng: number }) => {
          const nearest = findNearestInGrid(satGrid, lat, lng);
          if (nearest) {
            onSelectSatellite(nearest.norad_id, nearest.name);
          }
        }}
        enablePointerInteraction={true}
        animateIn={false}
      />

      {/* ── Tracked objects counter ─────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 80,
          left: 20,
          zIndex: 10,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: "6px 12px",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#4ade80",
            flexShrink: 0,
            animation: "pulse 2s infinite",
          }}
        />
        <span style={{ fontSize: 11, color: "rgba(200,220,255,0.8)" }}>
          <span style={{ color: "#4ade80", fontWeight: 700 }}>
            {satPoints.length.toLocaleString()}
          </span>{" "}
          objects tracked
          {conjCount > 0 && (
            <>
              {" "}
              <span style={{ color: "rgba(255,255,255,0.2)" }}>|</span>{" "}
              <span style={{ color: "#f87171", fontWeight: 700 }}>
                {conjCount}
              </span>{" "}
              <span style={{ color: "rgba(248,113,113,0.7)" }}>
                conjunctions
              </span>
            </>
          )}
        </span>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      </div>

      {/* ── HIGH-risk banner ────────────────────────────────────────────── */}
      {highCount > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "rgba(69,10,10,0.9)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(239,68,68,0.5)",
            borderRadius: 9999,
            padding: "6px 18px",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#ef4444",
              flexShrink: 0,
              boxShadow: "0 0 6px #ef4444",
              animation: "pulse 1s infinite",
            }}
          />
          <span
            style={{
              color: "#fca5a5",
              fontWeight: 700,
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            {highCount} High-Risk Conjunction{highCount > 1 ? "s" : ""} Active
          </span>
        </div>
      )}

      {/* ── Satellite hover tooltip — conjunction-style card ─────────────── */}
      {hoveredSat && hoverPos && (() => {
        // Find if this satellite is part of any conjunction
        const conj = conjArcs.find(
          (a) =>
            a.sat1_name === hoveredSat.name ||
            a.sat2_name === hoveredSat.name
        );

        return (
          <div
            style={{
              position: "absolute",
              left: hoverPos.x + 16,
              top: hoverPos.y - 10,
              zIndex: 50,
              pointerEvents: "none",
              background: "rgba(8,0,0,0.95)",
              backdropFilter: "blur(12px)",
              border: `1px solid ${hoveredSat.riskLevel === "HIGH" ? "rgba(239,68,68,0.5)" : hoveredSat.riskLevel === "MEDIUM" ? "rgba(251,191,36,0.4)" : "rgba(34,211,238,0.3)"}`,
              borderRadius: 10,
              padding: "10px 14px",
              fontFamily: "ui-monospace, monospace",
              minWidth: 180,
              boxShadow: `0 0 20px ${hoveredSat.riskLevel === "HIGH" ? "rgba(239,68,68,0.15)" : hoveredSat.riskLevel === "MEDIUM" ? "rgba(251,191,36,0.1)" : "rgba(34,211,238,0.1)"}`,
            }}
          >
            {/* Risk header */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              {hoveredSat.riskLevel !== "NONE" && (
                <>
                  <span style={{ color: hoveredSat.riskLevel === "HIGH" ? "#ef4444" : "#fbbf24", fontSize: 12 }}>⚠</span>
                  <span style={{
                    color: hoveredSat.riskLevel === "HIGH" ? "#ef4444" : hoveredSat.riskLevel === "MEDIUM" ? "#fbbf24" : "#4ade80",
                    fontWeight: 700,
                    fontSize: 14,
                    letterSpacing: "0.05em",
                  }}>
                    {hoveredSat.riskLevel}
                  </span>
                </>
              )}
            </div>

            {/* Satellite name(s) */}
            {conj ? (
              <>
                <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                  {conj.sat1_name}
                </div>
                <div style={{ color: "#64748b", fontSize: 10, marginBottom: 4 }}>
                  ↕ {conj.distance.toFixed(1)} km
                </div>
                <div style={{ color: "#94a3b8", fontSize: 13, fontWeight: 600 }}>
                  {conj.sat2_name}
                </div>
              </>
            ) : (
              <>
                <div style={{ color: "#22d3ee", fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                  {hoveredSat.name}
                </div>
                <div style={{ color: "#64748b", fontSize: 10 }}>
                  NORAD {hoveredSat.norad_id}
                </div>
                <div style={{ color: "#475569", fontSize: 10, marginTop: 2 }}>
                  {hoveredSat.alt?.toFixed(1)} km · {hoveredSat.speed?.toFixed(2)} km/s
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── Drag hint ───────────────────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          bottom: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
          pointerEvents: "none",
          color: "rgba(255,255,255,0.15)",
          fontFamily: "ui-monospace, monospace",
          fontSize: 9,
          letterSpacing: "0.35em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
      >
        DRAG · SCROLL · CLICK SATELLITE
      </div>
    </div>
  );
}
