#!/bin/sh
# Rebuild the Photon host for every platform the release carries. Needs the Go toolchain (go.dev); the release
# already carries the results in photon/bin, so running RINK-VT needs nothing at all. Reproducible: no cgo, paths
# trimmed, no build id; the same Go version gives the same bytes. Then reseal: ../rinkvt.sh seal
set -eu
cd "$(dirname "$0")"
for t in windows/amd64 windows/arm64 darwin/arm64 darwin/amd64 linux/amd64 linux/arm64; do
  os=${t%/*}; arch=${t#*/}; ext=; [ "$os" = windows ] && ext=.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -buildid=" -o "bin/rinkvt-photon-$os-$arch$ext" .
  echo "bin/rinkvt-photon-$os-$arch$ext"
done
