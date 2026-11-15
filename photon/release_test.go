// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Release integrity, the renderer bundle, the page's own policy, and the verification commands.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

func releaseOK(r Obj) bool { ok, _ := r.Get("ok"); return ok == true }

func TestReleaseSealedReleasePasses(t *testing.T) {
	rel := sealedRelease(t)
	fatalIf(t, !releaseOK(verifyRelease(rel, "all")) || !releaseOK(verifyRelease(rel, "code")), "a freshly sealed release does not pass")
}

func TestReleaseChangedCodeRefused(t *testing.T) {
	rel := sealedRelease(t)
	p := filepath.Join(rel, "ui", "app.js")
	raw, _ := os.ReadFile(p)
	os.WriteFile(p, append(raw, []byte("\n// changed\n")...), 0o644)
	r := verifyRelease(rel, "code")
	changed, _ := r.Get("changed")
	fatalIf(t, releaseOK(r) || len(changed.([]any)) != 1, "a changed file was not refused")
}

func TestReleaseUnlistedAndMissingCodeRefused(t *testing.T) {
	rel := sealedRelease(t)
	os.WriteFile(filepath.Join(rel, "engine", "extra.js"), []byte("1"), 0o644)
	os.Remove(filepath.Join(rel, "ui", "workbench.css"))
	r := verifyRelease(rel, "code")
	missing, _ := r.Get("missing")
	unlisted, _ := r.Get("unlisted")
	fatalIf(t, releaseOK(r) || len(missing.([]any)) != 1 || len(unlisted.([]any)) != 1, "missing and unlisted files were not refused")
}

func TestReleaseDocumentationChangeDoesNotStopAStart(t *testing.T) {
	rel := sealedRelease(t)
	os.WriteFile(filepath.Join(rel, "README.md"), []byte("added after sealing\n"), 0o644)
	fatalIf(t, !releaseOK(verifyRelease(rel, "code")), "a documentation change stopped a start")
	fatalIf(t, releaseOK(verifyRelease(rel, "all")), "a documentation change passed a full verification")
}

func TestReleaseHostRefusesAChangedRelease(t *testing.T) {
	rel := sealedRelease(t)
	os.WriteFile(filepath.Join(rel, "engine", "rink", "shared", "hcl.js"), []byte("// tampered\n"), 0o644)
	t.Setenv("RINKVT_ROOT", rel)
	code := runHost([]string{"--data", t.TempDir(), "--no-browser", "--device-file", filepath.Join(t.TempDir(), "d.json")})
	fatalIf(t, code != exitIntegrity, "the host started a changed release (exit %d)", code)
}

func snapshotTree(t *testing.T, dir string) map[string]string {
	out := map[string]string{}
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil {
			rel, _ := filepath.Rel(dir, p)
			h := "dir"
			if !info.IsDir() {
				h, _ = sha256File(p)
			}
			out[rel] = h + info.ModTime().String()
		}
		return nil
	})
	return out
}

func TestReleaseVerifyOnlyReadsAndWritesNothing(t *testing.T) {
	rel := sealedRelease(t)
	t.Setenv("RINKVT_ROOT", rel)
	data := filepath.Join(t.TempDir(), "league")
	copyTree(t, filepath.Join("testdata", "earlier-league"), data, nil)
	os.WriteFile(filepath.Join(data, "league", "ledger", "G1-6e49bb4c.jsonl"), append(mustRead(t, filepath.Join(data, "league", "ledger", "G1-6e49bb4c.jsonl")), []byte(`{"n":3,`)...), 0o600)
	before := snapshotTree(t, data)
	out, code := captureStdout(t, func() int {
		return runHost([]string{"--verify-only", "--data", data, "--device-file", filepath.Join(t.TempDir(), "none.json")})
	})
	fatalIf(t, code != exitFail || !strings.Contains(out, "unfinished line"), "verify-only on a cut-off line: %d %s", code, out)
	after := snapshotTree(t, data)
	fatalIf(t, len(before) != len(after), "verify-only made or removed files")
	for k, v := range before {
		fatalIf(t, after[k] != v, "verify-only changed %s", k)
	}
}

func mustRead(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	fatalIf(t, err != nil, "%v", err)
	return b
}

// The verify command on a whole release: a copy of the working tree with its contracts written and a qualification
// record for this version (a fixture: the record a passing qualification writes), sealed. The command must find it
// VERIFIED in all five steps, and NOT VERIFIED once one sealed file changes.
func TestReleaseVerifyCommandPasses(t *testing.T) {
	root := repoRoot(t)
	rel := filepath.Join(t.TempDir(), "release")
	for _, d := range []string{"photon", "ui", "engine", "contracts"} {
		copyTree(t, filepath.Join(root, d), filepath.Join(rel, d), func(r string) bool { return d == "photon" && r == "bin" })
	}
	fatalIf(t, writeContracts(rel) != nil, "the contracts could not be written")
	facts := Obj{{"target", fmt.Sprintf("RINK-VT %s (engine %s)", VERSION, ENGINE)}, {"result", "PASS"}, {"checks", 1}, {"passed", 1},
		{"skipped", 0}, {"failed", 0}, {"covered", []any{"photon/release_test.go"}}, {"evidence", []any{"a test fixture"}},
		{"platform", "a test fixture"}, {"run_at", "2026-11-15T00:00:00Z"}, {"scope_limit", "a test fixture"}}
	os.WriteFile(filepath.Join(rel, "contracts", "mssl", qualificationFile),
		[]byte(msslDocument("mssl:rinkvt:lkvexa:qualification:"+VERSION, "rinkvt.lkvexa.qualification", facts)), 0o644)
	_, err := writeManifest(rel)
	fatalIf(t, err != nil, "seal: %v", err)
	t.Setenv("RINKVT_ROOT", rel)
	args := []string{"--data", t.TempDir(), "--device-file", filepath.Join(t.TempDir(), "device.json")}
	out, code := captureStdout(t, func() int { return cmdVerify(args) })
	fatalIf(t, code != 0 || !strings.Contains(out, "VERIFIED") || strings.Contains(out, "NOT VERIFIED") || strings.Count(out, ": PASS") != 5, "verify: %s", out)
	os.WriteFile(filepath.Join(rel, "ui", "workbench.css"), append(mustRead(t, filepath.Join(rel, "ui", "workbench.css")), '\n'), 0o644)
	out, code = captureStdout(t, func() int { return cmdVerify(args) })
	fatalIf(t, code == 0 || !strings.Contains(out, "NOT VERIFIED") || !strings.Contains(out, "ui/workbench.css"), "verify after a change: %s", out)
}

func TestReleaseHostSelfTestPasses(t *testing.T) {
	failed := hostSelfTest(t.TempDir())
	fatalIf(t, len(failed) > 0, "the host self-test: %v", failed)
}

func TestReleaseBundleIsCurrent(t *testing.T) {
	stale, err := bundleStale(repoRoot(t))
	fatalIf(t, err != nil || len(stale) > 0, "the renderer bundle is stale: %v %v (rinkvt-photon bundle)", stale, err)
}

func TestReleaseEngineIsTheReferenceEngineTree(t *testing.T) {
	root := repoRoot(t)
	for _, m := range append(append([]string{}, bundleModules...), bundleJSONs...) {
		fatalIf(t, !exists(filepath.Join(root, "engine", filepath.FromSlash(m))), "engine/%s is missing", m)
	}
}

func TestReleasePageObeysItsPolicy(t *testing.T) {
	root := repoRoot(t)
	html := string(mustRead(t, filepath.Join(root, "ui", "workbench.html")))
	for what, re := range map[string]string{"inline script": `<script[^>]*>\s*\S`, "inline style element": `<style`, "style attribute": `\sstyle=`,
		"event handler attribute": `\son[a-z]+=`, "a resource from another host": `(src|href)="(https?:)?//`} {
		if what == "inline script" {
			for _, m := range regexp.MustCompile(`<script([^>]*)>\s*\S`).FindAllStringSubmatch(html, -1) {
				fatalIf(t, !strings.Contains(m[1], "src="), "the page has an inline script")
			}
			continue
		}
		fatalIf(t, regexp.MustCompile(re).MatchString(html), "the page has %s", what)
	}
	css := string(mustRead(t, filepath.Join(root, "ui", "workbench.css")))
	fatalIf(t, strings.Contains(css, "@import") || regexp.MustCompile(`url\((?:[^d]|d[^a])`).MatchString(css), "the stylesheet loads a resource")
}

func TestReleaseNoPythonAndNoNodeAnywhere(t *testing.T) {
	root := repoRoot(t)
	var found []string
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if info.IsDir() && (info.Name() == ".git" || info.Name() == "runtime") {
			return filepath.SkipDir
		}
		if !info.IsDir() && (strings.HasSuffix(p, ".py") || strings.HasSuffix(p, ".pyc") || info.Name() == "package.json" || info.Name() == "requirements.txt") {
			found = append(found, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(found)
	fatalIf(t, len(found) > 0, "the release carries Python or Node.js files: %v", found)
	for _, l := range []string{"START_RINKVT.cmd", "VERIFY_RINKVT.cmd", "START_RINKVT.sh", "VERIFY_RINKVT.sh", "RINKVT.cmd", "rinkvt.sh"} {
		text := strings.ToLower(string(mustRead(t, filepath.Join(root, l))))
		fatalIf(t, strings.Contains(text, "python") || strings.Contains(text, "node"), "%s looks for Python or Node.js", l)
	}
}
