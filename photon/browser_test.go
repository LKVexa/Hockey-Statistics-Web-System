// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// End to end: the real host in its own process, the workbench in a Chromium-family browser driven over the DevTools
// protocol, the league on disk. The release is copied to a scratch folder and sealed there, so the host starts
// exactly as from a release. Skipped where no Edge, Chrome or Chromium is installed.

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

var (
	sharedBrowser     *HeadlessBrowser
	sharedBrowserErr  error
	sharedBrowserOnce sync.Once
)

func init() {
	afterTests = append(afterTests, func() {
		if sharedBrowser != nil {
			sharedBrowser.Close()
		}
	})
}

func browserFor(t *testing.T) *HeadlessBrowser {
	t.Helper()
	if os.Getenv("RINKVT_SKIP_BROWSER") == "1" {
		t.Skip("browser tests left out (RINKVT_SKIP_BROWSER=1)")
	}
	sharedBrowserOnce.Do(func() {
		exe := findTestBrowser()
		if exe == "" {
			sharedBrowserErr = fmt.Errorf("no Chromium-family browser is installed")
			return
		}
		sharedBrowser, sharedBrowserErr = startHeadless(exe)
		if sharedBrowserErr == nil {
			fmt.Printf("RINKVT-BROWSER %s (DevTools protocol)\n", strings.Replace(strings.Replace(sharedBrowser.Version, "HeadlessChrome/", "Chrome/", 1), "/", " ", 1))
		}
	})
	if sharedBrowserErr != nil {
		t.Skip(sharedBrowserErr.Error())
	}
	return sharedBrowser
}

type e2eHost struct {
	cmd           *exec.Cmd
	url           string
	release, data string
	lines         []string
}

func startE2EHost(t *testing.T, release, data string) *e2eHost {
	t.Helper()
	exe, _ := os.Executable()
	h := &e2eHost{release: release, data: data}
	h.cmd = exec.Command(exe)
	h.cmd.Env = append(os.Environ(), "RINKVT_ROOT="+release,
		"RINKVT_TEST_HOST="+strings.Join([]string{"--data", data, "--no-browser", "--device-file", data + ".device.json"}, "\x1f"))
	out, err := h.cmd.StdoutPipe()
	fatalIf(t, err != nil, "%v", err)
	h.cmd.Stderr = h.cmd.Stdout
	fatalIf(t, h.cmd.Start() != nil, "the host did not start")
	found := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		re := regexp.MustCompile(`workbench\s+(http://\S+/)`)
		sent := false
		for sc.Scan() {
			h.lines = append(h.lines, sc.Text())
			if m := re.FindStringSubmatch(sc.Text()); m != nil && !sent {
				found <- m[1]
				sent = true
			}
		}
		if !sent {
			found <- ""
		}
	}()
	select {
	case u := <-found:
		fatalIf(t, u == "", "the host did not start: %s", strings.Join(h.lines, "\n"))
		h.url = u
	case <-time.After(60 * time.Second):
		t.Fatalf("the host did not start in time: %s", strings.Join(h.lines, "\n"))
	}
	return h
}

func (h *e2eHost) stop() {
	if h.cmd.ProcessState != nil {
		return
	}
	if runtime.GOOS == "windows" {
		h.cmd.Process.Kill() // the next start finds the stale lock and takes it
	} else {
		h.cmd.Process.Signal(syscall.SIGTERM)
	}
	done := make(chan struct{})
	go func() { h.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		h.cmd.Process.Kill()
		<-done
	}
}

type workbench struct {
	t *testing.T
	p *CDPPage
}

func waitFor(t *testing.T, timeout time.Duration, what string, fn func() bool) {
	t.Helper()
	for end := time.Now().Add(timeout); time.Now().Before(end); time.Sleep(100 * time.Millisecond) {
		if fn() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func openWorkbench(t *testing.T, b *HeadlessBrowser, url string) *workbench {
	t.Helper()
	p, err := b.NewPage(1400, 900)
	fatalIf(t, err != nil, "%v", err)
	t.Cleanup(p.Close)
	fatalIf(t, p.Navigate(url) != nil, "the workbench did not load")
	w := &workbench{t, p}
	waitFor(t, 60*time.Second, "the league to load", func() bool { return regexp.MustCompile(`league loaded|could not`).MatchString(w.text("#h-state")) })
	fatalIf(t, !strings.Contains(w.text("#h-state"), "league loaded"), "the league did not load: %s", w.text("#h-state"))
	return w
}

func jsString(s string) string { return pyString(s, true) }

func (w *workbench) text(sel string) string {
	return w.p.EvalString(fmt.Sprintf(`(document.querySelector(%s) || {}).innerText || ""`, jsString(sel)))
}

func (w *workbench) fill(line string) {
	w.p.Eval(fmt.Sprintf(`(() => { const c = document.querySelector('#cmd'); c.focus(); c.value = %s; c.dispatchEvent(new Event('input', {bubbles: true})); return true })()`, jsString(line)))
}

func (w *workbench) press(key string) {
	w.p.Eval(`document.querySelector('#cmd').focus()`)
	w.p.Press(key)
}

// runLine types a line, runs it, and waits for want in what it answered (after the echo of the line itself).
func (w *workbench) runLine(line, want string, timeout ...time.Duration) string {
	w.t.Helper()
	limit := 60 * time.Second
	if len(timeout) > 0 {
		limit = timeout[0]
	}
	before := len(w.text("#out"))
	w.fill(line)
	w.press("Enter")
	var got string
	waitFor(w.t, limit, fmt.Sprintf("%q to answer %q", line, want), func() bool {
		all := w.text("#out")
		if len(all) < before {
			return false
		}
		got = all[before:]
		nl := strings.IndexByte(got, '\n')
		return nl >= 0 && strings.Contains(got[nl+1:], want)
	})
	return got
}

func (w *workbench) noErrors() {
	w.t.Helper()
	var errs []string
	for _, e := range w.p.Errors() {
		if !strings.Contains(e, "409") {
			errs = append(errs, e)
		}
	}
	fatalIf(w.t, len(errs) > 0, "page errors: %v", errs)
}

func e2eSetup(t *testing.T) (*HeadlessBrowser, *e2eHost) {
	b := browserFor(t)
	rel := sealedRelease(t)
	h := startE2EHost(t, rel, filepath.Join(t.TempDir(), "data"))
	t.Cleanup(h.stop)
	return b, h
}

// A game created and scored, each line recorded; the league intact across a reload and across a restart of the
// host with the same lease; store verify OK.
func TestBrowserScoreReloadRestartVerify(t *testing.T) {
	b, h := e2eSetup(t)
	w := openWorkbench(t, b, h.url)
	local := w.p.EvalString(`document.querySelector('meta[name="rinkvt-local"]').content`)
	fatalIf(t, !regexp.MustCompile(`^127\.(1[6-9]|2\d|3[01])\.\d+\.\d+$`).MatchString(local), "the loopback lease: %s", local)
	fatalIf(t, !regexp.MustCompile(`^device [0-9a-f]{8}$`).MatchString(w.text("#h-client")), "the laptop: %s", w.text("#h-client"))
	fatalIf(t, !strings.Contains(w.text("#h-league"), "4 teams"), "the seeded league: %s", w.text("#h-league"))
	w.runLine("rink new FOCO KELW 2026-11-15", "created G1")
	w.runLine("rink G1", "durable (Photon host")
	for _, line := range []string{"T 20:00 P1", "START"} {
		w.runLine(line, "APPLIED")
	}
	time.Sleep(1100 * time.Millisecond)
	w.runLine("FOCO SMIT S/2W", "COMMITTED")
	waitFor(t, 30*time.Second, "the line to be recorded", func() bool { return strings.Contains(w.text("#h-state"), "recorded") })
	audit := w.runLine("Q AUDIT", "audit entries")
	fatalIf(t, !strings.Contains(audit, local), "the audit trail does not name this laptop's lease")
	fatalIf(t, w.p.Reload() != nil, "reload")
	waitFor(t, 60*time.Second, "the reload", func() bool { return strings.Contains(w.text("#h-state"), "league loaded") })
	fatalIf(t, !regexp.MustCompile(`FOCO\s+SMIT\s+S/2W`).MatchString(w.runLine("Q EVENTS", "events")), "the event did not survive a reload")
	w.noErrors()

	h.stop() // a new process, the same league and lease
	h2 := startE2EHost(t, h.release, h.data)
	t.Cleanup(h2.stop)
	w2 := openWorkbench(t, b, h2.url)
	fatalIf(t, w2.p.EvalString(`document.querySelector('meta[name="rinkvt-local"]').content`) != local, "the lease changed across a restart")
	fatalIf(t, !strings.Contains(w2.text("#h-league"), "1 game"), "the league after a restart: %s", w2.text("#h-league"))
	out := w2.runLine("store verify", "event ledger")
	fatalIf(t, !regexp.MustCompile(`OK\s+registry sealed`).MatchString(out) || !regexp.MustCompile(`G1\s+3 entries · chain intact`).MatchString(out), "store verify: %s", out)
	fatalIf(t, !strings.Contains(w2.runLine("store", "runtime"), "no Python, no Node.js"), "the store command does not name the native host")
	w2.noErrors()
}

func TestBrowserStartFrame(t *testing.T) {
	b, h := e2eSetup(t)
	w := openWorkbench(t, b, h.url)
	w.runLine("rink new FOCO KELW 2026-11-15", "START at the opening faceoff")
	w.runLine("rink G1", "EXIT")
	time.Sleep(1500 * time.Millisecond)
	score := w.text("#score")
	fatalIf(t, !strings.Contains(score, "20:00") || !strings.Contains(score, "not started"), "a new game's clock: %s", score)
	w.runLine("T 20:00 P1", "APPLIED")
	fatalIf(t, !strings.Contains(w.runLine("GO", "has not started"), "REJECTED"), "GO before START was not refused")
	fatalIf(t, !strings.Contains(w.runLine("START", "APPLIED"), "game started"), "START")
	time.Sleep(1600 * time.Millisecond)
	score = w.text("#score")
	fatalIf(t, strings.Contains(score, "not started") || !regexp.MustCompile(`P1 19:5\d`).MatchString(score), "the clock after START: %s", score)
	fatalIf(t, !strings.Contains(w.runLine("START", "REJECTED"), "the game started at P1 20:00"), "a second START")
	w.runLine("STOP", "APPLIED")
	w.runLine("GO", "APPLIED")
	fatalIf(t, !strings.Contains(w.runLine("Q AUDIT", "audit entries"), "CLOCK START"), "the start frame is not in the ledger")
	w.noErrors()
}

func TestBrowserWhistle(t *testing.T) {
	b, h := e2eSetup(t)
	w := openWorkbench(t, b, h.url)
	w.runLine("rink new FOCO KELW 2026-11-15", "created G1")
	w.runLine("rink G1", "EXIT")
	w.runLine("T 20:00 P1", "APPLIED")
	fatalIf(t, !strings.Contains(w.runLine("WHISTLE", "REJECTED"), "the game has not started"), "a whistle before START")
	w.runLine("START", "game started")
	time.Sleep(1200 * time.Millisecond)
	before := len(w.text("#out")) // Esc is the whistle: it stops the running clock and leaves the half-typed line alone
	w.fill("FOCO SM")
	w.press("Escape")
	waitFor(t, 30*time.Second, "Esc to blow the whistle", func() bool { return strings.Contains(w.text("#out")[before:], "whistle 1 of P1") })
	fatalIf(t, w.p.EvalString(`document.querySelector('#cmd').value`) != "FOCO SM", "Esc changed the half-typed line")
	waitFor(t, 10*time.Second, "the score bar to show the whistle", func() bool { return strings.Contains(w.text("#score"), "⏸ whistle") })
	fatalIf(t, !strings.Contains(w.runLine("WHISTLE", "REJECTED"), "already stopped"), "a second whistle on a stopped clock")
	out := w.runLine("WHISTLE 19:59", "APPLIED")
	fatalIf(t, !strings.Contains(out, "P1 19:59") || !strings.Contains(out, "whistle 1 of P1 (time set)"), "WHISTLE mm:ss: %s", out)
	w.runLine("GO", "APPLIED")
	time.Sleep(1100 * time.Millisecond)
	before = len(w.text("#out"))
	w.p.Eval(`[...document.querySelectorAll('#chips button')].find((b) => b.textContent === 'WHISTLE').click()`)
	waitFor(t, 30*time.Second, "the WHISTLE chip", func() bool { return strings.Contains(w.text("#out")[before:], "whistle 2 of P1") })
	before = len(w.text("#out"))
	w.press("Escape") // a stopped clock: Esc changes nothing
	waitFor(t, 10*time.Second, "the stopped-clock hint", func() bool { return strings.Contains(w.text("#hint"), "the clock is stopped") })
	fatalIf(t, strings.Contains(w.text("#out")[before:], "WHISTLE"), "Esc on a stopped clock ran a command")
	audit := w.runLine("Q AUDIT", "audit entries")
	fatalIf(t, !regexp.MustCompile(`CLOCK WHISTLE(?: 1|…)\S*\s+APPLIED`).MatchString(audit), "the timed whistle is not in the ledger: %s", audit)
	waitFor(t, 30*time.Second, "the whistles to be recorded", func() bool { return strings.Contains(w.text("#h-state"), "recorded") })
	fatalIf(t, w.p.Reload() != nil, "reload")
	waitFor(t, 60*time.Second, "the reload", func() bool { return strings.Contains(w.text("#h-state"), "league loaded") })
	w.runLine("rink G1", "EXIT")
	waitFor(t, 10*time.Second, "the replayed whistle", func() bool { return strings.Contains(w.text("#score"), "⏸ whistle") })
	w.noErrors()
}

func TestBrowserLeagueOvertimeRules(t *testing.T) {
	b, h := e2eSetup(t)
	w := openWorkbench(t, b, h.url)
	w.runLine(`rink addleague TSTL "Test League"`, "league TSTL")
	codes := map[string]string{}
	for _, tm := range [][3]string{{"ALFA", "Alpha", "Abbott"}, {"BETA", "Beta", "Baker"}} {
		w.runLine(fmt.Sprintf(`rink addteam %s "%s" --league=TSTL`, tm[0], tm[1]), "team "+tm[0])
		out := w.runLine(fmt.Sprintf("rink addplayer %s Sam %s 9 C 2000-01-01", tm[0], tm[2]), "player "+tm[0])
		codes[tm[0]] = regexp.MustCompile(`player ` + tm[0] + ` (\w{4})`).FindStringSubmatch(out)[1]
	}
	fatalIf(t, !strings.Contains(w.runLine("rink overtime TSTL", "overtime TSTL"), "built-in"), "a league without rules")
	out := w.runLine("rink overtime TSTL ties", "overtime set TSTL")
	fatalIf(t, !strings.Contains(out, "regular season: no overtime, and a tie stands") || !strings.Contains(out, "(preset ties)"), "ties: %s", out)
	fatalIf(t, !strings.Contains(w.runLine("rink new ALFA BETA 2026-11-20", "created G1"), "overtime: no OT, tie stands (TSTL rules)"), "the game's rules")
	w.runLine("rink G1", "EXIT")
	w.runLine("ALFA "+codes["ALFA"]+" S", "COMMITTED")
	fatalIf(t, !strings.Contains(w.runLine("T 5:00 OT", "REJECTED"), "this game ends after P3, and a tie stands"), "OT in a ties league")
	w.runLine("T 0:00 P3", "APPLIED")
	fatalIf(t, !strings.Contains(w.runLine("NEXT", "FINAL"), "tie TIE"), "a tie that stands")
	st := w.runLine("Q STANDINGS", "1 per tie")
	fatalIf(t, !regexp.MustCompile(`\bT\b`).MatchString(st) || !regexp.MustCompile(`ALFA\s+1\s+0\s+0\s+0\s+1\s+1\b`).MatchString(st), "the standings: %s", st)
	w.runLine("EXIT", "left RINK mode")
	fatalIf(t, !strings.Contains(w.runLine("rink overtime TSTL international", "overtime set TSTL"), "1 existing game keeps the rules it was created under"), "a rules change")
	fatalIf(t, !strings.Contains(w.runLine("rink new ALFA BETA 2026-11-21 PLAYOFF", "created G2"), "overtime: 10:00 3-on-3 OT, shootout 5 (TSTL rules)"), "the playoff game's rules")
	w.runLine("rink G2", "EXIT")
	w.runLine("T 0:00 P3", "APPLIED")
	fatalIf(t, !strings.Contains(w.runLine("NEXT", "APPLIED"), "OT 10:00"), "a 10-minute overtime")
	fatalIf(t, !strings.Contains(w.text("#score"), "3v3"), "overtime 3 on 3: %s", w.text("#score"))
	fatalIf(t, !strings.Contains(w.runLine("NEXT", "APPLIED"), "SO 0:00"), "the shootout")
	a, bb := "ALFA "+codes["ALFA"], "BETA "+codes["BETA"]
	for k := 0; k < 5; k++ {
		stat := "S"
		if k == 0 {
			stat = "G"
		}
		w.runLine(fmt.Sprintf("%s %s/W/80,0", a, stat), "COMMITTED")
		w.runLine(bb+" S/W/80,0", "COMMITTED")
		if k < 4 {
			fatalIf(t, !strings.Contains(strings.ToLower(w.text("#gametag")), "live"), "round %d of 5 decided a 1-0 shootout", k+1)
		}
	}
	waitFor(t, 10*time.Second, "the fifth round to decide the shootout", func() bool { return strings.Contains(strings.ToLower(w.text("#gametag")), "final") })
	fatalIf(t, !strings.Contains(w.runLine("GAME G2", "FINAL"), "FINAL/SO"), "the shootout result")
	fatalIf(t, !strings.Contains(w.runLine("GAME G1", "FINAL"), "FINAL/TIE"), "G1 is still the tie it was")
	w.runLine("EXIT", "left RINK mode")
	fatalIf(t, !regexp.MustCompile(`TSTL\s+regular season: 5:00 3-on-3 overtime, then a shootout of 5 rounds`).MatchString(w.runLine("rink overtime", "presets")), "the rules listing")
	waitFor(t, 30*time.Second, "the league to be recorded", func() bool { return strings.Contains(w.text("#h-state"), "recorded") })
	fatalIf(t, w.p.Reload() != nil, "reload")
	waitFor(t, 60*time.Second, "the reload", func() bool { return strings.Contains(w.text("#h-state"), "league loaded") })
	fatalIf(t, !strings.Contains(w.runLine("rink overtime TSTL", "overtime TSTL"), "(preset international)"), "the rules after a reload")
	w.noErrors()
}

func TestBrowserSimulationAndTwoWindows(t *testing.T) {
	b, h := e2eSetup(t)
	a := openWorkbench(t, b, h.url)
	out := a.runLine("rink sim 2", "synthetic games typed", 180*time.Second)
	fatalIf(t, !strings.Contains(out, "G2 ") || strings.Contains(out, "rejected"), "the simulation: %s", out)
	waitFor(t, 60*time.Second, "the simulation to be recorded", func() bool { return strings.Contains(a.text("#h-state"), "recorded") })
	w2 := openWorkbench(t, b, h.url)
	fatalIf(t, !strings.Contains(w2.text("#h-league"), "2 games"), "the second window's league: %s", w2.text("#h-league"))
	a.runLine("rink new KELW FOCO 2026-11-16", "created G3")
	fatalIf(t, !strings.Contains(w2.runLine("rink new FOCO KELW 2026-11-17", "NOT RECORDED"), "409"), "the later window was not refused")
	waitFor(t, 30*time.Second, "the second window to load the league again", func() bool { return strings.Contains(w2.text("#h-league"), "3 games") })
	fatalIf(t, !strings.Contains(w2.runLine("rink games", "G3"), "G3"), "the refused window does not carry on with the league")
	fatalIf(t, !strings.Contains(w2.runLine("store verify", "event ledger"), "OK"), "store verify after the race")
	a.noErrors()
	w2.noErrors()
}
