// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The host's loopback API: its guards, and a commit, league, ledgers and verification round trip.

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testHost struct {
	h     *PhotonHost
	base  string
	token string
}

func startTestHost(t *testing.T) *testHost {
	t.Helper()
	s, err := openLeagueStore(t.TempDir())
	fatalIf(t, err != nil, "%v", err)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	fatalIf(t, err != nil, "%v", err)
	h := newPhotonHost(ln, s, "test-token-123", filepath.Join(repoRoot(t), "ui"), Obj{{"local", "127.26.220.77"}, {"client", "device 786ccb4a"}})
	go h.serve()
	t.Cleanup(h.shutdown)
	host, port := h.address()
	return &testHost{h: h, base: fmt.Sprintf("http://%s:%d", host, port), token: "test-token-123"}
}

func (th *testHost) request(t *testing.T, method, path string, headers map[string]string, body []byte) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest(method, th.base+path, bytes.NewReader(body))
	if body == nil {
		req.Body = nil
	}
	for k, v := range headers {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	fatalIf(t, err != nil, "%s %s: %v", method, path, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, b
}

func (th *testHost) json() map[string]string {
	return map[string]string{tokenHeader: th.token, "Content-Type": "application/json"}
}

func TestServerHealthAndPage(t *testing.T) {
	th := startTestHost(t)
	st, hd, body := th.request(t, "GET", "/api/health", nil, nil)
	fatalIf(t, st != 200 || !bytes.Contains(body, []byte(VERSION)), "health: %d", st)
	st, hd, body = th.request(t, "GET", "/", nil, nil)
	fatalIf(t, st != 200 || !bytes.Contains(body, []byte(th.token)) || !bytes.Contains(body, []byte("127.26.220.77")), "the page: %d", st)
	for _, h := range []string{"Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Cross-Origin-Opener-Policy", "Permissions-Policy"} {
		fatalIf(t, hd.Get(h) == "", "the page has no %s", h)
	}
	fatalIf(t, !strings.Contains(hd.Get("Content-Security-Policy"), "script-src 'self'"), "the CSP allows more than this origin")
}

func TestServerHostHeaderGuard(t *testing.T) {
	th := startTestHost(t)
	for _, host := range []string{"evil.example", "127.0.0.1", "127.0.0.1:1", "rebind.example:" + strings.Split(th.base, ":")[2]} {
		st, _, _ := th.request(t, "GET", "/api/health", map[string]string{"Host": host}, nil)
		fatalIf(t, st != 421, "Host %s answered %d", host, st)
	}
	port := strings.Split(th.base, ":")[2]
	st, _, _ := th.request(t, "GET", "/api/health", map[string]string{"Host": "localhost:" + port}, nil)
	fatalIf(t, st != 200, "localhost is this host on 127.0.0.1: %d", st)
}

func TestServerTokenGuard(t *testing.T) {
	th := startTestHost(t)
	for _, tok := range []string{"", "wrong", th.token + "x", strings.ToUpper(th.token)} {
		st, _, _ := th.request(t, "GET", "/api/league", map[string]string{tokenHeader: tok}, nil)
		fatalIf(t, st != 403, "token %q answered %d", tok, st)
	}
	st, _, _ := th.request(t, "GET", "/api/league", map[string]string{tokenHeader: th.token}, nil)
	fatalIf(t, st != 200, "the right token answered %d", st)
}

func TestServerMutationGuards(t *testing.T) {
	th := startTestHost(t)
	cases := []struct {
		headers map[string]string
		body    string
		want    int
	}{
		{map[string]string{tokenHeader: th.token, "Content-Type": "text/plain"}, "{}", 415},
		{map[string]string{tokenHeader: th.token, "Content-Type": "application/json", "Origin": "http://evil.example"}, "{}", 403},
		{map[string]string{"Content-Type": "application/json"}, "{}", 403},
		{th.json(), `{"a":1,"a":2}`, 400},
		{th.json(), `[1]`, 400},
		{th.json(), `{"x":NaN}`, 400},
		{th.json(), `{"registry":5}`, 400},
		{th.json(), `{"ledgers":{}}`, 400},
	}
	for _, c := range cases {
		st, _, _ := th.request(t, "POST", "/api/commit", c.headers, []byte(c.body))
		fatalIf(t, st != c.want, "%v %s answered %d, not %d", c.headers, c.body, st, c.want)
	}
	st, _, _ := th.request(t, "PUT", "/api/commit", th.json(), []byte("{}"))
	fatalIf(t, st != 405, "PUT answered %d", st)
	big := bytes.Repeat([]byte(" "), maxBody+1)
	st, _, _ = th.request(t, "POST", "/api/commit", th.json(), big)
	fatalIf(t, st != 413, "an oversized body answered %d", st)
}

func TestServerDeepNestingIsABadRequest(t *testing.T) {
	th := startTestHost(t)
	for _, raw := range []string{strings.Repeat("[", 100000) + strings.Repeat("]", 100000), strings.Repeat(`{"a":`, 70) + "1" + strings.Repeat("}", 70)} {
		st, _, _ := th.request(t, "POST", "/api/commit", th.json(), []byte(raw))
		fatalIf(t, st != 400, "deep nesting answered %d", st)
	}
}

func TestServerStaticFilesOnly(t *testing.T) {
	th := startTestHost(t)
	for _, p := range []string{"/workbench.js", "/workbench.css"} {
		st, _, _ := th.request(t, "GET", p, nil, nil)
		fatalIf(t, st != 200, "%s answered %d", p, st)
	}
	for _, p := range []string{"/../photon/host.go", "/ui/app.js", "/RELEASE_MANIFEST.json", "/%2e%2e/LICENSE", "/api/nothing"} {
		st, _, _ := th.request(t, "GET", p, map[string]string{tokenHeader: th.token}, nil)
		fatalIf(t, st != 403 && st != 404, "%s answered %d", p, st)
	}
}

func TestServerCommitLeagueLedgersVerify(t *testing.T) {
	th := startTestHost(t)
	u := newUUID()
	reg := testRegistry([][2]string{{"G1", u}})
	body := pyDumps(Obj{{"registry", reg}, {"base", nil}, {"ledgers", []any{batch("G1", u, 0, testPairs(u, 0, 4))}}}, false, false)
	st, _, out := th.request(t, "POST", "/api/commit", th.json(), []byte(body))
	fatalIf(t, st != 200, "commit: %d %s", st, out)
	st, _, again := th.request(t, "POST", "/api/commit", th.json(), []byte(body))
	fatalIf(t, st != 409, "a stale commit answered %d %s", st, again)
	st, _, league := th.request(t, "GET", "/api/league", map[string]string{tokenHeader: th.token}, nil)
	v, _ := parseJSON(string(league))
	sha := v.(Obj).Str("registrySha")
	fatalIf(t, st != 200 || sha != sha256Hex([]byte(reg)), "league: %d", st)
	st, hd, blob := th.request(t, "GET", "/api/ledgers?sha="+sha, map[string]string{tokenHeader: th.token}, nil)
	fatalIf(t, st != 200 || hd.Get("Content-Type") != "application/octet-stream" || !bytes.Equal(blob, testPairs(u, 0, 4)), "ledgers: %d", st)
	st, _, _ = th.request(t, "GET", "/api/ledgers?sha=stale", map[string]string{tokenHeader: th.token}, nil)
	fatalIf(t, st != 409, "a stale seal answered %d", st)
	st, _, rep := th.request(t, "GET", "/api/verify", map[string]string{tokenHeader: th.token}, nil)
	fatalIf(t, st != 200 || !bytes.Contains(rep, []byte(`"ok":true`)), "verify: %d %s", st, rep)
	st, _, ed := th.request(t, "GET", "/api/edition", map[string]string{tokenHeader: th.token}, nil)
	fatalIf(t, st != 200 || !bytes.Contains(ed, []byte("no Python, no Node.js")), "edition: %d %s", st, ed)
	_ = os.Getpid
}
