# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The release: the integrity gate, the renderer bundle and the page's policy."""
import os
import re
import shutil
import subprocess
import sys
import unittest

from helpers import ROOT, tempdir

from host.integrity import release_files, sha256_file, verify_release


def seal(root):
    import json
    files = {rel: sha256_file(os.path.join(root, *rel.split("/"))) for rel in release_files(root)}
    with open(os.path.join(root, "RELEASE_MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump({"version": "test", "files": files}, f)


class Integrity(unittest.TestCase):
    def setUp(self):
        self.root = os.path.join(tempdir(self), "release")
        for d in ("photon", "ui", "engine"):
            shutil.copytree(os.path.join(ROOT, d), os.path.join(self.root, d), ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(os.path.join(ROOT, "README.md"), self.root)
        seal(self.root)

    def test_sealed_release_passes(self):
        self.assertTrue(verify_release(self.root, "code")["ok"])
        self.assertTrue(verify_release(self.root, "all")["ok"])

    def test_changed_code_refused(self):
        with open(os.path.join(self.root, "ui", "app.js"), "a", encoding="utf-8") as f:
            f.write("\n// changed\n")
        r = verify_release(self.root, "code")
        self.assertFalse(r["ok"])
        self.assertEqual(r["changed"], ["ui/app.js"])

    def test_unlisted_and_missing_code_refused(self):
        with open(os.path.join(self.root, "photon", "host", "extra.py"), "w", encoding="utf-8") as f:
            f.write("print('not sealed')\n")
        os.remove(os.path.join(self.root, "engine", "rink", "server", "sim.js"))
        r = verify_release(self.root, "code")
        self.assertEqual(r["unlisted"], ["photon/host/extra.py"])
        self.assertEqual(r["missing"], ["engine/rink/server/sim.js"])

    def test_documentation_change_does_not_stop_a_start(self):
        with open(os.path.join(self.root, "README.md"), "a", encoding="utf-8") as f:
            f.write("\nlocal note\n")
        self.assertTrue(verify_release(self.root, "code")["ok"])
        self.assertEqual(verify_release(self.root, "all")["changed"], ["README.md"])

    def test_host_refuses_a_changed_release(self):
        with open(os.path.join(self.root, "photon", "host", "server.py"), "a", encoding="utf-8") as f:
            f.write("\n# changed\n")
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(self.root, "photon", "rinkvt.py"), "--data", os.path.join(self.root, "runtime"), "--no-browser"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 4, p.stderr)
        self.assertIn("REFUSED", p.stderr)


    def test_verify_only_reads_and_writes_nothing(self):
        from helpers import b64, new_uuid, pairs, registry
        from host.store import LeagueStore
        data = os.path.join(tempdir(self), "league-copy")             # outside the release: a backup elsewhere
        u = new_uuid()
        LeagueStore(data).commit(registry=registry([("G1", u)]), base=None, ledgers=[{"game": "G1", "uuid": u, "start": 0, "data": b64(pairs(u, 0, 2))}])
        ledger = os.path.join(data, "league", "ledger", f"G1-{u[:8]}.jsonl")
        with open(ledger, "ab") as f:
            f.write(b'{"n":2')                                      # a cut-off line: reported, not repaired
        before = {os.path.join(d, x): os.path.getmtime(os.path.join(d, x)) for d, _, fs in os.walk(data) for x in fs}
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(self.root, "photon", "rinkvt.py"), "--verify-only", "--data", data],
                           capture_output=True, text=True, timeout=60)
        import json
        report = json.loads(p.stdout)
        self.assertEqual(p.returncode, 1)
        self.assertTrue(report["release"]["ok"])
        self.assertIn("unfinished line", report["league"]["games"][0]["error"])
        after = {os.path.join(d, x): os.path.getmtime(os.path.join(d, x)) for d, _, fs in os.walk(data) for x in fs}
        self.assertEqual(after, before)                              # no lock made, nothing truncated
        with open(ledger, "rb") as f:
            self.assertTrue(f.read().endswith(b'{"n":2'))


class Bundle(unittest.TestCase):
    def test_bundle_is_current(self):
        p = subprocess.run([sys.executable, "-I", "-B", os.path.join(ROOT, "tools", "bundle.py"), "--check"], capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_engine_is_the_reference_engine_tree(self):
        with open(os.path.join(ROOT, "tools", "bundle.py"), encoding="utf-8") as f:
            text = f.read()
        modules = re.findall(r'"((?:rink|src)/[^"]+\.(?:js|json))"', text)
        for m in modules:
            self.assertTrue(os.path.isfile(os.path.join(ROOT, "engine", *m.split("/"))), m)

    def test_page_obeys_its_policy(self):
        with open(os.path.join(ROOT, "ui", "workbench.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>\s*\S", "inline script")
        self.assertNotRegex(html, r"<style", "inline style element")
        self.assertNotRegex(html, r"\sstyle=", "style attribute")
        self.assertNotRegex(html, r"\son[a-z]+=", "event handler attribute")
        self.assertNotRegex(html, r"(src|href)=\"(https?:)?//", "a resource from another host")
        with open(os.path.join(ROOT, "ui", "workbench.css"), encoding="utf-8") as f:
            css = f.read()
        self.assertNotIn("@import", css)
        self.assertNotRegex(css, r"url\((?!data:)", "a stylesheet resource")


if __name__ == "__main__":
    unittest.main()
