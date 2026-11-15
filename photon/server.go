// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// The Photon host's loopback JSON API and the renderer's files.
//
// Guards, in the VEC1 Photon manner: the Host header must name this listener exactly (DNS rebinding), every /api
// call except /api/health carries the per-launch token in X-VEC1-Token, a state-changing call must be same-origin
// JSON, bodies have a length and a ceiling, and the page is served with a CSP that allows nothing but this origin.
//
//	GET  /                  the workbench (the token and this computer's loopback lease are written into it)
//	GET  /workbench.js .css the engine bundle and its styles
//	GET  /api/health        {ok, version}
//	GET  /api/edition       product, edition, versions, runtime, this computer's address and loopback lease
//	GET  /api/league        the registry text and its seal, and each game's number of ledger pairs
//	GET  /api/ledgers?sha=  every game's pairs, 128 bytes each, in the order /api/league lists them
//	GET  /api/verify        everything re-read from disk and checked
//	POST /api/commit        {registry?, base, ledgers:[{game, uuid, start, data}]}: recorded before the answer
//	POST /api/shutdown      stop the host

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	tokenHeader = "X-VEC1-Token"
	maxBody     = 32 * 1024 * 1024
	csp         = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

var staticFiles = map[string][2]string{"/workbench.js": {"workbench.js", "text/javascript; charset=utf-8"}, "/workbench.css": {"workbench.css", "text/css; charset=utf-8"}}

type httpError struct {
	status        int
	error, detail string
}

func (e *httpError) Error() string { return e.detail }

type PhotonHost struct {
	store          *LeagueStore
	token, uiDir   string
	info           Obj
	allowedHosts   map[string]bool
	allowedOrigins map[string]bool
	server         *http.Server
	listener       net.Listener
	stopOnce       sync.Once
}

func newPhotonHost(ln net.Listener, store *LeagueStore, token, uiDir string, info Obj) *PhotonHost {
	addr := ln.Addr().(*net.TCPAddr)
	host, port := addr.IP.String(), addr.Port
	h := &PhotonHost{store: store, token: token, uiDir: uiDir, info: info, listener: ln,
		allowedHosts: map[string]bool{fmt.Sprintf("%s:%d", host, port): true}, allowedOrigins: map[string]bool{}}
	if host == "127.0.0.1" {
		h.allowedHosts[fmt.Sprintf("localhost:%d", port)] = true
	}
	for a := range h.allowedHosts {
		h.allowedOrigins["http://"+a] = true
	}
	h.server = &http.Server{Handler: h, ReadHeaderTimeout: 60 * time.Second, ReadTimeout: 120 * time.Second, WriteTimeout: 120 * time.Second,
		IdleTimeout: 60 * time.Second, ErrorLog: nil}
	return h
}

func (h *PhotonHost) serve() error {
	err := h.server.Serve(h.listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (h *PhotonHost) shutdown() {
	h.stopOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.server.Shutdown(ctx)
	})
}

func (h *PhotonHost) address() (string, int) {
	a := h.listener.Addr().(*net.TCPAddr)
	return a.IP.String(), a.Port
}

func setHeaders(w http.ResponseWriter, status int, ctype string, length int) {
	hd := w.Header()
	hd.Set("Content-Type", ctype)
	if length >= 0 {
		hd.Set("Content-Length", fmt.Sprint(length))
	}
	hd.Set("Server", "RINK-VT-Photon/"+VERSION)
	hd.Set("Cache-Control", "no-store")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Referrer-Policy", "no-referrer")
	hd.Set("X-Frame-Options", "DENY")
	hd.Set("Cross-Origin-Opener-Policy", "same-origin")
	hd.Set("Cross-Origin-Resource-Policy", "same-origin")
	hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()")
	hd.Set("Content-Security-Policy", csp)
	w.WriteHeader(status)
}

func writeJSON(w http.ResponseWriter, r *http.Request, v any, status int) {
	data := []byte(pyDumps(v, false, false) + "\n")
	setHeaders(w, status, "application/json; charset=utf-8", len(data))
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}

func writeBytes(w http.ResponseWriter, r *http.Request, data []byte, ctype string) {
	setHeaders(w, http.StatusOK, ctype, len(data))
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}

func (h *PhotonHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if p := recover(); p != nil { // answer, record, keep serving
			name := fmt.Sprintf("%T", p)
			_ = h.store.events.add("internal_error", Obj{{"where", truncate(r.URL.Path, 80)}, {"error", name}})
			writeJSON(w, r, Obj{{"error", "internal error"}, {"detail", name}}, 500)
		}
	}()
	err := h.dispatch(w, r)
	if err == nil {
		return
	}
	var he *httpError
	var se *StoreError
	switch {
	case errors.As(err, &he):
		writeJSON(w, r, Obj{{"error", he.error}, {"detail", he.detail}}, he.status)
	case errors.As(err, &se):
		status := map[string]int{"CONFLICT": 409, "TOO_LARGE": 413, "DAMAGED": 500}[se.Code]
		if status == 0 {
			status = 400
		}
		writeJSON(w, r, Obj{{"error", strings.ToLower(se.Code)}, {"detail", se.Msg}}, status)
	default:
		writeJSON(w, r, Obj{{"error", "bad request"}, {"detail", truncate(err.Error(), 300)}}, 400)
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (h *PhotonHost) dispatch(w http.ResponseWriter, r *http.Request) error {
	if !h.allowedHosts[strings.ToLower(strings.TrimSpace(r.Host))] {
		return &httpError{421, "misdirected request", "the Host header does not name this loopback host"}
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		return h.get(w, r)
	case http.MethodPost:
		return h.post(w, r)
	}
	return &httpError{405, "method not allowed", ""}
}

func (h *PhotonHost) guardToken(r *http.Request) error {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get(tokenHeader)), []byte(h.token)) != 1 {
		return &httpError{403, "forbidden", "missing or invalid " + tokenHeader}
	}
	return nil
}

func (h *PhotonHost) guardMutation(r *http.Request) error {
	if origin, has := r.Header["Origin"]; has && !h.allowedOrigins[origin[0]] {
		return &httpError{403, "forbidden", "cross-origin request refused"}
	}
	if strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0])) != "application/json" {
		return &httpError{415, "unsupported media type", "Content-Type must be application/json"}
	}
	return h.guardToken(r)
}

func (h *PhotonHost) readJSON(r *http.Request) (Obj, error) {
	if len(r.TransferEncoding) > 0 {
		return nil, &httpError{411, "length required", "chunked bodies are not accepted"}
	}
	if r.ContentLength < 0 || r.ContentLength > maxBody {
		return nil, &httpError{413, "payload too large", fmt.Sprintf("at most %d bytes", maxBody)}
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || int64(len(raw)) != r.ContentLength {
		return nil, &httpError{400, "bad request", "the body ended early"}
	}
	if len(raw) == 0 {
		return Obj{}, nil
	}
	v, err := parseJSON(string(raw))
	if err != nil {
		return nil, &httpError{400, "bad request", truncate(err.Error(), 300)}
	}
	body, ok := v.(Obj)
	if !ok {
		return nil, &httpError{400, "bad request", "the body must be a JSON object"}
	}
	return body, nil
}

func (h *PhotonHost) page(w http.ResponseWriter, r *http.Request) error {
	page, err := os.ReadFile(filepath.Join(h.uiDir, "workbench.html"))
	if err != nil {
		return err
	}
	for _, kv := range [][2]string{{"__RINKVT_TOKEN__", h.token}, {"__RINKVT_LOCAL__", h.info.Str("local")}, {"__RINKVT_CLIENT__", h.info.Str("client")}} {
		page = bytes.ReplaceAll(page, []byte(kv[0]), []byte(kv[1]))
	}
	writeBytes(w, r, page, "text/html; charset=utf-8")
	return nil
}

func runtimeText() string {
	return fmt.Sprintf("Photon host · native %s/%s executable · no Python, no Node.js", runtime.GOOS, runtime.GOARCH)
}

func (h *PhotonHost) get(w http.ResponseWriter, r *http.Request) error {
	p := r.URL.Path
	if p == "/" || p == "/index.html" {
		return h.page(w, r)
	}
	if f, ok := staticFiles[p]; ok {
		data, err := os.ReadFile(filepath.Join(h.uiDir, f[0]))
		if err != nil {
			return err
		}
		writeBytes(w, r, data, f[1])
		return nil
	}
	if p == "/api/health" {
		writeJSON(w, r, Obj{{"ok", true}, {"version", VERSION}}, 200)
		return nil
	}
	if !strings.HasPrefix(p, "/api/") {
		return &httpError{404, "not found", ""}
	}
	if err := h.guardToken(r); err != nil {
		return err
	}
	switch p {
	case "/api/edition":
		recovered := []any{}
		for _, k := range h.store.recovered {
			recovered = append(recovered, k)
		}
		out := append(Obj{}, h.info...)
		out = out.Set("product", PRODUCT).Set("edition", EDITION).Set("version", VERSION).Set("engine", ENGINE).Set("runtime", runtimeText()).
			Set("events", h.store.events.count()).Set("recovered", recovered)
		writeJSON(w, r, out, 200)
	case "/api/league":
		idx, _, err := h.store.snapshot()
		if err != nil {
			return err
		}
		writeJSON(w, r, idx, 200)
	case "/api/ledgers":
		idx, blob, err := h.store.snapshot()
		if err != nil {
			return err
		}
		want := r.URL.Query().Get("sha")
		have, _ := idx.Get("registrySha")
		if (want == "" && have != nil) || (want != "" && want != have) {
			return &httpError{409, "conflict", "the league changed since /api/league; ask again"}
		}
		writeBytes(w, r, blob, "application/octet-stream")
	case "/api/verify":
		writeJSON(w, r, h.store.verify(), 200)
	default:
		return &httpError{404, "not found", ""}
	}
	return nil
}

func (h *PhotonHost) post(w http.ResponseWriter, r *http.Request) error {
	if err := h.guardMutation(r); err != nil {
		return err
	}
	body, err := h.readJSON(r)
	if err != nil {
		return err
	}
	switch r.URL.Path {
	case "/api/commit":
		var registry *string
		if v, has := body.Get("registry"); has && v != nil {
			s, ok := v.(string)
			if !ok {
				return &httpError{400, "bad request", "registry must be the registry.json text"}
			}
			registry = &s
		}
		batches := []Obj{}
		if v, has := body.Get("ledgers"); has {
			list, ok := v.([]any)
			if !ok {
				return &httpError{400, "bad request", "ledgers must be a list of batches"}
			}
			for _, x := range list {
				b, ok := x.(Obj)
				if !ok {
					return &httpError{400, "bad request", "ledgers must be a list of batches"}
				}
				batches = append(batches, b)
			}
		}
		base, _ := body.Get("base")
		res, err := h.store.commit(registry, base, batches)
		if err != nil {
			return err
		}
		writeJSON(w, r, res, 200)
	case "/api/shutdown":
		writeJSON(w, r, Obj{{"ok", true}, {"detail", "the Photon host is stopping"}}, 200)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go h.shutdown()
	default:
		return &httpError{404, "not found", ""}
	}
	return nil
}

var _ = json.Number("")
