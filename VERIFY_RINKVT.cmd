@echo off
rem RINK-VT, LK/Vexa edition: verify the release, the league, the contracts and the tests.
rem Copyright (C) 2026 RUSSELL PHILIP SMITHSON. GPL-3.0-only; no warranty: see LICENSE.
setlocal
set "HERE=%~dp0"
set "PY="
py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not defined PY if not errorlevel 1 set "PY=python"
if not defined PY python3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not defined PY if not errorlevel 1 set "PY=python3"
if not defined PY (
  echo RINK-VT needs Python 3.10 or newer.
  pause
  exit /b 3
)
cd /d "%HERE%"
%PY% -I -B tools\verify.py %*
set "RC=%ERRORLEVEL%"
pause
exit /b %RC%
