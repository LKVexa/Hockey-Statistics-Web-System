# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Write RELEASE_MANIFEST.json: the SHA-256 of every file of the release. The Photon host refuses to start when the
release no longer matches it. Run after a deliberate change, and commit the manifest with the change.

    python tools/seal_release.py [--check]
"""
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))
from host import EDITION, ENGINE, PRODUCT, VERSION  # noqa: E402
from host.integrity import MANIFEST, release_files, sha256_file, verify_release  # noqa: E402


def main(argv):
    if "--check" in argv:
        r = verify_release(ROOT, "all")
        print(json.dumps(r, indent=2))
        return 0 if r["ok"] else 1
    files = {rel: sha256_file(os.path.join(ROOT, *rel.split("/"))) for rel in release_files(ROOT)}
    doc = {"product": PRODUCT, "edition": EDITION, "version": VERSION, "engine": ENGINE,
           "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "files": files}
    with open(os.path.join(ROOT, MANIFEST), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, sort_keys=False)
        f.write("\n")
    print(f"{MANIFEST}: {len(files)} files sealed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
