"""
main.py — AEGIS FastAPI backend (Phase 8: proximity pairs for globe arc viz)

New in Phase 8:
  - GET /proximity returns the N closest satellite pairs right now
    (uses current SGP4 positions + scipy cKDTree for fast nearest-neighbour)
  - Risk thresholds updated: HIGH <10 km, MEDIUM <50 km, LOW <200 km
  - Default detect threshold raised to 200 km so real conjunctions are found
"""

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.background import BackgroundScheduler

import numpy as np
from scipy.spatial import cKDTree

from db import get_conn, init_db
from fetcher import fetch_and_store
from propagator import get_position, get_orbit_track
from detector import run_detection
from propagator import get_position as _get_pos
from ai_service import analyze_conjunction, summarize_top_risks

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="AEGIS Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Scheduler state ───────────────────────────────────────────────────────────

_state: dict = {
    "last_fetch_at":   None,
    "last_detect_at":  None,
    "runs_completed":  0,
    "is_running":      False,
    "lock":            threading.Lock(),
}

scheduler = BackgroundScheduler(daemon=True, timezone="UTC")

# ── Auto-refresh job ──────────────────────────────────────────────────────────

def _auto_refresh() -> None:
    """Fetch fresh TLEs from CelesTrak then re-run conjunction detection."""
    with _state["lock"]:
        if _state["is_running"]:
            print("[scheduler] Already running, skipping.")
            return
        _state["is_running"] = True

    try:
        print("[scheduler] Auto-refresh: fetching TLEs…")
        fetch_and_store()
        _state["last_fetch_at"] = datetime.now(timezone.utc).isoformat()

        print("[scheduler] Auto-refresh: running detection…")
        run_detection()
        _state["last_detect_at"] = datetime.now(timezone.utc).isoformat()
        _state["runs_completed"] += 1
        print(f"[scheduler] Auto-refresh complete (run #{_state['runs_completed']})")
    except Exception as e:
        print(f"[scheduler] Auto-refresh failed: {e}")
    finally:
        _state["is_running"] = False


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
def on_startup() -> None:
    init_db()

    # Schedule recurring refresh every 12 hours
    scheduler.add_job(_auto_refresh, "interval", hours=12, id="auto_refresh")
    scheduler.start()

    # Bootstrap: if DB is empty, seed it in a background thread immediately
    conn = get_conn()
    sat_count = conn.execute("SELECT COUNT(*) FROM satellites").fetchone()[0]
    conn.close()

    if sat_count == 0:
        print("[startup] DB empty — triggering initial data load…")
        t = threading.Thread(target=_auto_refresh, daemon=True)
        t.start()
    else:
        print(f"[startup] DB has {sat_count} satellites — ready.")


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "AEGIS backend running", "version": "2.0.0"}


# ── Status ────────────────────────────────────────────────────────────────────

@app.get("/status")
def get_status():
    """
    Returns system health: satellite/conjunction counts, last run times,
    next scheduled refresh, and whether auto-refresh is currently executing.
    """
    conn       = get_conn()
    sat_count  = conn.execute("SELECT COUNT(*) FROM satellites").fetchone()[0]
    conj_count = conn.execute("SELECT COUNT(*) FROM conjunctions").fetchone()[0]
    conn.close()

    job      = scheduler.get_job("auto_refresh")
    next_run = None
    if job and job.next_run_time:
        next_run = job.next_run_time.isoformat()

    return {
        "satellites":         sat_count,
        "conjunctions":       conj_count,
        "last_fetch_at":      _state["last_fetch_at"],
        "last_detect_at":     _state["last_detect_at"],
        "runs_completed":     _state["runs_completed"],
        "auto_refresh_active": _state["is_running"],
        "scheduler_running":  scheduler.running,
        "next_scheduled":     next_run,
    }


# ── Data Ingestion ────────────────────────────────────────────────────────────

@app.post("/fetch")
def fetch_satellites():
    """Pull latest TLEs from CelesTrak and upsert into the DB."""
    try:
        result = fetch_and_store()
        _state["last_fetch_at"] = datetime.now(timezone.utc).isoformat()
        _invalidate_all_caches()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Satellites ────────────────────────────────────────────────────────────────

@app.get("/satellites/categories")
def get_satellite_categories():
    """Returns a list of categories with satellite counts, ordered by count descending."""
    conn = get_conn()
    rows = conn.execute(
        """SELECT COALESCE(category, 'unknown') AS name, COUNT(*) AS count
             FROM satellites
            GROUP BY COALESCE(category, 'unknown')
            ORDER BY count DESC"""
    ).fetchall()
    conn.close()
    return {"categories": [dict(r) for r in rows]}


@app.get("/satellites")
def get_satellites(limit: int = 100, offset: int = 0, search: str = "", category: str = ""):
    """Paginated satellite list with optional name search and category filter."""
    conn   = get_conn()
    cursor = conn.cursor()

    filters: list[str] = []
    params:  list      = []

    if search:
        filters.append("name LIKE ?")
        params.append(f"%{search}%")
    if category:
        filters.append("category = ?")
        params.append(category)

    where = ("WHERE " + " AND ".join(filters)) if filters else ""

    rows = cursor.execute(
        f"SELECT norad_id, name, category, last_updated FROM satellites "
        f"{where} ORDER BY name LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    total = cursor.execute(
        f"SELECT COUNT(*) FROM satellites {where}", params
    ).fetchone()[0]

    conn.close()
    return {"total": total, "satellites": [dict(r) for r in rows]}


@app.get("/satellites/{norad_id}")
def get_satellite(norad_id: str):
    """Returns full record (including TLEs) for one satellite."""
    conn = get_conn()
    row  = conn.execute(
        "SELECT * FROM satellites WHERE norad_id = ?", (norad_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Satellite not found")
    return dict(row)


# ── Orbit Propagation ─────────────────────────────────────────────────────────

@app.get("/position/{norad_id}")
def current_position(norad_id: str):
    """Current ECI position + velocity + geodetic coords via SGP4."""
    conn = get_conn()
    row  = conn.execute(
        "SELECT tle1, tle2 FROM satellites WHERE norad_id = ?", (norad_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Satellite not found")
    result = get_position(row["tle1"], row["tle2"])
    if result.get("error"):
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@app.get("/orbit/{norad_id}")
def orbit_track(norad_id: str, hours: float = 24, step: int = 60):
    """24-hour geodetic orbit track sampled every `step` seconds."""
    if hours > 72:
        raise HTTPException(status_code=400, detail="Max 72 hours")
    if step < 10:
        raise HTTPException(status_code=400, detail="Min step is 10 seconds")
    conn = get_conn()
    row  = conn.execute(
        "SELECT tle1, tle2 FROM satellites WHERE norad_id = ?", (norad_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Satellite not found")
    track = get_orbit_track(row["tle1"], row["tle2"], hours=hours, step_seconds=step)
    return {"norad_id": norad_id, "hours": hours, "step_seconds": step,
            "points": len(track), "track": track}


# ── Batch positions (parallelised) ────────────────────────────────────────────

# In-memory cache for /positions/all to avoid recomputing SGP4 on every request
_positions_cache: dict = {
    "data": None,
    "timestamp": 0.0,
    "ttl": 15,  # seconds
}
_positions_cache_lock = threading.Lock()


def _compute_one(row: dict) -> dict | None:
    pos = get_position(row["tle1"], row["tle2"])
    if pos.get("error"):
        return None
    return {
        "norad_id": row["norad_id"],
        "name":     row["name"],
        "category": row.get("category"),
        "lat":      pos["geo"]["lat"],
        "lon":      pos["geo"]["lon"],
        "alt":      pos["geo"]["alt"],
        "speed":    pos["velocity"]["speed_km_s"],
    }


def _invalidate_positions_cache():
    """Clear the positions cache — call after TLE fetch or detection runs."""
    with _positions_cache_lock:
        _positions_cache["data"] = None
        _positions_cache["timestamp"] = 0.0


@app.get("/positions/all")
def all_positions(category: str = ""):
    """
    Batch-computes current positions for all satellites in parallel.
    Each SGP4 evaluation runs in its own thread — 8× faster for large fleets.
    Optionally filter by category (e.g. ?category=starlink).
    Uses a 15-second TTL cache to avoid redundant SGP4 computations.
    """
    now = time.time()

    # Check cache first (only for unfiltered requests)
    if not category:
        with _positions_cache_lock:
            if (_positions_cache["data"] is not None and
                    now - _positions_cache["timestamp"] < _positions_cache["ttl"]):
                return _positions_cache["data"]

    conn = get_conn()
    if category:
        rows = [dict(r) for r in conn.execute(
            "SELECT norad_id, name, category, tle1, tle2 FROM satellites WHERE category = ?",
            (category,),
        ).fetchall()]
    else:
        rows = [dict(r) for r in conn.execute(
            "SELECT norad_id, name, category, tle1, tle2 FROM satellites"
        ).fetchall()]
    conn.close()

    if not rows:
        return {"count": 0, "satellites": []}

    with ThreadPoolExecutor(max_workers=min(8, len(rows))) as pool:
        results = list(pool.map(_compute_one, rows))

    sats = [r for r in results if r is not None]
    response = {"count": len(sats), "satellites": sats}

    # Cache the result for unfiltered requests
    if not category:
        with _positions_cache_lock:
            _positions_cache["data"] = response
            _positions_cache["timestamp"] = now

    return response


# ── Conjunction Detection ─────────────────────────────────────────────────────

# Cache for satellite names (rarely changes, avoids full table scan)
_sat_names_cache: dict = {"data": None, "count": 0}
_sat_names_lock = threading.Lock()


def _get_sat_names() -> dict:
    """Get cached satellite name lookup, refreshing only when count changes."""
    conn = get_conn()
    current_count = conn.execute("SELECT COUNT(*) FROM satellites").fetchone()[0]
    conn.close()

    with _sat_names_lock:
        if _sat_names_cache["data"] is None or _sat_names_cache["count"] != current_count:
            conn = get_conn()
            _sat_names_cache["data"] = {
                r["norad_id"]: r["name"]
                for r in conn.execute("SELECT norad_id, name FROM satellites").fetchall()
            }
            _sat_names_cache["count"] = current_count
            conn.close()
        return _sat_names_cache["data"]


def _invalidate_all_caches():
    """Clear all caches — call after TLE fetch or DB changes."""
    _invalidate_positions_cache()
    with _sat_names_lock:
        _sat_names_cache["data"] = None
        _sat_names_cache["count"] = 0


@app.post("/detect")
def detect_conjunctions(hours: float = 24, step: int = 120, threshold: float = 200.0):
    """
    Run the full conjunction detection pipeline.
    Propagates all satellites → KD-Tree pairwise search → risk classification → persist.
    """
    if hours > 72:
        raise HTTPException(status_code=400, detail="Max 72 hours")
    if step < 30:
        raise HTTPException(status_code=400, detail="Min step is 30 seconds")
    if threshold > 1000:
        raise HTTPException(status_code=400, detail="Max threshold is 1000 km")
    try:
        result = run_detection(hours=hours, step_seconds=step, threshold_km=threshold)
        _state["last_detect_at"] = datetime.now(timezone.utc).isoformat()
        _invalidate_all_caches()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conjunctions")
def get_conjunctions(risk: str = "", limit: int = 100):
    """Stored conjunction events, optionally filtered by risk level (HIGH/MEDIUM/LOW)."""
    sat_names = _get_sat_names()
    conn = get_conn()

    if risk:
        rows = conn.execute(
            "SELECT sat1, sat2, tca, distance, velocity, risk FROM conjunctions "
            "WHERE risk = ? ORDER BY distance ASC LIMIT ?",
            (risk.upper(), limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT sat1, sat2, tca, distance, velocity, risk FROM conjunctions "
            "ORDER BY distance ASC LIMIT ?",
            (limit,),
        ).fetchall()

    total = conn.execute("SELECT COUNT(*) FROM conjunctions").fetchone()[0]
    conn.close()

    events = [
        {
            "sat1":      r["sat1"],
            "sat1_name": sat_names.get(r["sat1"], r["sat1"]),
            "sat2":      r["sat2"],
            "sat2_name": sat_names.get(r["sat2"], r["sat2"]),
            "tca":       r["tca"],
            "distance":  r["distance"],
            "velocity":  r["velocity"],
            "risk":      r["risk"],
        }
        for r in rows
    ]
    return {"total": total, "events": events}


# ── Proximity pairs (for globe arc visualisation) ─────────────────────────────

def _risk_label_prox(d: float) -> str:
    """Same thresholds as detector.py."""
    if d < 10.0:
        return "HIGH"
    if d < 50.0:
        return "MEDIUM"
    return "LOW"


# Cache for proximity results (expensive SGP4 + KD-Tree computation)
_proximity_cache: dict = {
    "data": None,
    "timestamp": 0.0,
    "ttl": 60,  # seconds
}
_proximity_cache_lock = threading.Lock()


@app.get("/proximity")
def get_proximity(limit: int = 200):
    """
    Returns the `limit` closest satellite pairs based on their **current**
    SGP4 ECI positions.  Uses a scipy cKDTree for O(n log n) nearest-neighbour
    search across the entire satellite fleet.

    Each pair is returned with:
      sat1/sat2 NORAD IDs & names, current lat/lon for both,
      ECI distance (km), and a risk label (HIGH/MEDIUM/LOW).

    This endpoint powers the conjunction arc layer on the 3-D globe when no
    formal detection run has been executed.
    Uses a 60-second TTL cache to avoid redundant SGP4+KDTree computations.
    """
    now = time.time()

    # Check cache first
    with _proximity_cache_lock:
        if (_proximity_cache["data"] is not None and
                now - _proximity_cache["timestamp"] < _proximity_cache["ttl"]):
            return _proximity_cache["data"]

    conn = get_conn()
    rows = [dict(r) for r in conn.execute(
        "SELECT norad_id, name, tle1, tle2 FROM satellites"
    ).fetchall()]
    conn.close()

    if not rows:
        return {"count": 0, "pairs": []}

    # ── 1. Propagate all satellites to now ───────────────────────────────────
    def _prop(row: dict):
        pos = _get_pos(row["tle1"], row["tle2"])
        if pos.get("error"):
            return None
        return {
            "norad_id": row["norad_id"],
            "name":     row["name"],
            "lat":      pos["geo"]["lat"],
            "lon":      pos["geo"]["lon"],
            "x":        pos["eci"]["x"],
            "y":        pos["eci"]["y"],
            "z":        pos["eci"]["z"],
        }

    workers = min(8, len(rows))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(_prop, rows))

    valid = [r for r in results if r is not None]
    if len(valid) < 2:
        return {"count": 0, "pairs": []}

    # ── 2. Build KD-Tree on ECI positions ────────────────────────────────────
    positions = np.array([[v["x"], v["y"], v["z"]] for v in valid], dtype=np.float64)
    tree = cKDTree(positions)

    # Query each point for its 4 nearest neighbours (excluding itself)
    k = min(5, len(valid))
    distances, indices = tree.query(positions, k=k)

    # ── 3. Collect unique pairs sorted by distance ────────────────────────────
    seen: set[tuple] = set()
    pairs: list[dict] = []

    for i, (dists, idxs) in enumerate(zip(distances, indices)):
        for dist, j in zip(dists[1:], idxs[1:]):   # skip self (index 0)
            key = (min(i, j), max(i, j))
            if key in seen:
                continue
            seen.add(key)
            pairs.append({
                "sat1":       valid[i]["norad_id"],
                "sat1_name":  valid[i]["name"],
                "sat1_lat":   valid[i]["lat"],
                "sat1_lon":   valid[i]["lon"],
                "sat2":       valid[j]["norad_id"],
                "sat2_name":  valid[j]["name"],
                "sat2_lat":   valid[j]["lat"],
                "sat2_lon":   valid[j]["lon"],
                "distance":   round(float(dist), 2),
                "risk":       _risk_label_prox(float(dist)),
            })

    pairs.sort(key=lambda p: p["distance"])
    pairs = pairs[:limit]

    response = {"count": len(pairs), "pairs": pairs}

    # Cache the result
    with _proximity_cache_lock:
        _proximity_cache["data"] = response
        _proximity_cache["timestamp"] = now

    return response


# ── AI Analysis ─────────────────────────────────────────────────────────────────────

@app.post("/ai/analyze-conjunction")
def ai_analyze_conjunction(payload: dict):
    """
    Analyze a single conjunction event using Gemini AI.
    Input: {sat1, sat2, distance_km, velocity_kms, tca}
    Output: {risk_summary, recommendation, explanation}
    """
    sat1 = payload.get("sat1", "")
    sat2 = payload.get("sat2", "")
    distance_km = float(payload.get("distance_km", 0))
    velocity_kms = float(payload.get("velocity_kms", 0))
    tca = payload.get("tca", "")

    if not sat1 or not sat2:
        raise HTTPException(status_code=400, detail="sat1 and sat2 required")

    return analyze_conjunction(sat1, sat2, distance_km, velocity_kms, tca)


@app.get("/ai/summary")
def ai_summary(limit: int = 10):
    """
    Get AI summary of top risk conjunctions from stored events.
    Returns: {summaries: [{sat_pair, summary}, ...]}
    """
    conn = get_conn()
    rows = conn.execute(
        "SELECT sat1, sat2, distance, risk FROM conjunctions "
        "ORDER BY distance ASC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()

    if not rows:
        return {"summaries": []}

    conjunctions = [
        {"sat1": r["sat1"], "sat2": r["sat2"], "distance": r["distance"], "risk": r["risk"]}
        for r in rows
    ]

    return summarize_top_risks(conjunctions, count=3)
