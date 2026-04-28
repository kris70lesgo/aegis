"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { GlobeView } from "./components/GlobeView";

const API = "http://127.0.0.1:8000";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Satellite {
  norad_id: string;
  name: string;
  category?: string;
  last_updated: string;
}

interface Position {
  timestamp: string;
  eci: { x: number; y: number; z: number };
  velocity: { vx: number; vy: number; vz: number; speed_km_s: number };
  geo: { lat: number; lon: number; alt: number };
  distance_from_center_km: number;
  error: string | null;
}

interface ConjunctionEvent {
  sat1: string;
  sat1_name: string;
  sat2: string;
  sat2_name: string;
  tca: string;
  distance: number;
  velocity: number;
  risk: "HIGH" | "MEDIUM" | "LOW";
}

interface AIConjunctionAnalysis {
  risk_summary: string;
  recommendation: string;
  explanation: string;
}

interface SystemStatus {
  satellites: number;
  conjunctions: number;
  last_fetch_at: string | null;
  last_detect_at: string | null;
  runs_completed: number;
  auto_refresh_active: boolean;
  scheduler_running: boolean;
  next_scheduled: string | null;
}

interface CategoryInfo {
  name: string;
  count: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "soon";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtCoord(v: number, pos: string, neg: string) {
  return `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;
}

const RISK_STYLE = {
  HIGH: {
    pill: "bg-red-950 text-red-300 border-red-700",
    dot: "bg-red-400",
    card: "border-red-800/60 bg-red-950/30",
  },
  MEDIUM: {
    pill: "bg-yellow-950 text-yellow-300 border-yellow-700",
    dot: "bg-yellow-400",
    card: "border-yellow-800/50 bg-yellow-950/20",
  },
  LOW: {
    pill: "bg-zinc-800 text-zinc-400 border-zinc-700",
    dot: "bg-zinc-500",
    card: "border-zinc-800 bg-zinc-900/40",
  },
};

const CAT_COLOR: Record<string, string> = {
  starlink: "#818cf8",
  stations: "#22d3ee",
  active: "#4ade80",
  debris: "#f87171",
  oneweb: "#fb923c",
  planet: "#a78bfa",
  spire: "#34d399",
};

function catColor(cat?: string): string {
  if (!cat) return "#4ade80";
  return CAT_COLOR[cat.toLowerCase()] ?? "#4ade80";
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function Dot({ color }: { color: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse inline-block"
      style={{ background: color }}
    />
  );
}

function RiskPill({ risk }: { risk: "HIGH" | "MEDIUM" | "LOW" }) {
  const s = RISK_STYLE[risk];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest px-2 py-0.5 rounded-full border ${s.pill}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
      {risk}
    </span>
  );
}

function StatRow({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500">
        {label}
      </span>
      <span
        className={`font-mono text-xs font-semibold ${accent ? "text-cyan-300" : "text-zinc-200"}`}
      >
        {value}
        {unit && <span className="text-zinc-500 font-normal ml-1">{unit}</span>}
      </span>
    </div>
  );
}

function GlassPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-black/70 backdrop-blur-xl border border-white/10 rounded-2xl ${className}`}
    >
      {children}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Home() {
  // Core state
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [sysStatus, setSysStatus] = useState<SystemStatus | null>(null);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);

  // Selected satellite + position
  const [selected, setSelected] = useState<Satellite | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [posLoading, setPosLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Panels visibility
  const [showSatPanel, setShowSatPanel] = useState(false); // right satellite drawer
  const [showConjPanel, setShowConjPanel] = useState(false); // bottom conjunction list
  const [showSearch, setShowSearch] = useState(false); // search overlay

  // Search
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Satellite[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  // Conjunctions
  const [conjunctions, setConjunctions] = useState<ConjunctionEvent[]>([]);
  const [conjTotal, setConjTotal] = useState(0);
  const [riskFilter, setRiskFilter] = useState<"" | "HIGH" | "MEDIUM" | "LOW">(
    "",
  );
  const [loadingConj, setLoadingConj] = useState(false);

  // AI Analysis
  const [aiAnalysis, setAiAnalysis] = useState<AIConjunctionAnalysis | null>(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [selectedConj, setSelectedConj] = useState<ConjunctionEvent | null>(null);

  // Actions
  const [fetching, setFetching] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // ── Toasts ────────────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // ── Status polling ────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(`${API}/`),
        fetch(`${API}/status`),
        fetch(`${API}/satellites/categories`),
      ]);
      setBackendOk(r1.ok);
      if (r2.ok) setSysStatus(await r2.json());
      if (r3.ok) {
        const d = await r3.json();
        setCategories(d.categories ?? []);
      }
    } catch {
      setBackendOk(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 30_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // ── Conjunctions ──────────────────────────────────────────────────────────

  const loadConjunctions = useCallback(async (risk: string) => {
    setLoadingConj(true);
    try {
      const url = new URL(`${API}/conjunctions`);
      url.searchParams.set("limit", "200");
      if (risk) url.searchParams.set("risk", risk);
      const d = await (await fetch(url.toString())).json();
      setConjunctions(d.events ?? []);
      setConjTotal(d.total ?? 0);
    } catch {
      setConjunctions([]);
    } finally {
      setLoadingConj(false);
    }
  }, []);

  useEffect(() => {
    loadConjunctions(riskFilter);
  }, [riskFilter, loadConjunctions]);

  // ── AI Analysis ───────────────────────────────────────────────────────────────

  const fetchAIAnalysis = useCallback(async (conj: ConjunctionEvent) => {
    setLoadingAI(true);
    setSelectedConj(conj);
    setAiAnalysis(null);
    try {
      const res = await fetch(`${API}/ai/analyze-conjunction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sat1: conj.sat1_name,
          sat2: conj.sat2_name,
          distance_km: conj.distance,
          velocity_kms: conj.velocity,
          tca: conj.tca,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        setAiAnalysis(d);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingAI(false);
    }
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]);
      setSearchTotal(0);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const url = new URL(`${API}/satellites`);
        url.searchParams.set("limit", "50");
        url.searchParams.set("search", search.trim());
        const d = await (await fetch(url.toString())).json();
        setSearchResults(d.satellites ?? []);
        setSearchTotal(d.total ?? 0);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // ── Position polling ──────────────────────────────────────────────────────

  const fetchPosition = useCallback(async (norad_id: string) => {
    try {
      const res = await fetch(`${API}/position/${norad_id}`);
      if (res.ok) setPosition(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!selected) {
      setPosition(null);
      return;
    }
    setPosLoading(true);
    fetchPosition(selected.norad_id).finally(() => setPosLoading(false));
    pollRef.current = setInterval(() => fetchPosition(selected.norad_id), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selected, fetchPosition]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const triggerFetch = async () => {
    setFetching(true);
    try {
      const d = await (await fetch(`${API}/fetch`, { method: "POST" })).json();
      showToast(
        `Fetched ${d.total?.toLocaleString()} satellites — ${d.inserted} new, ${d.updated} updated`,
      );
      await fetchStatus();
    } catch {
      showToast("Failed to reach CelesTrak", false);
    } finally {
      setFetching(false);
    }
  };

  const runDetection = async () => {
    setDetecting(true);
    try {
      const d = await (await fetch(`${API}/detect`, { method: "POST" })).json();
      showToast(
        `${d.conjunctions_found} conjunctions found across ${d.satellites_analyzed} sats in ${d.elapsed_seconds}s`,
      );
      await Promise.all([loadConjunctions(riskFilter), fetchStatus()]);
    } catch {
      showToast("Detection failed", false);
    } finally {
      setDetecting(false);
    }
  };

  // ── Globe callbacks ───────────────────────────────────────────────────────

  const handleGlobeSelect = useCallback((norad_id: string, name: string) => {
    setSelected({ norad_id, name, last_updated: "" });
    setShowSatPanel(true);
    setShowConjPanel(false);
  }, []);

  const handleSelectFromSearch = useCallback((sat: Satellite) => {
    setSelected(sat);
    setShowSatPanel(true);
    setShowSearch(false);
    setSearch("");
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────

  const highCount = useMemo(
    () => conjunctions.filter((c) => c.risk === "HIGH").length,
    [conjunctions],
  );
  const totalSats = sysStatus?.satellites ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{ background: "#000008" }}
    >
      {/* ── Full-screen Globe — always 100vw × 100vh ── */}
      <div className="absolute inset-0 w-full h-full">
        <GlobeView
          selectedNoradId={selected?.norad_id ?? null}
          onSelectSatellite={handleGlobeSelect}
          flyToSatellite={(norad_id: string) => {
            const sat = searchResults.find((s) => s.norad_id === norad_id);
            if (sat) {
              setSelected(sat);
              setShowSatPanel(true);
              setShowConjPanel(false);
            }
          }}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          TOP BAR — overlays globe, pointer-events restored per child
      ════════════════════════════════════════════════════════════════════ */}
      <div className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-5 pt-4 pointer-events-none">
        {/* Left: logo + status */}
        <div className="flex items-center gap-3 pointer-events-auto">
          <GlassPanel className="flex items-center gap-3 px-4 py-2">
            {/* Satellite orbit icon */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              className="text-cyan-400 flex-shrink-0"
            >
              <circle
                cx="12"
                cy="12"
                r="3.5"
                stroke="currentColor"
                strokeWidth="2"
              />
              <ellipse
                cx="12"
                cy="12"
                rx="10"
                ry="3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="3 2"
              />
              <ellipse
                cx="12"
                cy="12"
                rx="10"
                ry="3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="3 2"
                transform="rotate(55 12 12)"
              />
            </svg>
            <span className="font-bold tracking-[0.2em] text-cyan-400 text-sm">
              AEGIS
            </span>
            <span className="w-px h-4 bg-white/10" />
            <span className="text-[10px] tracking-widest text-zinc-500 uppercase hidden sm:block">
              Space Situational Awareness
            </span>
          </GlassPanel>

          {/* Backend indicator */}
          <GlassPanel className="px-3 py-2 flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                backendOk === null
                  ? "bg-zinc-500 animate-pulse"
                  : backendOk
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-red-500"
              }`}
            />
            <span
              className={`text-[10px] font-mono tracking-widest uppercase ${
                backendOk === null
                  ? "text-zinc-500"
                  : backendOk
                    ? "text-emerald-400"
                    : "text-red-400"
              }`}
            >
              {backendOk === null
                ? "connecting"
                : backendOk
                  ? "live"
                  : "offline"}
            </span>
          </GlassPanel>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Search toggle */}
          <button
            onClick={() => setShowSearch((v) => !v)}
            className="flex items-center gap-2 bg-black/70 backdrop-blur-xl border border-white/10 rounded-xl px-3.5 py-2 text-zinc-300 hover:text-white hover:border-white/20 transition-all text-xs font-mono"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            Search
          </button>

          {/* Fetch TLEs */}
          <button
            onClick={triggerFetch}
            disabled={fetching || backendOk !== true}
            className="flex items-center gap-2 bg-cyan-900/60 hover:bg-cyan-800/70 backdrop-blur-xl border border-cyan-700/40 hover:border-cyan-600/60 disabled:opacity-40 rounded-xl px-3.5 py-2 text-cyan-300 transition-all text-xs font-mono"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={fetching ? "animate-spin" : ""}
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
            </svg>
            {fetching ? "Fetching…" : "Fetch TLEs"}
          </button>

          {/* Run detection */}
          <button
            onClick={runDetection}
            disabled={detecting || backendOk !== true}
            className="flex items-center gap-2 bg-orange-900/60 hover:bg-orange-800/70 backdrop-blur-xl border border-orange-700/40 hover:border-orange-600/60 disabled:opacity-40 rounded-xl px-3.5 py-2 text-orange-300 transition-all text-xs font-mono"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={detecting ? "animate-pulse" : ""}
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {detecting ? "Running…" : "Detect"}
          </button>

          {/* Conjunctions toggle */}
          <button
            onClick={() => {
              setShowConjPanel((v) => !v);
              setShowSatPanel(false);
            }}
            className={`flex items-center gap-2 backdrop-blur-xl border rounded-xl px-3.5 py-2 transition-all text-xs font-mono ${
              showConjPanel
                ? "bg-red-900/70 border-red-700/60 text-red-300"
                : "bg-black/70 border-white/10 text-zinc-300 hover:text-white hover:border-white/20"
            }`}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Conjunctions
            {conjTotal > 0 && (
              <span className="bg-red-700/80 text-red-200 rounded-full px-1.5 py-px text-[9px] font-bold">
                {conjTotal}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM-LEFT STATS PILL — compact, expandable on hover
      ════════════════════════════════════════════════════════════════════ */}
      <div className="absolute bottom-5 left-5 z-20 flex flex-col gap-2 pointer-events-auto group">
        {/* Expanded panel — visible on hover */}
        <div className="opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200 ease-out flex flex-col gap-2">
          {/* Stats */}
          <GlassPanel className="p-3 w-48 space-y-0.5">
            <p className="text-[8px] uppercase tracking-[0.3em] text-zinc-600 mb-2">
              Live Stats
            </p>
            <StatRow
              label="Objects"
              value={totalSats.toLocaleString()}
              accent
            />
            <StatRow label="Conjunctions" value={conjTotal.toLocaleString()} />
            <StatRow label="High Risk" value={highCount} />
            {sysStatus && (
              <>
                <StatRow
                  label="TLE Age"
                  value={timeAgo(sysStatus.last_fetch_at)}
                />
                <StatRow
                  label="Next Sync"
                  value={timeUntil(sysStatus.next_scheduled)}
                />
              </>
            )}
            {sysStatus?.auto_refresh_active && (
              <div className="flex items-center gap-1.5 pt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                <span className="text-[8px] text-cyan-400 uppercase tracking-widest">
                  Refreshing
                </span>
              </div>
            )}
          </GlassPanel>

          {/* Categories */}
          {categories.length > 0 && (
            <GlassPanel className="p-3 w-48">
              <p className="text-[8px] uppercase tracking-[0.3em] text-zinc-600 mb-2">
                By Category
              </p>
              <div className="space-y-0.5">
                {categories.slice(0, 8).map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center justify-between py-0.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: catColor(c.name) }}
                      />
                      <span className="text-[10px] text-zinc-400 capitalize">
                        {c.name}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono text-zinc-300">
                      {c.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </GlassPanel>
          )}
        </div>

        {/* Always-visible compact pill */}
        <GlassPanel className="flex items-center gap-2.5 px-3 py-2 cursor-default">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
          <span className="text-[10px] font-mono text-zinc-300 whitespace-nowrap">
            <span className="text-emerald-300 font-bold">
              {totalSats.toLocaleString()}
            </span>
            <span className="text-zinc-600 mx-1.5">·</span>
            <span
              className={
                highCount > 0 ? "text-red-400 font-bold" : "text-zinc-500"
              }
            >
              {conjTotal.toLocaleString()}
            </span>
            <span className="text-zinc-700 ml-1">conj</span>
          </span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="text-zinc-600 flex-shrink-0"
          >
            <path d="m18 15-6-6-6 6" />
          </svg>
        </GlassPanel>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          HIGH-RISK ALERT BANNER
      ════════════════════════════════════════════════════════════════════ */}
      {highCount > 0 && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 pointer-events-auto select-none">
          <button
            onClick={() => {
              setShowConjPanel(true);
              setRiskFilter("HIGH");
              setShowSatPanel(false);
            }}
            className="flex items-center gap-2.5 bg-red-950/90 backdrop-blur-xl border border-red-600/70 rounded-full px-5 py-2 hover:bg-red-900/90 transition-all"
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
            <span className="text-red-300 font-bold font-mono text-xs tracking-widest uppercase">
              {highCount} HIGH-RISK CONJUNCTION{highCount > 1 ? "S" : ""} ACTIVE
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="text-red-400"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          SEARCH OVERLAY — full-screen backdrop, above everything
      ════════════════════════════════════════════════════════════════════ */}
      {showSearch && (
        <div
          className="absolute inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-black/30 backdrop-blur-sm"
          onClick={() => {
            setShowSearch(false);
            setSearch("");
          }}
        >
          <div
            className="w-full max-w-xl pointer-events-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <GlassPanel className="overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-zinc-500 flex-shrink-0"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  autoFocus
                  placeholder="Search satellites by name or NORAD ID…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none font-mono"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="text-zinc-600 hover:text-zinc-400 text-xs"
                  >
                    ✕
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowSearch(false);
                    setSearch("");
                  }}
                  className="text-zinc-600 hover:text-zinc-400 text-xs border border-zinc-700 rounded px-1.5 py-px"
                >
                  ESC
                </button>
              </div>

              {/* Results */}
              <div className="max-h-80 overflow-y-auto">
                {searching && (
                  <div className="p-4 text-center text-xs text-zinc-600 animate-pulse">
                    Searching…
                  </div>
                )}
                {!searching && search && searchResults.length === 0 && (
                  <div className="p-4 text-center text-xs text-zinc-600">
                    No satellites found
                  </div>
                )}
                {!searching &&
                  searchResults.map((sat) => (
                    <button
                      key={sat.norad_id}
                      onClick={() => handleSelectFromSearch(sat)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors border-b border-white/5 last:border-0 text-left"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ background: catColor(sat.category) }}
                        />
                        <div>
                          <p className="text-sm text-zinc-200 font-medium">
                            {sat.name}
                          </p>
                          <p className="text-[10px] text-zinc-600 font-mono">
                            NORAD {sat.norad_id}
                          </p>
                        </div>
                      </div>
                      <span className="text-[9px] uppercase tracking-widest text-zinc-600 capitalize">
                        {sat.category ?? "—"}
                      </span>
                    </button>
                  ))}
                {!searching && search && searchTotal > searchResults.length && (
                  <p className="text-[10px] text-zinc-600 text-center py-2">
                    +{(searchTotal - searchResults.length).toLocaleString()}{" "}
                    more — refine your search
                  </p>
                )}
                {!search && (
                  <div className="p-6 text-center text-xs text-zinc-600">
                    Type to search across {totalSats.toLocaleString()} tracked
                    objects
                  </div>
                )}
              </div>
            </GlassPanel>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          RIGHT DRAWER — SATELLITE DETAILS (overlays on top of globe)
      ════════════════════════════════════════════════════════════════════ */}
      <div
        className={`absolute top-0 right-0 bottom-0 z-40 transition-transform duration-300 ease-out ${showSatPanel && selected ? "translate-x-0" : "translate-x-full"}`}
        style={{ pointerEvents: showSatPanel && selected ? "auto" : "none" }}
      >
        {selected && (
          <GlassPanel className="h-full w-72 flex flex-col rounded-none rounded-l-2xl border-r-0">
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-white/10">
              <div className="flex-1 min-w-0 pr-2">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: catColor(selected.category) }}
                  />
                  <span className="text-[9px] uppercase tracking-[0.25em] text-zinc-500 capitalize">
                    {selected.category ?? "satellite"}
                  </span>
                </div>
                <h2 className="text-sm font-bold text-zinc-100 leading-tight">
                  {selected.name}
                </h2>
                <p className="text-[10px] text-zinc-600 font-mono mt-1">
                  NORAD {selected.norad_id}
                </p>
              </div>
              <button
                onClick={() => setShowSatPanel(false)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors p-1 flex-shrink-0"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Live badge */}
            <div className="px-5 py-2 border-b border-white/5">
              {posLoading && !position ? (
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-pulse" />
                  Computing position…
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[10px] text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live · refreshing every 5s
                </div>
              )}
            </div>

            {/* AI Insight for conjunction */}
            {(selectedConj || aiAnalysis) && (
              <div className="px-5 py-3 border-b border-white/5 bg-purple-950/20">
                <div className="flex items-center gap-2 mb-2">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-purple-400"
                  >
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2Z" />
                  </svg>
                  <span className="text-[9px] uppercase tracking-widest text-purple-400">
                    AI Insight
                  </span>
                </div>
                {loadingAI && !aiAnalysis ? (
                  <div className="text-[10px] text-zinc-500 animate-pulse">
                    Analyzing conjunction…
                  </div>
                ) : aiAnalysis ? (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold text-zinc-200">
                      {aiAnalysis.risk_summary}
                    </p>
                    <p className="text-[9px] text-zinc-400 leading-snug">
                      {aiAnalysis.explanation}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[9px] text-purple-300">
                        {aiAnalysis.recommendation}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* Position data */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {!position && !posLoading && (
                <div className="text-center py-8 text-xs text-zinc-600">
                  No data available
                </div>
              )}

              {position && (
                <>
                  {/* Geodetic */}
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.25em] text-zinc-600 mb-2">
                      Position
                    </p>
                    <div className="bg-white/5 rounded-xl p-3 space-y-0">
                      <StatRow
                        label="Latitude"
                        value={fmtCoord(position.geo.lat, "N", "S")}
                        accent
                      />
                      <StatRow
                        label="Longitude"
                        value={fmtCoord(position.geo.lon, "E", "W")}
                        accent
                      />
                      <StatRow
                        label="Altitude"
                        value={`${position.geo.alt.toFixed(1)} km`}
                        accent
                      />
                    </div>
                  </div>

                  {/* Velocity */}
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.25em] text-zinc-600 mb-2">
                      Velocity
                    </p>
                    <div className="bg-white/5 rounded-xl p-3">
                      <StatRow
                        label="Speed"
                        value={`${position.velocity.speed_km_s.toFixed(3)} km/s`}
                      />
                      <StatRow
                        label="Vx"
                        value={`${position.velocity.vx.toFixed(3)} km/s`}
                      />
                      <StatRow
                        label="Vy"
                        value={`${position.velocity.vy.toFixed(3)} km/s`}
                      />
                      <StatRow
                        label="Vz"
                        value={`${position.velocity.vz.toFixed(3)} km/s`}
                      />
                    </div>
                  </div>

                  {/* ECI */}
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.25em] text-zinc-600 mb-2">
                      ECI Coordinates
                    </p>
                    <div className="bg-white/5 rounded-xl p-3">
                      <StatRow
                        label="X"
                        value={`${position.eci.x.toFixed(1)} km`}
                      />
                      <StatRow
                        label="Y"
                        value={`${position.eci.y.toFixed(1)} km`}
                      />
                      <StatRow
                        label="Z"
                        value={`${position.eci.z.toFixed(1)} km`}
                      />
                    </div>
                  </div>

                  {/* Distance + timestamp */}
                  <div className="bg-white/5 rounded-xl p-3">
                    <StatRow
                      label="Dist. from Centre"
                      value={`${position.distance_from_center_km.toFixed(1)} km`}
                    />
                    <StatRow
                      label="Timestamp (UTC)"
                      value={new Date(position.timestamp)
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 19)}
                    />
                  </div>
                </>
              )}

              {/* Orbit track hint */}
              <div className="text-[10px] text-zinc-600 text-center pb-2">
                Orbit track visible on globe · 2h window
              </div>
            </div>

            {/* Footer: deselect */}
            <div className="p-4 border-t border-white/10">
              <button
                onClick={() => {
                  setSelected(null);
                  setShowSatPanel(false);
                }}
                className="w-full text-xs text-zinc-600 hover:text-zinc-400 transition-colors py-1"
              >
                Deselect satellite
              </button>
            </div>
          </GlassPanel>
        )}
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM DRAWER — CONJUNCTIONS (overlays on top of globe)
      ════════════════════════════════════════════════════════════════════ */}
      <div
        className={`absolute left-0 right-0 bottom-0 z-40 transition-transform duration-300 ease-out ${showConjPanel ? "translate-y-0" : "translate-y-full"}`}
        style={{ pointerEvents: showConjPanel ? "auto" : "none" }}
      >
        <GlassPanel className="rounded-b-none rounded-t-2xl max-h-[50vh] flex flex-col">
          {/* Drawer header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 flex-shrink-0">
            <div className="flex items-center gap-4">
              <span className="text-sm font-bold text-zinc-200">
                Conjunctions
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {loadingConj
                  ? "Loading…"
                  : `${conjTotal.toLocaleString()} events`}
              </span>
              {/* Risk filter pills */}
              <div className="flex gap-1">
                {(["", "HIGH", "MEDIUM", "LOW"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRiskFilter(r)}
                    className={`text-[10px] px-2.5 py-1 rounded-full border font-bold transition-all ${
                      riskFilter === r
                        ? r === "HIGH"
                          ? "bg-red-900/70 text-red-300 border-red-700"
                          : r === "MEDIUM"
                            ? "bg-yellow-900/70 text-yellow-300 border-yellow-700"
                            : r === "LOW"
                              ? "bg-zinc-700/70 text-zinc-300 border-zinc-600"
                              : "bg-cyan-900/50 text-cyan-300 border-cyan-700"
                        : "bg-white/5 text-zinc-500 border-white/10 hover:border-white/20 hover:text-zinc-300"
                    }`}
                  >
                    {r === "" ? "All" : r}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={runDetection}
                disabled={detecting || backendOk !== true}
                className="text-[10px] flex items-center gap-1.5 text-orange-400 hover:text-orange-300 disabled:opacity-40 transition-colors font-mono"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className={detecting ? "animate-pulse" : ""}
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {detecting ? "Running…" : "Re-run"}
              </button>
              <button
                onClick={() => setShowConjPanel(false)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="m18 15-6 6-6-6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Conjunction list */}
          <div className="overflow-y-auto flex-1">
            {loadingConj && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 rounded-xl bg-white/5 animate-pulse"
                  />
                ))}
              </div>
            )}

            {!loadingConj && conjunctions.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="text-4xl mb-3 opacity-30">☄️</div>
                <p className="text-sm text-zinc-500">No conjunctions found</p>
                <p className="text-xs text-zinc-700 mt-1">
                  Click Re-run to analyse all satellite pairs
                </p>
              </div>
            )}

            {!loadingConj && conjunctions.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
                {conjunctions.map((ev, i) => {
                  const s = RISK_STYLE[ev.risk];
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        setSelected({ norad_id: ev.sat1, name: ev.sat1_name, last_updated: "" });
                        setShowSatPanel(true);
                        setShowConjPanel(false);
                        fetchAIAnalysis(ev);
                      }}
                      className={`rounded-xl border p-3 transition-all hover:brightness-125 cursor-pointer text-left ${s.card}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <RiskPill risk={ev.risk} />
                        <span className="text-[9px] font-mono text-zinc-600">
                          {ev.distance.toFixed(3)} km
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs font-semibold text-zinc-200 truncate">
                          {ev.sat1_name}
                        </p>
                        <p className="text-[9px] text-zinc-600 font-mono">↕</p>
                        <p className="text-xs font-semibold text-zinc-200 truncate">
                          {ev.sat2_name}
                        </p>
                      </div>
                      <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between">
                        <span className="text-[9px] text-zinc-600 font-mono">
                          {new Date(ev.tca).toISOString().slice(11, 16)} UTC
                        </span>
                        <span className="text-[9px] text-zinc-600 font-mono">
                          {ev.velocity.toFixed(2)} km/s
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM-LEFT: hint — only shown when conjunctions panel is closed
      ════════════════════════════════════════════════════════════════════ */}
      {!showConjPanel && !showSatPanel && (
        <div className="absolute bottom-5 left-5 z-10 pointer-events-none">
          <p className="text-[9px] font-mono tracking-[0.35em] uppercase text-zinc-700">
            Drag · Scroll · Click Satellite
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          TOAST — above drawers
      ════════════════════════════════════════════════════════════════════ */}
      {toast && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
          <GlassPanel
            className={`flex items-center gap-3 px-5 py-3 border ${toast.ok ? "border-emerald-700/50" : "border-red-700/50"}`}
          >
            <span className={`text-lg flex-shrink-0`}>
              {toast.ok ? "✅" : "❌"}
            </span>
            <span className="text-sm text-zinc-200 max-w-md">{toast.msg}</span>
            <button
              onClick={() => setToast(null)}
              className="text-zinc-600 hover:text-zinc-400 text-xs ml-2"
            >
              ✕
            </button>
          </GlassPanel>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          BOTTOM-RIGHT: Selected satellite mini badge (tap to re-open drawer)
      ════════════════════════════════════════════════════════════════════ */}
      {selected && !showSatPanel && !showConjPanel && (
        <button
          onClick={() => setShowSatPanel(true)}
          className="absolute bottom-5 right-5 z-30 pointer-events-auto"
        >
          <GlassPanel className="flex items-center gap-3 px-4 py-2.5 hover:border-white/20 transition-all">
            <Dot color={catColor(selected.category)} />
            <div className="text-left">
              <p className="text-xs font-semibold text-zinc-200">
                {selected.name}
              </p>
              <p className="text-[9px] text-zinc-600 font-mono">
                {position
                  ? `${position.geo.alt.toFixed(0)} km · ${position.velocity.speed_km_s.toFixed(2)} km/s`
                  : "Loading…"}
              </p>
            </div>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="text-zinc-600"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </GlassPanel>
        </button>
      )}
    </div>
  );
}
