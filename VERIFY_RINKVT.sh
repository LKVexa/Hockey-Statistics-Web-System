#!/bin/sh
# RINK-VT, LK/Vexa edition: verify the release, the league, the contracts and the tests.
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON. GPL-3.0-only; no warranty: see LICENSE.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$here"
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    exec "$py" -I -B tools/verify.py "$@"
  fi
done
echo "RINK-VT needs Python 3.10 or newer." >&2
exit 3
