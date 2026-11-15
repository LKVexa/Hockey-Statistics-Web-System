# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""RINK-VT, LK/Vexa edition: the Photon host.

The control plane that takes Node's place. It follows the VEC1 Design Photon model (a Python main process, a
Chromium-family window as the renderer, a loopback JSON API guarded by Host, Origin and a per-launch token) and
keeps the league: the registry, every game's ledger, and the static loopback lease of this computer.
"""
VERSION = "2.5.0-lkvexa.1"
ENGINE = "2.5.0-rinkvt.1"
PRODUCT = "RINK-VT"
EDITION = "LK/Vexa edition (Photon-hosted)"
