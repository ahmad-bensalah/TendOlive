#!/usr/bin/env bash
# Start the OliveSoft RAG dashboard (macOS / Linux): ./start.sh
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python was not found. Install Python 3.10 or newer."; exit 1
fi
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || { echo "Python 3.10 or newer is needed."; exit 1; }

if [ ! -x .venv/bin/python ]; then
  echo "Creating the virtual environment. This happens only once..."
  "$PY" -m venv .venv
fi

echo "Checking the packages. The first run downloads about 1 GB, please wait..."
.venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt

exec .venv/bin/python app.py --host 0.0.0.0 "$@"

