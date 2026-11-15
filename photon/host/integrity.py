# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Release integrity, checked before anything is opened (as VEC1 Photon does): every file RELEASE_MANIFEST.json
lists must be present with its SHA-256, and no file the host would run or serve may be unlisted. A changed release
is refused, not served; after a deliberate change, reseal it with tools/seal_release.py. Documentation, tests and
contracts are sealed too, and checked when the whole release is verified, but a change to them does not stop a start."""
import hashlib
import json
import os

MANIFEST = "RELEASE_MANIFEST.json"
CODE_DIRS = ("photon", "ui", "engine")            # what runs in the host or the renderer
SKIP_DIRS = {".git", "runtime", "__pycache__", "node_modules", ".pytest_cache"}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def release_files(root):
    """Every file of the release, as manifest paths (forward slashes), in a stable order."""
    out = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if f.endswith((".pyc", ".pyo")):
                continue
            rel = os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/")
            if rel != MANIFEST:
                out.append(rel)
    return out


def verify_release(root, scope="code"):
    """scope "code": what the host runs or serves (photon/, ui/, engine/), checked at every start.
    scope "all": every file of the release, as a distribution is checked (tools/seal_release.py --check, VERIFY)."""
    path = os.path.join(root, MANIFEST)
    try:
        with open(path, encoding="utf-8") as f:
            manifest = json.load(f)
        listed = manifest["files"]
        if not isinstance(listed, dict):
            raise ValueError("files is not an object")
    except (OSError, ValueError, KeyError) as e:
        return {"ok": False, "scope": scope, "error": f"{MANIFEST}: {e}", "missing": [], "changed": [], "unlisted": []}
    in_scope = (lambda rel: rel.split("/", 1)[0] in CODE_DIRS) if scope == "code" else (lambda rel: True)
    missing, changed = [], []
    for rel, want in sorted(listed.items()):
        if not in_scope(rel):
            continue
        p = os.path.join(root, *rel.split("/"))
        if not os.path.isfile(p):
            missing.append(rel)
        elif sha256_file(p) != want:
            changed.append(rel)
    unlisted = [r for r in release_files(root) if r not in listed and in_scope(r)]
    ok = not (missing or changed or unlisted)
    return {"ok": ok, "scope": scope, "version": manifest.get("version"), "files": sum(1 for r in listed if in_scope(r)),
            "missing": missing, "changed": changed, "unlisted": unlisted}
