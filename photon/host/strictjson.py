# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""One strict JSON reader for every request and every stored document: no duplicate keys, no NaN or Infinity,
bounded depth. A document that a lenient reader would accept differently is refused instead."""
import json

MAX_DEPTH = 64


def _pairs(items):
    out = {}
    for k, v in items:
        if k in out:
            raise ValueError(f"duplicate key {k[:40]!r}")
        out[k] = v
    return out


def _const(name):
    raise ValueError(f"{name} is not JSON")


def _depth(v, d=0):
    if d > MAX_DEPTH:
        raise ValueError("JSON nested too deeply")
    if isinstance(v, dict):
        for x in v.values():
            _depth(x, d + 1)
    elif isinstance(v, list):
        for x in v:
            _depth(x, d + 1)


def loads(raw):
    text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    v = json.loads(text, object_pairs_hook=_pairs, parse_constant=_const)
    _depth(v)
    return v
