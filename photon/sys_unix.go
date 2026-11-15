// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

//go:build !windows

package main

import (
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"
)

var (
	ioregUUIDRE = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([^"]+)"`)
	machineIDRE = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
)

// machineIdentifier is IOPlatformUUID on macOS, /etc/machine-id (or the D-Bus copy) elsewhere, or "".
func machineIdentifier() string {
	if runtime.GOOS == "darwin" {
		cmd := exec.Command("/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice")
		done := make(chan []byte, 1)
		go func() { out, _ := cmd.Output(); done <- out }()
		select {
		case out := <-done:
			if m := ioregUUIDRE.FindSubmatch(out); m != nil {
				return string(m[1])
			}
		case <-time.After(10 * time.Second):
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}
		return ""
	}
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			if v := strings.TrimSpace(string(b)); machineIDRE.MatchString(v) {
				return v
			}
		}
	}
	return ""
}

// processAlive asks whether the process still runs, with signal 0 (which delivers nothing).
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
