# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""Verify this copy of the LK/Vexa edition, step by step, and say which step failed.

    python tools/verify.py [--data DIR] [--mssl-verifier PATH/TO/VERIFY_MSSL.py] [--quick]

  1  the release: every file against RELEASE_MANIFEST.json
  2  the league in the data folder: seals and chains (skipped while a host holds the folder)
  3  the renderer bundle: built from engine/ and ui/, and current
  4  the contracts: MSSL records and JA21 sources (and, given --mssl-verifier, the MSSL corpus validator)
  5  the tests (--quick leaves out the browser tests)
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def step(n, title, cmd, env=None):
    print(f"\n[{n}] {title}", flush=True)
    p = subprocess.run(cmd, cwd=ROOT, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1", **(env or {})))
    print(f"[{n}] {'PASS' if p.returncode == 0 else 'FAIL'}", flush=True)
    return p.returncode == 0


def main(argv):
    data = argv[argv.index("--data") + 1] if "--data" in argv else os.path.join(ROOT, "runtime")
    py = [sys.executable, "-I", "-B"]
    contracts = py + [os.path.join("tools", "contracts.py"), "check"]
    env = {}
    if "--mssl-verifier" in argv:
        v = argv[argv.index("--mssl-verifier") + 1]
        contracts += ["--mssl-verifier", v]
        env["RINKVT_MSSL_VERIFIER"] = v
    if "--quick" in argv:
        env["RINKVT_SKIP_BROWSER"] = "1"
    results = [
        step(1, "release and league", py + [os.path.join("photon", "rinkvt.py"), "--verify-only", "--data", data]),
        step(2, "renderer bundle", py + [os.path.join("tools", "bundle.py"), "--check"]),
        step(3, "contracts", contracts),
        step(4, "tests", py + ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], env),
    ]
    ok = all(results)
    print("\nRINK-VT LK/Vexa edition: " + ("VERIFIED" if ok else "NOT VERIFIED (see the failed step above)"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
