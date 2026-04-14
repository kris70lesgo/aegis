"""
propagator.py — SGP4 orbit propagation using sgp4.api.Satrec
Outputs ECI positions + converts to geodetic lat/lon/alt.
"""

import math
from datetime import datetime, timezone, timedelta
from sgp4.api import Satrec, jday

# Earth equatorial radius (km)
R_EARTH = 6378.137
# Earth flattening
F_EARTH = 1 / 298.257223563


def _jd_fr(t: datetime) -> tuple[float, float]:
    """Convert a UTC datetime to Julian date + fraction."""
    jd, fr = jday(
        t.year, t.month, t.day,
        t.hour, t.minute, t.second + t.microsecond / 1e6,
    )
    return jd, fr


def _eci_to_ecef(x: float, y: float, z: float, t: datetime) -> tuple[float, float, float]:
    """Rotate ECI → ECEF using Greenwich Mean Sidereal Time (GMST)."""
    # J2000 epoch
    j2000 = datetime(2000, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    d = (t - j2000).total_seconds() / 86400.0  # days since J2000

    # GMST in radians (approximate formula)
    gmst_deg = (280.46061837 + 360.98564736629 * d) % 360
    gmst = math.radians(gmst_deg)

    cos_g = math.cos(gmst)
    sin_g = math.sin(gmst)

    x_ecef = cos_g * x + sin_g * y
    y_ecef = -sin_g * x + cos_g * y
    z_ecef = z

    return x_ecef, y_ecef, z_ecef


def _ecef_to_geodetic(x: float, y: float, z: float) -> dict:
    """Convert ECEF (km) → geodetic lat (deg), lon (deg), alt (km)."""
    a = R_EARTH
    e2 = 2 * F_EARTH - F_EARTH ** 2  # eccentricity squared

    lon = math.degrees(math.atan2(y, x))
    p = math.sqrt(x ** 2 + y ** 2)

    # Iterative Bowring's method
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(5):
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1 - e2 * sin_lat ** 2)
        lat = math.atan2(z + e2 * N * sin_lat, p)

    sin_lat = math.sin(lat)
    N = a / math.sqrt(1 - e2 * sin_lat ** 2)
    alt = p / math.cos(lat) - N if abs(math.cos(lat)) > 1e-10 else abs(z) / abs(sin_lat) - N * (1 - e2)

    return {
        "lat": round(math.degrees(lat), 4),
        "lon": round(lon, 4),
        "alt": round(alt, 2),
    }


def get_position(tle1: str, tle2: str, t: datetime | None = None) -> dict:
    """
    Propagate a satellite to time t (default: now UTC).
    Returns ECI position, velocity, geodetic coords, and altitude.
    """
    if t is None:
        t = datetime.now(timezone.utc)

    sat = Satrec.twoline2rv(tle1, tle2)
    jd, fr = _jd_fr(t)
    error, r, v = sat.sgp4(jd, fr)

    if error != 0:
        return {"error": f"SGP4 error code {error}"}

    x, y, z = r
    vx, vy, vz = v
    speed = math.sqrt(vx**2 + vy**2 + vz**2)
    distance = math.sqrt(x**2 + y**2 + z**2)

    x_ecef, y_ecef, z_ecef = _eci_to_ecef(x, y, z, t)
    geo = _ecef_to_geodetic(x_ecef, y_ecef, z_ecef)

    return {
        "timestamp": t.isoformat(),
        "eci": {
            "x": round(x, 3),
            "y": round(y, 3),
            "z": round(z, 3),
        },
        "velocity": {
            "vx": round(vx, 6),
            "vy": round(vy, 6),
            "vz": round(vz, 6),
            "speed_km_s": round(speed, 4),
        },
        "geo": geo,
        "distance_from_center_km": round(distance, 3),
        "error": None,
    }


def get_orbit_track(
    tle1: str,
    tle2: str,
    hours: float = 24,
    step_seconds: int = 60,
    t_start: datetime | None = None,
) -> list[dict]:
    """
    Generate a sequence of geodetic positions over `hours` hours,
    sampled every `step_seconds` seconds starting from t_start (default: now UTC).
    Returns a list of {timestamp, lat, lon, alt} dicts.
    """
    if t_start is None:
        t_start = datetime.now(timezone.utc)

    sat = Satrec.twoline2rv(tle1, tle2)
    total_steps = int(hours * 3600 / step_seconds)
    track = []

    for i in range(total_steps):
        t = t_start + timedelta(seconds=i * step_seconds)
        jd, fr = _jd_fr(t)
        error, r, v = sat.sgp4(jd, fr)

        if error != 0:
            continue

        x, y, z = r
        x_ecef, y_ecef, z_ecef = _eci_to_ecef(x, y, z, t)
        geo = _ecef_to_geodetic(x_ecef, y_ecef, z_ecef)

        track.append({
            "timestamp": t.isoformat(),
            **geo,
        })

    return track
