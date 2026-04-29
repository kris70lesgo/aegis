import requests
import os
import json

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
print("API key loaded:", GEMINI_API_KEY[:15] + "...")

GEMINI_MODEL = "gemini-1.5-flash-8b"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

prompt = "You are a space situational awareness expert. Analyze this conjunction and respond ONLY with valid JSON. Data: STARLINK-1001 vs STARLINK-1050 at 1.5km. Respond with: {\"risk_summary\": \"test\", \"recommendation\": \"monitor\", \"explanation\": \"test\"}"

headers = {"Content-Type": "application/json"}
params = {"key": GEMINI_API_KEY}
payload = {
    "contents": [{"parts": [{"text": prompt}]},
    "generationConfig": {
        "temperature": 0.3,
        "maxOutputTokens": 256,
    },
}

try:
    resp = requests.post(GEMINI_URL, headers=headers, params=params, json=payload, timeout=15)
    print("Status:", resp.status_code)
    if resp.status_code != 200:
        print("Error response:", resp.text[:500])
    else:
        data = resp.json()
        print("Response:", json.dumps(data, indent=2)[:800])
except Exception as e:
    print("Exception:", e)