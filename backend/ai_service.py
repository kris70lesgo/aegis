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
    """Call OpenRouter API and return parsed JSON response."""
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

        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if text:
            import json
            import re
            text = text.strip()
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
            try:
                return json.loads(text)
            except:
                match = re.search(r'\{.+}', text, re.DOTALL)
                if match:
                    return json.loads(match.group())
        return None
    except Exception as e:
        print(f"[ai_service] OpenRouter API error: {e}")
        return None


CONJUNCTION_ANALYSIS_PROMPT = """You are a space situational awareness expert. Analyze this conjunction event and respond ONLY with valid JSON.

Data:
- Satellite 1: {sat1}
- Satellite 2: {sat2}
- Miss distance: {distance} km
- Relative velocity: {velocity} km/s
- Time of closest approach: {tca}

Respond with exactly this JSON structure (no extra text):
{{
  "risk_summary": "1-line summary of collision risk",
  "recommendation": "monitor | plan maneuver | ignore",
  "explanation": "2-line max reasoning based ONLY on the data provided"
}}"""

SUMMARY_PROMPT = """You are a space situational awareness expert. Summarize the top {count} highest-risk conjunctions in simple language.

Conjunctions (sorted by risk):
{conjunctions}

Respond with exactly this JSON structure (no extra text):
{{
  "summaries": [
    {{"sat_pair": "SAT1-SAT2", "summary": "1-line summary"}},
    ...
  ]
}}"""


def analyze_conjunction(sat1: str, sat2: str, distance_km: float, velocity_kms: float, tca: str) -> dict:
    """
    Analyze a single conjunction event using OpenRouter AI.
    Returns: {risk_summary, recommendation, explanation}
    """
    cache_key = _make_cache_key({
        "sat1": sat1,
        "sat2": sat2,
        "miss_distance_km": distance_km,
        "tca_timestamp": tca,
    })

    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    prompt = CONJUNCTION_ANALYSIS_PROMPT.format(
        sat1=sat1,
        sat2=sat2,
        distance=distance_km,
        velocity=velocity_kms,
        tca=tca,
    )

    result = _call_ai(prompt)
    if result:
        _save_to_cache(cache_key, result)
        return result

    return {
        "risk_summary": "Analysis unavailable",
        "recommendation": "monitor",
        "explanation": "AI service temporarily unavailable. Continue monitoring via standard risk assessment.",
    }


def summarize_top_risks(conjunctions: list[dict], count: int = 3) -> dict:
    """
    Get AI summary of top risk conjunctions.
    Input: list of conjunction dicts with sat1, sat2, distance, risk
    Returns: {summaries: [{sat_pair, summary}, ...]}
    """
    if not OPENROUTER_API_KEY or not conjunctions:
        return {"summaries": []}

    sorted_conjs = sorted(conjunctions, key=lambda x: x.get("distance", 9999))[:count]

    conj_text = "\n".join(
        f"- {c.get('sat1', '?')} vs {c.get('sat2', '?')}: {c.get('distance', 0)} km, {c.get('risk', 'LOW')}"
        for c in sorted_conjs
    )

    prompt = SUMMARY_PROMPT.format(count=count, conjunctions=conj_text)
    result = _call_ai(prompt)

    if result and "summaries" in result:
        return result

    return {"summaries": []}


def invalidate_cache() -> None:
    """Clear AI response cache."""
    with _ai_cache["lock"]:
        _ai_cache["data"].clear()