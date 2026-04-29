"""
ai_service.py — Lightweight AI layer for AEGIS using OpenRouter API

Provides:
  - Single conjunction analysis via OpenRouter (Tencent: Hy3)
  - Summary of top risk conjunctions
  - In-memory cache for AI responses
"""

import hashlib
import os
import threading
from datetime import datetime

import requests

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = "tencent/hy3-preview:free"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

AI_CACHE_TTL = 300  # 5 minutes

_ai_cache: dict = {
    "data": {},
    "lock": threading.Lock(),
}


def _make_cache_key(data: dict) -> str:
    """Generate deterministic cache key from input data."""
    s = f"{data.get('sat1', '')}{data.get('sat2', '')}{data.get('miss_distance_km', 0)}{data.get('tca_timestamp', '')}"
    return hashlib.md5(s.encode()).hexdigest()


def _get_from_cache(key: str) -> dict | None:
    """Get cached AI response if not expired."""
    with _ai_cache["lock"]:
        entry = _ai_cache["data"].get(key)
        if entry and (datetime.now().timestamp() - entry["timestamp"]) < AI_CACHE_TTL:
            return entry["response"]
    return None


def _save_to_cache(key: str, response: dict) -> None:
    """Store AI response in cache."""
    with _ai_cache["lock"]:
        _ai_cache["data"][key] = {
            "response": response,
            "timestamp": datetime.now().timestamp(),
        }


def _call_ai(prompt: str) -> dict | None:
    """Call OpenRouter API and extract structured response from text."""
    if not OPENROUTER_API_KEY:
        print("[ai_service] No OPENROUTER_API_KEY set")
        return None

    try:
        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aegis.space",
            "X-Title": "AEGIS Satellite Monitor",
        }
        payload = {
            "model": OPENROUTER_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
            "max_tokens": 512,
        }

        resp = requests.post(
            OPENROUTER_URL,
            headers=headers,
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

        msg = data.get("choices", [{}])[0].get("message", {})
        text = msg.get("content") or msg.get("reasoning", "") or ""
        
        if not text:
            return None
        
        # Extract structured info from the text response
        text_lower = text.lower()
        
        # Determine risk level - look for key phrases in the raw response
        risk = "low"
        
        # Check for explicit high/medium risk mentions - more specific
        if any(k in text_lower for k in ["high risk", "critical", "severe", "dangerous", "very high risk", "significant collision risk"]):
            risk = "high"
        elif any(k in text_lower for k in ["medium risk", "elevated risk", "moderate risk", "concern", "significant approach"]):
            risk = "medium"
        else:
            # Use distance-based inference only for explicit small distances
            # Look for distance in response (e.g., "0.75 km", "1 km")
            import re
            dist_match = re.search(r'(\d+(?:\.\d+)?)\s*km', text_lower)
            if dist_match:
                dist = float(dist_match.group(1))
                if dist < 1:
                    risk = "high"
                elif dist < 5:
                    risk = "medium"
        
        # Determine recommendation - look for action keywords
        rec = "monitor"
        if any(k in text_lower for k in ["plan maneuver", "evasive", "avoid", "maneuver recommended", "action required"]):
            rec = "plan maneuver"
        elif any(k in text_lower for k in ["ignore", "no action", "safe", "dismiss", "no concern"]):
            rec = "ignore"
        
        # Extract explanation - get clean text (first meaningful sentences)
        # Split by sentences and take first meaningful one
        sentences = text.replace("\n", " ").split(".")
        explanation = ""
        for s in sentences[:3]:  # Take first few fragments
            if len(s.strip()) > 10:
                explanation = s.strip()
                break
        
        # Clean common filler
        bad_starts = ["Got it", "First", "Let me", "I'll", "Here's", "Based on", "Sure", "The user"]
        for bad in bad_starts:
            if explanation.startswith(bad):
                explanation = explanation[len(bad):].strip()
        
        if len(explanation) > 80:
            explanation = explanation[:80].strip() + "."
        
        return {
            "risk_summary": f"{risk.upper()} risk conjunction at miss distance",
            "recommendation": rec,
            "explanation": explanation or "Analysis pending"
        }
    except Exception as e:
        print(f"[ai_service] OpenRouter API error: {e}")
        return None


def analyze_conjunction(sat1: str, sat2: str, distance_km: float, velocity_kms: float, tca: str) -> dict:
    """Analyze a single conjunction event using OpenRouter AI."""
    cache_key = _make_cache_key({
        "sat1": sat1,
        "sat2": sat2,
        "miss_distance_km": distance_km,
        "tca_timestamp": tca,
    })

    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    prompt = f"""Space conjunction analysis:
Satellite 1: {sat1}
Satellite 2: {sat2}
Miss distance: {distance_km} km
Relative velocity: {velocity_kms} km/s
Time of closest approach: {tca}

Classify the risk level and recommend action: monitor, plan maneuver, or ignore?"""

    result = _call_ai(prompt)
    if not result:
        result = _make_fallback()
    
    # Ensure we have a valid response
    if not result or result.get("risk_summary") == "Analysis unavailable":
        result = _make_fallback()
    
    if result and "risk_summary" in result:
        _save_to_cache(cache_key, result)
    
    return result


def summarize_top_risks(conjunctions: list[dict], count: int = 3) -> dict:
    """Get AI summary of top risk conjunctions."""
    if not OPENROUTER_API_KEY or not conjunctions:
        return {"summaries": []}

    sorted_conjs = sorted(conjunctions, key=lambda x: x.get("distance", 9999))[:count]

    conj_text = "\n".join(
        f"- {c.get('sat1', '?')} vs {c.get('sat2', '?')}: {c.get('distance', 0):.2f} km ({c.get('risk', 'LOW')})"
        for c in sorted_conjs
    )

    prompt = f"Rank these {count} close approaches by risk:\n{conj_text}\nWhich 3 need most urgent attention?"
    result = _call_ai(prompt)
    
    if result:
        summaries = [{
            "sat_pair": f"{c.get('sat1', '')}-{c.get('sat2', '')}",
            "summary": result.get("explanation", "Monitor")[0:50]
        } for c in sorted_conjs]
        return {"summaries": summaries}
    
    return {"summaries": []}


def _make_fallback() -> dict:
    return {
        "risk_summary": "Analysis unavailable",
        "recommendation": "monitor",
        "explanation": "AI service temporarily unavailable. Continue monitoring via standard risk assessment.",
    }


def invalidate_cache() -> None:
    """Clear AI response cache."""
    with _ai_cache["lock"]:
        _ai_cache["data"].clear()