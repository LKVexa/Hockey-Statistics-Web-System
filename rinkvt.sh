#!/bin/sh
# RINK-VT, LK/Vexa edition: the Photon host's commands (./rinkvt.sh help lists them), e.g. ./rinkvt.sh leases --this-laptop
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "RINK-VT: this release carries the Photon host for Windows, macOS and Linux, not $(uname -s)." >&2; exit 4 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "RINK-VT: this release carries the Photon host for x64 and ARM64, not $(uname -m)." >&2; exit 4 ;;
esac
exe="$ROOT/photon/bin/rinkvt-photon-$os-$arch"
if [ ! -f "$exe" ]; then echo "RINK-VT: $exe is missing. Unpack the whole release again." >&2; exit 4; fi
[ -x "$exe" ] || chmod +x "$exe"
exec "$exe" "$@"
