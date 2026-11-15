// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

//go:build windows

package main

import (
	"strings"
	"syscall"
	"unsafe"
)

// machineIdentifier reads HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid (the 64-bit view), or "".
func machineIdentifier() string {
	var k syscall.Handle
	path, _ := syscall.UTF16PtrFromString(`SOFTWARE\Microsoft\Cryptography`)
	const keyWow6464Key = 0x0100
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, path, 0, syscall.KEY_READ|keyWow6464Key, &k) != nil {
		return ""
	}
	defer syscall.RegCloseKey(k)
	name, _ := syscall.UTF16PtrFromString("MachineGuid")
	var typ, n uint32
	if syscall.RegQueryValueEx(k, name, nil, &typ, nil, &n) != nil || n == 0 || n > 1024 {
		return ""
	}
	buf := make([]uint16, n/2+1)
	if syscall.RegQueryValueEx(k, name, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil {
		return ""
	}
	return strings.TrimSpace(syscall.UTF16ToString(buf))
}

// processAlive asks Windows whether the process still runs (without touching it).
func processAlive(pid int) bool {
	const processQueryLimitedInformation = 0x1000
	const stillActive = 259
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return err == syscall.ERROR_ACCESS_DENIED // it exists, and belongs to someone else
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil {
		return true
	}
	return code == stillActive
}
