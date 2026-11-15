# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RUSSELL PHILIP SMITHSON
"""The renderer: an installed Edge, Chrome or Chromium in app mode with a profile of its own, as VEC1 Photon opens it.
The ordinary browser profile (extensions, cookies, sessions) is used only when asked for."""
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path


def candidates():
    env = os.environ.get
    if os.name == "nt":
        roots = [env("ProgramFiles(x86)", ""), env("ProgramFiles", ""), env("LOCALAPPDATA", "")]
        rels = ["Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe"]
        return [Path(r) / rel for rel in rels for r in roots if r]
    if sys.platform == "darwin":
        return [Path(p) for p in ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                                  "/Applications/Chromium.app/Contents/MacOS/Chromium")]
    found = [shutil.which(n) for n in ("microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser")]
    return [Path(f) for f in found if f]


def launch(url, profile_dir, allow_default_fallback=False):
    override = os.environ.get("RINKVT_BROWSER")
    for exe in ([Path(override)] if override else []) + candidates():
        if exe.is_file():
            try:
                Path(profile_dir).mkdir(parents=True, exist_ok=True)
                subprocess.Popen([str(exe), f"--app={url}", f"--user-data-dir={profile_dir}", "--no-first-run",
                                  "--no-default-browser-check", "--disable-extensions", "--new-window"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return str(exe)
            except OSError:
                continue
    if allow_default_fallback:
        webbrowser.open(url, new=1)
        return "default-browser"
    return None
