// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RUSSELL PHILIP SMITHSON

package main

// Static loopback leases: every laptop gets one address of its own in 127.0.0.0/8 and keeps it.
//
// The rule and the algorithm are the reference edition's (gateway/loopback.js); the key differs:
//
//	pool          127.16.0.0/12 by default; never overlapping 127.0.0.0/16; addresses ending in .0 or .255 not used
//	first choice  SHA-256("RINK-VT loopback 1" NUL key) mod the pool size; a taken slot moves the newcomer on by one
//	key           in this edition, the laptop's device key (device.go): "device:" and 32 hex digits, the same on
//	              every network; the reference edition keys a client by its IP address in canonical form (RFC 5952;
//	              IPv4-mapped IPv6 is IPv4), which a table here can also hold and the tools can look up
//	pinned        a laptop asks every table for the address it already has (its pin); a table gives it unless another
//	              laptop holds it there, so one table never gives one address to two laptops
//	lease file    append-only; one sealed line per lease, synced to disk before the address is used. Format 1 holds IP
//	              keys only (the reference edition's); format 2 also holds device keys. A format 1 table that receives
//	              a device key is upgraded once: its header names format 2 and every line stays as it was.
//
// A fleet register is a lease table every laptop of a club or league shares (on a network share or a removable
// disk): each allocation happens under an exclusive lock and re-reads the file first, so no two laptops enrolled in
// one register can ever hold the same address.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	defaultPool  = "127.16.0.0/12"
	leaseFormat  = 2 // what this build writes
	lockWait     = 15 * time.Second
	lockStaleAge = 60 * time.Second
)

var (
	deviceRE      = regexp.MustCompile(`^device:[0-9a-f]{32}$`)
	leaseHeaderRE = regexp.MustCompile(`^# RINK-VT loopback leases · format (\d+) · pool (\S+) · ipv6 /(\d+)$`)
	bracketRE     = regexp.MustCompile(`^\[([^\]]+)\](?::\d{1,5})?$`)
	v4PortRE      = regexp.MustCompile(`^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$`)
	poolRE        = regexp.MustCompile(`^(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})$`)
	prefixSufRE   = regexp.MustCompile(`/\d+$`)
)

type LoopbackError struct{ Code, Msg string }

func (e *LoopbackError) Error() string { return e.Msg }

func loopErr(code, f string, a ...any) error { return &LoopbackError{code, fmt.Sprintf(f, a...)} }

// canonicalIP is the canonical text of an IP address as a socket or a person writes it.
func canonicalIP(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" || utf8.RuneCountInString(s) > 64 {
		return "", false
	}
	if m := bracketRE.FindStringSubmatch(s); m != nil {
		s = m[1]
	} else if m := v4PortRE.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	s = strings.SplitN(s, "%", 2)[0]
	a, err := netip.ParseAddr(s)
	if err != nil {
		return "", false
	}
	return a.Unmap().String(), true
}

// clientKey is the key a lease belongs to: a laptop's device key as it stands, or an IP address in canonical form.
func clientKey(raw string, ipv6Prefix int) (string, bool) {
	if t := strings.TrimSpace(raw); deviceRE.MatchString(t) {
		return t, true
	}
	c, ok := canonicalIP(raw)
	if !ok {
		return "", false
	}
	a := netip.MustParseAddr(c)
	if a.Is4() || ipv6Prefix >= 128 {
		return c, true
	}
	p, err := a.Prefix(ipv6Prefix)
	if err != nil {
		return "", false
	}
	return p.Addr().String() + "/" + strconv.Itoa(ipv6Prefix), true
}

type Pool struct {
	base, last uint32
	length     int
	text       string
	capacity   int
}

func ip4(n uint32) string { return fmt.Sprintf("%d.%d.%d.%d", n>>24, n>>16&255, n>>8&255, n&255) }

func parseIPv4(s string) (uint32, bool) {
	a, err := netip.ParseAddr(s)
	if err != nil || !a.Is4() {
		return 0, false
	}
	b := a.As4()
	return binary.BigEndian.Uint32(b[:]), true
}

func newPool(spec string) (*Pool, error) {
	m := poolRE.FindStringSubmatch(spec)
	if m == nil {
		short := spec
		if len(short) > 40 {
			short = short[:40]
		}
		return nil, loopErr("POOL", "the loopback pool %s is not of the form 127.A.B.C/N", short)
	}
	base, ok := parseIPv4(m[1])
	if !ok || base>>24 != 127 {
		return nil, loopErr("POOL", "the loopback pool %s is not inside 127.0.0.0/8", spec)
	}
	length, _ := strconv.Atoi(m[2])
	if length < 9 || length > 24 {
		return nil, loopErr("POOL", "the loopback pool %s: the prefix length must be 9 to 24", spec)
	}
	size := uint32(1) << (32 - length)
	if base%size != 0 {
		return nil, loopErr("POOL", "the loopback pool %s: %s is not the first address of a /%d", spec, m[1], length)
	}
	last := base + size - 1
	lo, hi := uint32(127)<<24, uint32(127)<<24|0xffff
	if base <= hi && last >= lo {
		return nil, loopErr("POOL", "the loopback pool %s overlaps 127.0.0.0/16, which this computer itself uses (127.0.0.1 ...)", spec)
	}
	return &Pool{base: base, last: last, length: length, text: fmt.Sprintf("%s/%d", ip4(base), length), capacity: int(size / 256 * 254)}, nil
}

func (p *Pool) addressAt(i int) string { return ip4(p.base + uint32(i/254)*256 + uint32(i%254) + 1) }

func (p *Pool) contains(a string) bool {
	n, ok := parseIPv4(a)
	return ok && n >= p.base && n <= p.last && n&255 != 0 && n&255 != 255
}

func slotOf(key string, capacity int) int {
	h := shaHex("RINK-VT loopback 1\x00" + key)
	v, _ := strconv.ParseUint(h[:16], 16, 64)
	return int(v % uint64(capacity))
}

// primaryAddress is this computer's primary IP address: the source address of its default route (no packet is
// sent), else 127.0.0.1.
func primaryAddress() string {
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err == nil {
		defer c.Close()
		if a, ok := c.LocalAddr().(*net.UDPAddr); ok && !a.IP.IsUnspecified() {
			return a.IP.String()
		}
	}
	return "127.0.0.1"
}

type leaseEntry struct{ addr, at string }

// LeaseTable is the lease table, kept in memory and, with a file, on disk. With a file, every allocation takes an
// exclusive lock beside it and re-reads the file first, so several computers can share one table.
type LeaseTable struct {
	pool       *Pool
	ipv6Prefix int
	max        int
	header     string
	file       string
	byKey      map[string]leaseEntry
	byAddr     map[string]string
	readUpto   int
	fileFormat int
	upgraded   bool
}

func newLeaseTable(file, pool string, ipv6Prefix, maxLeases int, createDirs bool) (*LeaseTable, error) {
	p, err := newPool(pool)
	if err != nil {
		return nil, err
	}
	if ipv6Prefix < 32 || ipv6Prefix > 128 {
		return nil, loopErr("CONFIG", "the IPv6 lease prefix must be 32 to 128")
	}
	if maxLeases < 1 {
		return nil, loopErr("CONFIG", "the most leases must be a positive whole number")
	}
	if maxLeases > p.capacity {
		return nil, loopErr("CONFIG", "the most leases (%d) is more than the pool %s holds (%d)", maxLeases, p.text, p.capacity)
	}
	t := &LeaseTable{pool: p, ipv6Prefix: ipv6Prefix, max: maxLeases, byKey: map[string]leaseEntry{}, byAddr: map[string]string{}, fileFormat: leaseFormat,
		header: fmt.Sprintf("# RINK-VT loopback leases · format %d · pool %s · ipv6 /%d", leaseFormat, p.text, ipv6Prefix)}
	if file == "" {
		return t, nil
	}
	if t.file, err = filepath.Abs(file); err != nil {
		return nil, err
	}
	dir := filepath.Dir(t.file)
	if createDirs {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	} else if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		// a fleet register on a share or a removable disk that is not there now: never made in its place
		return nil, loopErr("UNREACHABLE", "the folder of %s is not there (share or disk not connected)", t.file)
	}
	err = t.locked(func() error {
		if !exists(t.file) {
			if err := appendDurable(t.file, []byte(t.header+"\n")); err != nil {
				return err
			}
		}
		return t.refresh()
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

// refresh reads what was appended since the last read (by this process or by another computer).
func (t *LeaseTable) refresh() error {
	raw, err := os.ReadFile(t.file)
	if err != nil {
		return err
	}
	cut := bytes.LastIndexByte(raw, '\n') + 1
	if cut < len(raw) {
		// a line cut off by a crash was never handed out: drop it (under the lock, so no writer is mid-line)
		f, err := os.OpenFile(t.file, os.O_WRONLY, 0)
		if err != nil {
			return err
		}
		err = f.Truncate(int64(cut))
		if err == nil {
			err = f.Sync()
		}
		f.Close()
		if err != nil {
			return err
		}
		raw = raw[:cut]
	}
	lines := strings.Split(string(raw), "\n")
	lines = lines[:len(lines)-1]
	if len(lines) == 0 {
		return loopErr("DAMAGED", "%s: the file is empty; it should begin with a lease header", t.file)
	}
	h := leaseHeaderRE.FindStringSubmatch(lines[0])
	if h == nil {
		return loopErr("DAMAGED", "%s: line 1 is not a loopback lease header", t.file)
	}
	format, _ := strconv.Atoi(h[1])
	if format != 1 && format != 2 {
		return loopErr("DAMAGED", "%s is lease format %s; this build reads formats 1 and 2", t.file, h[1])
	}
	t.fileFormat = format
	if v6, _ := strconv.Atoi(h[3]); h[2] != t.pool.text || v6 != t.ipv6Prefix {
		return loopErr("POOL_CHANGED", "%s holds leases from pool %s with IPv6 keys /%s; this host is set to %s and /%d. Leases are static: use the pool the file was written with",
			t.file, h[2], h[3], t.pool.text, t.ipv6Prefix)
	}
	start := t.readUpto
	if start < 1 {
		start = 1
	}
	for i := start; i < len(lines); i++ {
		f := strings.Split(lines[i], " ")
		where := fmt.Sprintf("%s: line %d", t.file, i+1)
		if len(f) != 4 {
			return loopErr("DAMAGED", "%s does not have four fields", where)
		}
		addr, key, at, seal := f[0], f[1], f[2], f[3]
		if shaHex(addr + " " + key + " " + at)[:16] != seal {
			return loopErr("DAMAGED", "%s does not match its seal (edited or damaged)", where)
		}
		if !t.pool.contains(addr) {
			return loopErr("DAMAGED", "%s names %s, which is not in the pool", where, addr)
		}
		if k, ok := clientKey(prefixSufRE.ReplaceAllString(key, ""), t.ipv6Prefix); !ok || k != key {
			return loopErr("DAMAGED", "%s has a client key that is not canonical", where)
		}
		if t.fileFormat == 1 && deviceRE.MatchString(key) {
			return loopErr("DAMAGED", "%s holds a device key, which a format 1 table cannot", where)
		}
		if _, dup := t.byKey[key]; dup {
			return loopErr("DAMAGED", "%s leases %s a second time", where, key)
		}
		if _, dup := t.byAddr[addr]; dup {
			return loopErr("DAMAGED", "%s gives %s a second time", where, addr)
		}
		t.byKey[key] = leaseEntry{addr, at}
		t.byAddr[addr] = key
	}
	t.readUpto = len(lines)
	return nil
}

// locked runs fn holding the table's lock file: created exclusively, waited for up to 15 s, and taken over when its
// holder died mid-allocation (older than 60 s; allocations take milliseconds).
func (t *LeaseTable) locked(fn func() error) error {
	path := t.file + ".lock"
	end := time.Now().Add(lockWait)
	for {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			host, _ := os.Hostname()
			fmt.Fprintf(f, "%d %s %d\n", os.Getpid(), host, time.Now().Unix())
			f.Close()
			defer os.Remove(path)
			return fn()
		}
		if !os.IsExist(err) {
			return err
		}
		if st, err := os.Stat(path); err == nil && time.Since(st.ModTime()) > lockStaleAge {
			os.Remove(path)
			continue
		}
		if time.Now().After(end) {
			return loopErr("LOCKED", "the loopback lease file is locked by another process (%s); if it is a reference-edition gateway, give this edition a file of its own", path)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// lease gives the address for this key, made on first contact and kept for good. prefer is the address the key
// already holds elsewhere (a laptop's pin): it is given when it is free here; moved says it was not.
func (t *LeaseTable) lease(raw, prefer string) (addr, key string, fresh, moved bool, err error) {
	key, ok := clientKey(raw, t.ipv6Prefix)
	if !ok {
		return "", "", false, false, loopErr("ADDRESS", "neither a device key nor an IP address")
	}
	if prefer != "" && !t.pool.contains(prefer) {
		prefer = "" // a pin from another pool is no preference here
	}
	if e, ok := t.byKey[key]; ok {
		return e.addr, key, false, prefer != "" && e.addr != prefer, nil
	}
	if t.file == "" {
		addr, fresh, moved, err = t.allocate(key, prefer)
		return addr, key, fresh, moved, err
	}
	err = t.locked(func() error {
		if err := t.refresh(); err != nil {
			return err
		}
		if e, ok := t.byKey[key]; ok {
			addr, fresh, moved = e.addr, false, prefer != "" && e.addr != prefer
			return nil
		}
		var aerr error
		addr, fresh, moved, aerr = t.allocate(key, prefer)
		return aerr
	})
	return addr, key, fresh, moved, err
}

func (t *LeaseTable) allocate(key, prefer string) (string, bool, bool, error) {
	if len(t.byKey) >= t.max {
		return "", false, false, loopErr("FULL", "all %d loopback leases are taken", t.max)
	}
	addr := ""
	if _, taken := t.byAddr[prefer]; prefer != "" && !taken {
		addr = prefer
	}
	if addr == "" {
		start := slotOf(key, t.pool.capacity)
		for k := 0; k < t.pool.capacity; k++ {
			a := t.pool.addressAt((start + k) % t.pool.capacity)
			if _, taken := t.byAddr[a]; !taken {
				addr = a
				break
			}
		}
	}
	if addr == "" {
		return "", false, false, loopErr("FULL", "the pool %s has no free address", t.pool.text)
	}
	at := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	if t.file != "" {
		if t.fileFormat == 1 && deviceRE.MatchString(key) {
			if err := t.upgrade(); err != nil {
				return "", false, false, err
			}
		}
		body := addr + " " + key + " " + at
		if err := appendDurable(t.file, []byte(body+" "+shaHex(body)[:16]+"\n")); err != nil { // on disk before anyone is told the address
			return "", false, false, err
		}
		raw, err := os.ReadFile(t.file)
		if err != nil {
			return "", false, false, err
		}
		t.readUpto = bytes.Count(raw, []byte("\n"))
	}
	t.byKey[key] = leaseEntry{addr, at}
	t.byAddr[addr] = key
	return addr, true, prefer != "" && addr != prefer, nil
}

// upgrade rewrites a format 1 table's header as format 2 (under the lock), keeping every lease line byte for byte.
func (t *LeaseTable) upgrade() error {
	raw, err := os.ReadFile(t.file)
	if err != nil {
		return err
	}
	nl := bytes.IndexByte(raw, '\n')
	data := append([]byte(t.header), raw[nl:]...)
	tmp := fmt.Sprintf("%s.%d.tmp", t.file, os.Getpid())
	if err := writeDurable(tmp, data); err != nil {
		return err
	}
	if err := os.Rename(tmp, t.file); err != nil {
		return err
	}
	t.fileFormat, t.upgraded = leaseFormat, true
	return nil
}

func (t *LeaseTable) lookup(raw string) string {
	key, ok := clientKey(raw, t.ipv6Prefix)
	if !ok {
		key = raw
	}
	return t.byKey[key].addr
}

func (t *LeaseTable) stats() Obj {
	return Obj{{"pool", t.pool.text}, {"capacity", t.pool.capacity}, {"max", t.max}, {"leases", len(t.byKey)}, {"persistent", t.file != ""}, {"format", t.fileFormat}}
}

var _ = hex.EncodeToString
