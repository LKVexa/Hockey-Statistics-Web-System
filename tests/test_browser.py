# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""End to end: the real host in its own process, the workbench in Chromium, the league on disk.

Needs Playwright for Python and a Chromium build (python -m playwright install chromium); skipped without them.
The release is copied to a scratch folder and sealed there, so the test runs the host exactly as a start does."""
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import unittest

from helpers import ROOT, tempdir

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None



def wait(fn, timeout=30.0, what="a condition"):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


class Host:
    def __init__(self, release, data):
        self.release, self.data = release, data

    def start(self):
        self.p = subprocess.Popen([sys.executable, "-I", "-B", os.path.join(self.release, "photon", "rinkvt.py"), "--data", self.data,
                                   "--no-browser", "--device-file", self.data + ".device.json"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        end = time.time() + 30
        while time.time() < end:
            line = self.p.stdout.readline()
            if not line:
                break
            lines.append(line)
            m = re.search(r"workbench\s+(http://\S+/)", line)
            if m:
                self.url = m.group(1)
                self.log = lines
                return self
        raise AssertionError("the host did not start: " + "".join(lines))

    def stop(self):
        if self.p.poll() is None:
            if os.name == "nt":
                self.p.terminate()                                   # the next start finds the stale lock and takes it
            else:
                self.p.send_signal(signal.SIGTERM)
            try:
                self.p.wait(15)
            except subprocess.TimeoutExpired:
                self.p.kill()
        self.p.stdout.close()


@unittest.skipIf(sync_playwright is None, "Playwright for Python is not installed")
@unittest.skipIf(os.environ.get("RINKVT_SKIP_BROWSER") == "1", "browser tests left out (--quick)")
class Workbench(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        try:
            cls.browser = cls.pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            cls.pw.stop()
            raise unittest.SkipTest(f"no Chromium build for Playwright ({str(e).splitlines()[0][:120]})")
        print(f"\nRINKVT-BROWSER Chromium {cls.browser.version} (Playwright)", file=sys.stderr, flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        scratch = tempdir(self)
        self.release = os.path.join(scratch, "release")
        for d in ("photon", "ui", "engine"):
            shutil.copytree(os.path.join(ROOT, d), os.path.join(self.release, d), ignore=shutil.ignore_patterns("__pycache__"))
        from test_release import seal
        seal(self.release)
        self.data = os.path.join(scratch, "data")
        self.host = Host(self.release, self.data).start()
        self.addCleanup(lambda: self.host.stop())
        self.errors = []

    def page(self):
        pg = self.browser.new_page(viewport={"width": 1400, "height": 900})
        pg.on("pageerror", lambda e: self.errors.append("pageerror " + str(e)))
        pg.on("console", lambda m: self.errors.append("console " + m.text) if m.type == "error" and "409" not in m.text else None)
        pg.goto(self.host.url)
        wait(lambda: re.search("league loaded|could not", pg.inner_text("#h-state")), what="the league to load")
        self.assertIn("league loaded", pg.inner_text("#h-state"))
        return pg

    def run_line(self, pg, line, want, timeout=60.0):
        before = len(pg.inner_text("#out"))
        pg.fill("#cmd", line)
        pg.press("#cmd", "Enter")
        wait(lambda: want in pg.inner_text("#out")[before:], timeout, f"{line!r} to answer {want!r}")
        return pg.inner_text("#out")[before:]

    def test_score_reload_restart_verify(self):
        pg = self.page()
        local = pg.get_attribute('meta[name="rinkvt-local"]', "content")
        self.assertRegex(local, r"^127\.(1[6-9]|2\d|3[01])\.\d+\.\d+$")
        self.assertRegex(pg.inner_text("#h-client"), r"^device [0-9a-f]{8}$")      # static for this laptop, not an IP
        self.assertIn("4 teams", pg.inner_text("#h-league"))
        self.run_line(pg, "rink new FOCO KELW 2026-11-15", "created G1")
        self.run_line(pg, "rink G1", "durable (Photon host")
        for line in ("T 20:00 P1", "START"):
            self.run_line(pg, line, "APPLIED")
        time.sleep(1.1)
        self.run_line(pg, "FOCO SMIT S/2W", "COMMITTED")
        wait(lambda: "recorded" in pg.inner_text("#h-state"), what="the line to be recorded")
        audit = self.run_line(pg, "Q AUDIT", "audit entries")
        self.assertIn(local, audit)                                  # every line records this computer's lease

        pg.reload()
        wait(lambda: "league loaded" in pg.inner_text("#h-state"), what="the reload")
        self.assertRegex(self.run_line(pg, "Q EVENTS", "events"), r"FOCO\s+SMIT\s+S/2W")

        self.host.stop()                                             # a new process, the same league and lease
        self.host = Host(self.release, self.data).start()
        pg2 = self.page()
        self.assertEqual(pg2.get_attribute('meta[name="rinkvt-local"]', "content"), local)
        self.assertIn("1 game", pg2.inner_text("#h-league"))
        out = self.run_line(pg2, "store verify", "event ledger")
        self.assertRegex(out, r"OK\s+registry sealed")
        self.assertRegex(out, r"G1\s+3 entries · chain intact")
        self.assertEqual(self.errors, [])

    def test_start_frame(self):
        pg = self.page()
        self.run_line(pg, "rink new FOCO KELW 2026-11-15", "START at the opening faceoff")
        self.run_line(pg, "rink G1", "EXIT")
        time.sleep(1.5)
        score = pg.inner_text("#score")
        self.assertIn("20:00", score)
        self.assertIn("not started", score)                              # a new game's clock waits
        self.run_line(pg, "T 20:00 P1", "APPLIED")
        out = self.run_line(pg, "GO", "has not started")
        self.assertIn("REJECTED", out)
        self.assertIn("game started", self.run_line(pg, "START", "APPLIED"))
        time.sleep(1.6)
        score = pg.inner_text("#score")
        self.assertNotIn("not started", score)
        self.assertRegex(score, r"P1 19:5\d")                           # running since the start frame
        self.assertIn("the game started at P1 20:00", self.run_line(pg, "START", "REJECTED"))
        self.run_line(pg, "STOP", "APPLIED")
        self.run_line(pg, "GO", "APPLIED")
        audit = self.run_line(pg, "Q AUDIT", "audit entries")
        self.assertIn("CLOCK START", audit)                              # the start frame is in the ledger
        self.assertEqual(self.errors, [])

    def test_simulation_and_two_windows(self):
        a = self.page()
        out = self.run_line(a, "rink sim 2", "synthetic games typed", 180)
        self.assertRegex(out, r"G2 ")
        self.assertNotIn("rejected", out)                                # the simulator starts each game with START
        wait(lambda: "recorded" in a.inner_text("#h-state"), 60, "the simulation to be recorded")
        b = self.page()
        self.assertIn("2 games", b.inner_text("#h-league"))
        self.run_line(a, "rink new KELW FOCO 2026-11-16", "created G3")
        out = self.run_line(b, "rink new FOCO KELW 2026-11-17", "NOT RECORDED")
        self.assertIn("409", out)
        wait(lambda: "3 games" in b.inner_text("#h-league"), 30, "the second window to load the league again")
        self.assertIn("G3", self.run_line(b, "rink games", "G3"))     # the refused window carries on with the league
        out = self.run_line(b, "store verify", "event ledger")
        self.assertIn("OK", out)
        self.assertEqual(self.errors, [])


if __name__ == "__main__":
    unittest.main()
