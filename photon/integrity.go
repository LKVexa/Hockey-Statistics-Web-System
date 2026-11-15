// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Release integrity, checked before anything is opened (as VEC1 Photon does): every file RELEASE_MANIFEST.json lists
// must be present with its SHA-256, and no file the host would run or serve may be unlisted. A changed release is
// refused, not served; after a deliberate change, reseal it (rinkvt-photon seal). Documentation, tests and contracts
// are sealed too, and checked when the whole release is verified, but a change to them does not stop a start.
//
// One instance per data folder: two hosts appending to the same ledgers would corrupt them.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const manifestName = "RELEASE_MANIFEST.json"

var codeDirs = map[string]bool{"photon": true, "ui": true, "engine": true} // what runs in the host or the renderer
var skipDirs = map[string]bool{".git": true, "runtime": true, "__pycache__": true, "node_modules": true, ".pytest_cache": true}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// releaseFiles lists every file of the release as manifest paths (forward slashes): a directory's files in sorted
// order, then its subdirectories in sorted order, as every release has listed them.
func releaseFiles(root string) []string {
	var out []string
	var walk func(dir, rel string)
	walk = func(dir, rel string) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		var files, dirs []string
		for _, e := range entries {
			if e.IsDir() {
				if !skipDirs[e.Name()] {
					dirs = append(dirs, e.Name())
				}
			} else if !strings.HasSuffix(e.Name(), ".pyc") && !strings.HasSuffix(e.Name(), ".pyo") {
				files = append(files, e.Name())
			}
		}
		sort.Strings(files)
		sort.Strings(dirs)
		for _, f := range files {
			p := f
			if rel != "" {
				p = rel + "/" + f
			}
			if p != manifestName {
				out = append(out, p)
			}
		}
		for _, d := range dirs {
			p := d
			if rel != "" {
				p = rel + "/" + d
			}
			walk(filepath.Join(dir, d), p)
		}
	}
	walk(root, "")
	return out
}

func inScope(scope, rel string) bool {
	if scope != "code" {
		return true
	}
	return codeDirs[strings.SplitN(rel, "/", 2)[0]]
}

// verifyRelease checks scope "code" (what the host runs or serves: photon/, ui/, engine/), at every start, or scope
// "all" (every file of the release), as a distribution is checked.
func verifyRelease(root, scope string) Obj {
	empty := []any{}
	raw, err := os.ReadFile(filepath.Join(root, manifestName))
	var listed Obj
	version := any(nil)
	if err == nil {
		var v any
		if v, err = parseJSON(string(raw)); err == nil {
			doc, ok := v.(Obj)
			files, has := doc.Get("files")
			listed, _ = files.(Obj)
			if !ok || !has || listed == nil {
				err = fmt.Errorf("files is not an object")
			} else {
				version, _ = doc.Get("version")
			}
		}
	}
	if err != nil {
		return Obj{{"ok", false}, {"scope", scope}, {"error", fmt.Sprintf("%s: %v", manifestName, err)}, {"missing", empty}, {"changed", empty}, {"unlisted", empty}}
	}
	missing, changed, unlisted := []any{}, []any{}, []any{}
	keys := listed.Keys()
	sort.Strings(keys)
	known := map[string]bool{}
	count := 0
	for _, rel := range keys {
		known[rel] = true
		if !inScope(scope, rel) {
			continue
		}
		count++
		want, _ := listed.Get(rel)
		p := filepath.Join(root, filepath.FromSlash(rel))
		if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() {
			missing = append(missing, rel)
		} else if got, err := sha256File(p); err != nil || got != want {
			changed = append(changed, rel)
		}
	}
	for _, rel := range releaseFiles(root) {
		if !known[rel] && inScope(scope, rel) {
			unlisted = append(unlisted, rel)
		}
	}
	ok := len(missing) == 0 && len(changed) == 0 && len(unlisted) == 0
	return Obj{{"ok", ok}, {"scope", scope}, {"version", version}, {"files", count}, {"missing", missing}, {"changed", changed}, {"unlisted", unlisted}}
}

// writeManifest seals the release: the SHA-256 of every file.
func writeManifest(root string) (int, error) {
	files := Obj{}
	for _, rel := range releaseFiles(root) {
		h, err := sha256File(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return 0, err
		}
		files = append(files, KV{rel, h})
	}
	doc := Obj{{"product", PRODUCT}, {"edition", EDITION}, {"version", VERSION}, {"engine", ENGINE},
		{"generated", time.Now().UTC().Format("2006-01-02T15:04:05Z")}, {"files", files}}
	return len(files), os.WriteFile(filepath.Join(root, manifestName), []byte(pyDumpsIndent(doc, 1, true, false)+"\n"), 0o644)
}

// ---- one host per data folder ------------------------------------------------------------------------------

type InstanceLock struct {
	path string
	held bool
}

func (l *InstanceLock) read() (Obj, bool) {
	raw, err := os.ReadFile(l.path)
	if err != nil {
		return nil, false
	}
	v, err := parseJSON(string(raw))
	o, ok := v.(Obj)
	return o, err == nil && ok
}

func (l *InstanceLock) acquire() error {
	host, _ := os.Hostname()
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			doc := Obj{{"pid", os.Getpid()}, {"host", host}, {"at", float64(time.Now().UnixNano()) / 1e9}}
			_, err = f.WriteString(pyDumps(doc, true, false))
			f.Close()
			if err != nil {
				return err
			}
			l.held = true
			return nil
		}
		if !os.IsExist(err) {
			return err
		}
		cur, _ := l.read()
		pid, hasPid := numberInt(func() any { x, _ := cur.Get("pid"); return x }())
		hv, hasHost := cur.Get("host")
		holder, _ := hv.(string)
		if hasHost && holder == host && hasPid && processAlive(int(pid)) {
			return fmt.Errorf("the data folder is in use by process %d: one Photon host per data folder. Stop that host, or delete %s if it is gone", pid, l.path)
		}
		if hasHost && hv != nil && holder != host {
			return fmt.Errorf("the data folder is in use by the host on %v; a data folder belongs to one computer at a time", hv)
		}
		os.Remove(l.path) // stale: its process is gone
	}
	return fmt.Errorf("could not take the data folder")
}

// holder describes who holds the folder, without taking it; "" when no live host does.
func (l *InstanceLock) holder() string {
	cur, ok := l.read()
	if !ok {
		return ""
	}
	host, _ := os.Hostname()
	hv, hasHost := cur.Get("host")
	if h, _ := hv.(string); hasHost && hv != nil && h != host {
		return fmt.Sprintf("the data folder is held by the host on %v", hv)
	}
	pid, hasPid := numberInt(func() any { x, _ := cur.Get("pid"); return x }())
	if hasPid && int(pid) != os.Getpid() && processAlive(int(pid)) {
		return fmt.Sprintf("the data folder is in use by process %d", pid)
	}
	return ""
}

func (l *InstanceLock) release() {
	if l.held {
		os.Remove(l.path)
		l.held = false
	}
}
