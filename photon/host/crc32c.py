# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""CRC-32C (Castagnoli), as the engine seals its 64-byte frames and meta lines."""
_T = []
for _n in range(256):
    _c = _n
    for _ in range(8):
        _c = (_c >> 1) ^ 0x82F63B78 if _c & 1 else _c >> 1
    _T.append(_c)


def crc32c(data, end=None):
    c = 0xFFFFFFFF
    for b in data[: len(data) if end is None else end]:
        c = _T[(c ^ b) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF
