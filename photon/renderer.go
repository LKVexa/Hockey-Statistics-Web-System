// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The renderer: an installed Edge, Chrome or Chromium in app mode with a profile of its own, as VEC1 Photon opens it.
// The ordinary browser profile (extensions, cookies, sessions) is used only when asked for.

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func browserCandidates() []string {
	var out []string
	switch runtime.GOOS {
	case "windows":
		rels := []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`, `Chromium\Application\chrome.exe`}
		for _, rel := range rels {
			for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
				if r := os.Getenv(env); r != "" {
					out = append(out, filepath.Join(r, rel))
				}
			}
		}
	case "darwin":
		out = []string{"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium"}
	default:
		for _, n := range []string{"microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"} {
			if p, err := exec.LookPath(n); err == nil {
				out = append(out, p)
			}
		}
	}
	return out
}

// launchRenderer opens url in an app window on its own profile; it returns what it opened, or "".
func launchRenderer(url, profileDir string, allowDefault bool) string {
	list := browserCandidates()
	if o := os.Getenv("RINKVT_BROWSER"); o != "" {
		list = append([]string{o}, list...)
	}
	for _, exe := range list {
		if st, err := os.Stat(exe); err != nil || st.IsDir() {
			continue
		}
		if err := os.MkdirAll(profileDir, 0o700); err != nil {
			continue
		}
		cmd := exec.Command(exe, "--app="+url, "--user-data-dir="+profileDir, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--new-window")
		if cmd.Start() == nil {
			go cmd.Wait() // reaped when the window closes; the host does not wait for it
			return exe
		}
	}
	if allowDefault {
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		case "darwin":
			cmd = exec.Command("open", url)
		default:
			cmd = exec.Command("xdg-open", url)
		}
		if cmd.Start() == nil {
			go cmd.Wait()
			return "default-browser"
		}
	}
	return ""
}
