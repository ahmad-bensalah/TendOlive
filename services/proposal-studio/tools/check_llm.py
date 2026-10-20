#!/usr/bin/env python3
"""
Groq API verification utility for RFP Studio agents.
Checks connectivity and credentials against Groq's OpenAI-compatible completions API.
Standard library only (urllib, json, os, sys). Never prints or logs API keys.
"""

import json
import os
import sys
import urllib.request
import urllib.error
import socket


def check_groq():
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    model = os.environ.get("GROQ_MODEL", "").strip()
    base_url = os.environ.get("GROQ_BASE_URL", "").strip()
    if not base_url:
        base_url = "https://api.groq.com/openai/v1"
    
    endpoint = f"{base_url.rstrip('/')}/chat/completions"

    missing = []
    if not api_key:
        missing.append("GROQ_API_KEY")
    if not model:
        missing.append("GROQ_MODEL")

    if missing:
        print(f"Error / Erreur: Variable(s) manquante(s) / Missing environment variable(s): {', '.join(missing)}")
        print("Please export them in your terminal before running / Veuillez les exporter dans votre terminal :")
        print('  macOS / Linux:  export GROQ_API_KEY="..." ; export GROQ_MODEL="..."')
        print('  Windows cmd:    set GROQ_API_KEY=... & set GROQ_MODEL=...')
        sys.exit(1)

    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": 'Respond with exact JSON: {"ok": true}'}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
        "max_tokens": 16,
    }

    req_data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=req_data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "rfp-studio-check-llm/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=20.0) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(body)
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                if parsed.get("ok") is True:
                    print("OK: Groq API connection and model verified successfully.")
                    sys.exit(0)
                else:
                    print(f"OK: Groq answered (HTTP {status}) with valid JSON.")
                    sys.exit(0)
            except Exception:
                print("Error / Erreur: Réponse JSON invalide reçue de l'API / Invalid JSON response received from API.")
                sys.exit(1)

    except urllib.error.HTTPError as e:
        status_code = e.code
        headers = e.headers or {}

        if status_code == 401:
            print("Error / Erreur (401): Clé API invalide / Invalid GROQ_API_KEY. Authentication failed.")
            sys.exit(1)
        elif status_code in (400, 404):
            print(f"Error / Erreur ({status_code}): Modèle non trouvé ou requête invalide. Vérifiez le nom du modèle dans la console Groq / Check the model name in the Groq console (https://console.groq.com/docs/models).")
            sys.exit(1)
        elif status_code == 429:
            retry_after = headers.get("retry-after") or headers.get("Retry-After") or headers.get("x-ratelimit-reset") or ""
            if retry_after:
                print(f"Error / Erreur (429): Limite de requêtes atteinte / Rate limit exceeded. Retry-After: {retry_after}")
            else:
                print("Error / Erreur (429): Limite de requêtes atteinte / Rate limit exceeded.")
            sys.exit(1)
        else:
            print(f"Error / Erreur (HTTP {status_code}): Groq API returned status {status_code}.")
            sys.exit(1)

    except (urllib.error.URLError, socket.gaierror, ConnectionError) as e:
        # Check if it was a socket timeout wrapped in URLError
        reason = getattr(e, "reason", e)
        if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(reason).lower():
            print("Error / Erreur (Timeout): La requête vers l'API Groq a expiré après 20 secondes (timeout 20s).")
        else:
            print(f"Error / Erreur (Réseau / Network): Impossible de contacter l'API Groq / Network error reaching API ({reason}).")
        sys.exit(1)

    except (TimeoutError, socket.timeout):
        print("Error / Erreur (Timeout): La requête vers l'API Groq a expiré après 20 secondes (timeout 20s).")
        sys.exit(1)

    except Exception as e:
        print(f"Error / Erreur: {type(e).__name__} - {e}")
        sys.exit(1)


if __name__ == "__main__":
    check_groq()
