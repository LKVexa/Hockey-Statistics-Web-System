// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain lets the browser tests run the host in its own process: the test binary, started again with
// RINKVT_TEST_HOST set, is the host (rinkvt-photon) and nothing else.
func TestMain(m *testing.M) {
	if args := os.Getenv("RINKVT_TEST_HOST"); args != "" {
		os.Exit(run(strings.Split(args, "\x1f")))
	}
	code := m.Run()
	for _, f := range afterTests {
		f()
	}
	os.Exit(code)
}

// afterTests run once every test has: the shared headless browser closes there.
var afterTests []func()

func repoRoot(t testing.TB) string {
	t.Helper()
	wd, _ := os.Getwd()
	return filepath.Dir(wd) // go test runs in photon/
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func batch(key, uuid string, start int, data []byte) Obj {
	return Obj{{"game", key}, {"uuid", uuid}, {"start", start}, {"data", b64(data)}}
}

func storeCode(err error) string {
	var se *StoreError
	if errors.As(err, &se) {
		return se.Code
	}
	if err == nil {
		return ""
	}
	return "other: " + err.Error()
}

func loopCode(err error) string {
	var le *LoopbackError
	if errors.As(err, &le) {
		return le.Code
	}
	if err == nil {
		return ""
	}
	return "other: " + err.Error()
}

// engineFixture is a game the reference engine recorded: its key, uuid and eight frame and meta pairs.
func engineFixture(t *testing.T) (string, string, []byte) {
	raw, err := os.ReadFile(filepath.Join("testdata", "engine_pairs.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, err := parseJSON(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	doc := v.(Obj)
	var pairs []byte
	list, _ := doc.Get("pairs")
	for _, p := range list.([]any) {
		b, _ := hex.DecodeString(p.(string))
		pairs = append(pairs, b...)
	}
	return doc.Str("game"), doc.Str("uuid"), pairs
}

func copyTree(t testing.TB, src, dst string, skip func(rel string) bool) {
	t.Helper()
	err := filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if skip != nil && rel != "." && skip(filepath.ToSlash(rel)) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// sealedRelease copies what the host runs and serves (photon/ without its executables, ui/, engine/) to a scratch
// folder and seals it there, so the host can start from it exactly as from a release.
func sealedRelease(t testing.TB) string {
	t.Helper()
	root := repoRoot(t)
	rel := filepath.Join(t.TempDir(), "release")
	for _, d := range []string{"photon", "ui", "engine"} {
		copyTree(t, filepath.Join(root, d), filepath.Join(rel, d), func(r string) bool { return d == "photon" && (r == "bin" || r == "testdata") })
	}
	if _, err := writeManifest(rel); err != nil {
		t.Fatal(err)
	}
	return rel
}

func mustCommit(t *testing.T, s *LeagueStore, registry *string, batches ...Obj) Obj {
	t.Helper()
	var base any
	if s.hasRegistry {
		base = s.registrySha
	}
	r, err := s.commit(registry, base, batches)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func str(s string) *string { return &s }

func fatalIf(t *testing.T, cond bool, f string, a ...any) {
	t.Helper()
	if cond {
		t.Fatalf(f, a...)
	}
}

var _ = fmt.Sprint
