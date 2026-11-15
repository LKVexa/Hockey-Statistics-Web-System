// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// A small Chrome DevTools Protocol client over a WebSocket (RFC 6455), standard library only: what the browser
// tests drive the workbench with, and what prints the handguide. It starts a Chromium-family browser headless on a
// profile of its own, opens pages, evaluates expressions, types keys and prints to PDF.

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---- WebSocket ----------------------------------------------------------------------------------------------

type wsConn struct {
	c   net.Conn
	br  *bufio.Reader
	wmu sync.Mutex
}

func wsDial(raw string) (*wsConn, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	c, err := net.DialTimeout("tcp", u.Host, 10*time.Second)
	if err != nil {
		return nil, err
	}
	k := make([]byte, 16)
	rand.Read(k)
	key := base64.StdEncoding.EncodeToString(k)
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", u.RequestURI(), u.Host, key)
	br := bufio.NewReaderSize(c, 1<<20)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		c.Close()
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		c.Close()
		return nil, fmt.Errorf("websocket handshake: %s", resp.Status)
	}
	return &wsConn{c: c, br: br}, nil
}

func (w *wsConn) writeFrame(op byte, payload []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	hdr := []byte{0x80 | op}
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n < 1<<16:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	mask := make([]byte, 4)
	rand.Read(mask)
	hdr = append(hdr, mask...)
	data := make([]byte, n)
	for i := range payload {
		data[i] = payload[i] ^ mask[i%4]
	}
	_, err := w.c.Write(append(hdr, data...))
	return err
}

func (w *wsConn) readMessage() ([]byte, error) {
	var msg []byte
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.br, h[:]); err != nil {
			return nil, err
		}
		fin, op, masked, n := h[0]&0x80 != 0, h[0]&0x0f, h[1]&0x80 != 0, uint64(h[1]&0x7f)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(w.br, b[:]); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(w.br, b[:]); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		var mask [4]byte
		if masked {
			if _, err := io.ReadFull(w.br, mask[:]); err != nil {
				return nil, err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(w.br, payload); err != nil {
			return nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch op {
		case 0x9: // ping
			w.writeFrame(0xA, payload)
			continue
		case 0xA: // pong
			continue
		case 0x8:
			return nil, io.EOF
		}
		msg = append(msg, payload...)
		if fin {
			return msg, nil
		}
	}
}

// ---- the protocol -------------------------------------------------------------------------------------------

type cdpReply struct {
	result Obj
	err    error
}

type CDP struct {
	ws      *wsConn
	mu      sync.Mutex
	nextID  int
	pending map[int]chan cdpReply
	onEvent func(session, method string, params Obj)
	closed  chan struct{}
}

func cdpConnect(wsURL string, onEvent func(session, method string, params Obj)) (*CDP, error) {
	ws, err := wsDial(wsURL)
	if err != nil {
		return nil, err
	}
	c := &CDP{ws: ws, pending: map[int]chan cdpReply{}, onEvent: onEvent, closed: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func (c *CDP) readLoop() {
	defer close(c.closed)
	for {
		raw, err := c.ws.readMessage()
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.pending {
				ch <- cdpReply{err: fmt.Errorf("the browser connection closed")}
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		v, err := parseJSON(string(raw))
		msg, ok := v.(Obj)
		if err != nil || !ok {
			continue
		}
		if idV, has := msg.Get("id"); has {
			id, _ := numberInt(idV)
			c.mu.Lock()
			ch := c.pending[int(id)]
			delete(c.pending, int(id))
			c.mu.Unlock()
			if ch == nil {
				continue
			}
			if e, bad := msg.Get("error"); bad {
				ch <- cdpReply{err: fmt.Errorf("devtools: %s", pyDumps(e, false, false))}
			} else {
				res, _ := msg.Get("result")
				r, _ := res.(Obj)
				ch <- cdpReply{result: r}
			}
			continue
		}
		if c.onEvent != nil {
			p, _ := msg.Get("params")
			po, _ := p.(Obj)
			c.onEvent(msg.Str("sessionId"), msg.Str("method"), po)
		}
	}
}

func (c *CDP) call(session, method string, params Obj, timeout time.Duration) (Obj, error) {
	if params == nil {
		params = Obj{}
	}
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan cdpReply, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	req := Obj{{"id", id}, {"method", method}, {"params", params}}
	if session != "" {
		req = append(req, KV{"sessionId", session})
	}
	if err := c.ws.writeFrame(0x1, []byte(pyDumps(req, false, false))); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.result, r.err
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("devtools: %s took longer than %s", method, timeout)
	}
}

// ---- a headless browser -------------------------------------------------------------------------------------

type HeadlessBrowser struct {
	cmd     *exec.Cmd
	dir     string
	cdp     *CDP
	Version string
	mu      sync.Mutex
	pages   map[string]*CDPPage
}

// findTestBrowser is a Chromium-family browser for headless use: RINKVT_TEST_BROWSER, an installed Edge, Chrome or
// Chromium, or a Playwright download; "" when there is none.
func findTestBrowser() string {
	if b := os.Getenv("RINKVT_TEST_BROWSER"); b != "" {
		return b
	}
	for _, c := range browserCandidates() {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	for _, pattern := range []string{"/opt/pw-browsers/chromium-*/chrome-linux*/chrome", filepath.Join(os.Getenv("HOME"), ".cache/ms-playwright/chromium-*/chrome-linux*/chrome")} {
		if m, _ := filepath.Glob(pattern); len(m) > 0 {
			return m[len(m)-1]
		}
	}
	return ""
}

func startHeadless(exe string) (*HeadlessBrowser, error) {
	dir, err := os.MkdirTemp("", "rinkvt-cdp-")
	if err != nil {
		return nil, err
	}
	args := []string{"--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run", "--no-default-browser-check",
		"--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--font-render-hinting=none", "about:blank"}
	if os.Geteuid() == 0 {
		args = append([]string{"--no-sandbox"}, args...) // a root account (a container) has no sandbox to give
	}
	b := &HeadlessBrowser{cmd: exec.Command(exe, args...), dir: dir, pages: map[string]*CDPPage{}}
	if err := b.cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	var port, path string
	for end := time.Now().Add(30 * time.Second); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
		if raw, err := os.ReadFile(filepath.Join(dir, "DevToolsActivePort")); err == nil {
			if lines := strings.Split(strings.TrimSpace(string(raw)), "\n"); len(lines) == 2 {
				port, path = lines[0], lines[1]
				break
			}
		}
	}
	if port == "" {
		b.Close()
		return nil, fmt.Errorf("the browser did not open its DevTools port")
	}
	b.cdp, err = cdpConnect("ws://127.0.0.1:"+port+path, b.event)
	if err != nil {
		b.Close()
		return nil, err
	}
	if v, err := b.cdp.call("", "Browser.getVersion", nil, 10*time.Second); err == nil {
		b.Version = v.Str("product")
	}
	return b, nil
}

func (b *HeadlessBrowser) event(session, method string, params Obj) {
	b.mu.Lock()
	p := b.pages[session]
	b.mu.Unlock()
	if p == nil {
		return
	}
	switch method {
	case "Runtime.exceptionThrown":
		d, _ := params.Get("exceptionDetails")
		do, _ := d.(Obj)
		text := do.Str("text")
		if ex, has := do.Get("exception"); has {
			if eo, ok := ex.(Obj); ok && eo.Str("description") != "" {
				text = eo.Str("description")
			}
		}
		p.addError("pageerror " + text)
	case "Runtime.consoleAPICalled":
		if params.Str("type") == "error" {
			var parts []string
			a, _ := params.Get("args")
			list, _ := a.([]any)
			for _, x := range list {
				if o, ok := x.(Obj); ok {
					if v, has := o.Get("value"); has {
						parts = append(parts, fmt.Sprint(v))
					} else {
						parts = append(parts, o.Str("description"))
					}
				}
			}
			p.addError("console " + strings.Join(parts, " "))
		}
	}
}

func (b *HeadlessBrowser) Close() {
	if b.cdp != nil {
		b.cdp.call("", "Browser.close", nil, 5*time.Second)
	}
	if b.cmd != nil && b.cmd.Process != nil {
		done := make(chan struct{})
		go func() { b.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			b.cmd.Process.Kill()
			<-done
		}
	}
	os.RemoveAll(b.dir)
}

type CDPPage struct {
	b               *HeadlessBrowser
	session, target string
	mu              sync.Mutex
	errors          []string
}

func (p *CDPPage) addError(e string) {
	p.mu.Lock()
	p.errors = append(p.errors, e)
	p.mu.Unlock()
}

// Errors are the page's uncaught exceptions and console errors so far.
func (p *CDPPage) Errors() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.errors...)
}

func (b *HeadlessBrowser) NewPage(width, height int) (*CDPPage, error) {
	t, err := b.cdp.call("", "Target.createTarget", Obj{{"url", "about:blank"}}, 20*time.Second)
	if err != nil {
		return nil, err
	}
	a, err := b.cdp.call("", "Target.attachToTarget", Obj{{"targetId", t.Str("targetId")}, {"flatten", true}}, 20*time.Second)
	if err != nil {
		return nil, err
	}
	p := &CDPPage{b: b, session: a.Str("sessionId"), target: t.Str("targetId")}
	b.mu.Lock()
	b.pages[p.session] = p
	b.mu.Unlock()
	for _, m := range []string{"Runtime.enable", "Page.enable"} {
		if _, err := p.call(m, nil); err != nil {
			return nil, err
		}
	}
	if width > 0 {
		p.call("Emulation.setDeviceMetricsOverride", Obj{{"width", width}, {"height", height}, {"deviceScaleFactor", 1}, {"mobile", false}})
	}
	return p, nil
}

func (p *CDPPage) call(method string, params Obj) (Obj, error) {
	return p.b.cdp.call(p.session, method, params, 120*time.Second)
}

// Eval evaluates an expression in the page and returns its value (promises are awaited).
func (p *CDPPage) Eval(expr string) (any, error) {
	r, err := p.call("Runtime.evaluate", Obj{{"expression", expr}, {"returnByValue", true}, {"awaitPromise", true}})
	if err != nil {
		return nil, err
	}
	if ex, bad := r.Get("exceptionDetails"); bad {
		return nil, fmt.Errorf("evaluation failed: %s", truncate(pyDumps(ex, false, false), 300))
	}
	res, _ := r.Get("result")
	ro, _ := res.(Obj)
	v, _ := ro.Get("value")
	return v, nil
}

// EvalString is Eval for an expression that gives text.
func (p *CDPPage) EvalString(expr string) string {
	v, err := p.Eval(expr)
	if err != nil {
		return ""
	}
	s, _ := v.(string)
	return s
}

func (p *CDPPage) Navigate(u string) error {
	if _, err := p.call("Page.navigate", Obj{{"url", u}}); err != nil {
		return err
	}
	return p.waitLoaded()
}

func (p *CDPPage) Reload() error {
	if _, err := p.call("Page.reload", nil); err != nil {
		return err
	}
	time.Sleep(200 * time.Millisecond)
	return p.waitLoaded()
}

func (p *CDPPage) waitLoaded() error {
	for end := time.Now().Add(60 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
		if p.EvalString("document.readyState") == "complete" {
			return nil
		}
	}
	return fmt.Errorf("the page did not finish loading")
}

var keyCodes = map[string]int{"Enter": 13, "Escape": 27, "Tab": 9, "ArrowUp": 38, "ArrowDown": 40}

// Press sends one key, down and up, to the focused element.
func (p *CDPPage) Press(key string) error {
	params := Obj{{"key", key}, {"code", key}, {"windowsVirtualKeyCode", keyCodes[key]}, {"nativeVirtualKeyCode", keyCodes[key]}}
	down := append(Obj{{"type", "keyDown"}}, params...)
	if key == "Enter" {
		down = append(down, KV{"text", "\r"})
	}
	if _, err := p.call("Input.dispatchKeyEvent", down); err != nil {
		return err
	}
	_, err := p.call("Input.dispatchKeyEvent", append(Obj{{"type", "keyUp"}}, params...))
	return err
}

// PrintPDF prints the page with Page.printToPDF and returns the document.
func (p *CDPPage) PrintPDF(params Obj) ([]byte, error) {
	r, err := p.call("Page.printToPDF", params)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(r.Str("data"))
}

func (p *CDPPage) Close() {
	p.b.cdp.call("", "Target.closeTarget", Obj{{"targetId", p.target}}, 10*time.Second)
}
