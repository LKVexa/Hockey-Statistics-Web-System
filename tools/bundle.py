# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Build the renderer's files from the engine sources, without Node.js.

    python tools/bundle.py          writes ui/workbench.js and ui/workbench.html
    python tools/bundle.py --check  exits 1 if they are not what the sources give (a stale bundle)

workbench.js is the module loader (ui/loader.js) holding the engine's modules and data, the rink drawing
(engine/rink/web/rink.js) and the page (ui/app.js). workbench.html is ui/workbench.template.html with the version.
Nothing is minified or rewritten: the page runs the engine's own source text.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "photon"))
from host import VERSION  # noqa: E402

MODULES = [
    "rink/shared/codes.js", "rink/shared/hcl.js", "rink/shared/wire.js", "rink/shared/xg.js", "rink/shared/fmt.js", "rink/shared/assist.js", "rink/shared/hash.js",
    "rink/server/registry.js", "rink/server/demo.js", "rink/server/actor.js", "rink/server/driver.js", "rink/server/derive.js", "rink/server/models.js", "rink/server/heat.js",
    "rink/server/ssdram.js", "rink/server/query.js", "rink/server/hkbridge.js", "rink/server/sim.js", "rink/server/roster-file.js", "rink/server/roster-plan.js",
    "rink/server/importer.js", "rink/server/service.js", "rink/server/inproc.js",
    "rink/hk001/gomath.js", "rink/hk001/engine.js", "rink/hk001/adapter.js", "rink/hk001/inputs.js", "rink/hk001/catalog.js", "rink/hk001/lab.js",
    "rink/term/render.js", "src/main/spiral/registry.js", "src/main/spiral/commands/rink.js",
]
JSONS = ["rink/corpus/corpus.json", "rink/hk001/html5-entities.json", "rink/hk001/go-tables.json"]


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def engine_js():
    """The module loader holding the engine's modules and data tables: what the page runs, without the page."""
    mods = []
    for m in MODULES:
        mods.append(f"D[{json.dumps(m)}]=function(module,exports,require,__dirname,__filename){{\n{read('engine', *m.split('/'))}\n}};\n")
    for m in JSONS:
        mods.append(f"J[{json.dumps(m)}]={json.dumps(json.loads(read('engine', *m.split('/'))), ensure_ascii=False, separators=(',', ':'))};\n")
    loader = read("ui", "loader.js")
    if loader.count("/*MODULES*/") != 1:
        raise SystemExit("ui/loader.js: the /*MODULES*/ mark is missing")
    return loader.replace("/*MODULES*/", "".join(mods))


def build():
    js = (f"/* RINK-VT {VERSION} · LK/Vexa edition · the renderer bundle, built by tools/bundle.py from engine/ and ui/.\n"
          " * Copyright (C) 2026 RUSSELL PHILIP SMITHSON · SPDX-License-Identifier: GPL-3.0-only · no warranty: see LICENSE.\n"
          " * The engine's Go-derived parts keep their notices in engine/rink/hk001/NOTICE.md. */\n"
          + engine_js() + "\n" + read("engine", "rink", "web", "rink.js") + "\n" + read("ui", "app.js"))
    html = read("ui", "workbench.template.html").replace("@VERSION@", VERSION)
    return js, html


def main(argv):
    js, html = build()
    out = {"workbench.js": js, "workbench.html": html}
    if "--check" in argv:
        stale = [n for n, text in out.items() if not os.path.exists(os.path.join(ROOT, "ui", n)) or read("ui", n) != text]
        if stale:
            print("stale: " + ", ".join(stale) + " (run python tools/bundle.py)")
            return 1
        print("the renderer bundle matches its sources")
        return 0
    for n, text in out.items():
        with open(os.path.join(ROOT, "ui", n), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    print(f"ui/workbench.js {len(js.encode()) // 1024} KiB ({len(MODULES)} modules + {len(JSONS)} JSON) · ui/workbench.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
