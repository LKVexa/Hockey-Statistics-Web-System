#!/bin/sh
# RINK-VT, LK/Vexa edition: start the Photon host and open the workbench.
# Nothing to install: the host is the native program in photon/bin, part of this release.
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
