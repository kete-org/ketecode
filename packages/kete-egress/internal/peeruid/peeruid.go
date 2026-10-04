// Package peeruid finds the uid that owns the client end of an accepted loopback TCP connection,
// from the kernel's socket table (/proc/net/tcp and /proc/net/tcp6) — decision D5, defence in
// depth under the nftables rules: even with the rules missing, a user connecting to another
// user's proxy port is refused. TCP has no SO_PEERCRED, but on loopback both ends are in this
// network namespace's table, and the client's entry (local = the peer address, remote = the
// listener) carries its socket's owner.
package peeruid

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"
)

// stateEstablished is TCP_ESTABLISHED in the table's "st" column.
const stateEstablished = 0x01

// Entry is one socket-table row.
type Entry struct {
	Local  netip.AddrPort
	Remote netip.AddrPort
	State  uint8
	UID    uint32
}

// ErrNotFound means no established socket matched.
var ErrNotFound = errors.New("peer socket not found")

// Parse reads a /proc/net/tcp or /proc/net/tcp6 table.
func Parse(r io.Reader) ([]Entry, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	var out []Entry
	first := true
	for sc.Scan() {
		line := sc.Text()
		if first {
			first = false
			if strings.Contains(line, "local_address") {
				continue
			}
		}
		f := strings.Fields(line)
		if len(f) < 8 {
			return nil, fmt.Errorf("peeruid: short line %q", line)
		}
		local, err := parseAddrPort(f[1])
		if err != nil {
			return nil, err
		}
		remote, err := parseAddrPort(f[2])
		if err != nil {
			return nil, err
		}
		st, err := strconv.ParseUint(f[3], 16, 8)
		if err != nil {
			return nil, fmt.Errorf("peeruid: state %q: %w", f[3], err)
		}
		uid, err := strconv.ParseUint(f[7], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("peeruid: uid %q: %w", f[7], err)
		}
		out = append(out, Entry{Local: local, Remote: remote, State: uint8(st), UID: uint32(uid)})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// parseAddrPort decodes "0100007F:0051" (IPv4) or the 32-hex-digit IPv6 form. Each 32-bit word
// is printed in the kernel's native byte order; the port is a plain hex number.
func parseAddrPort(s string) (netip.AddrPort, error) {
	a, p, ok := strings.Cut(s, ":")
	if !ok {
		return netip.AddrPort{}, fmt.Errorf("peeruid: address %q", s)
	}
	port, err := strconv.ParseUint(p, 16, 16)
	if err != nil {
		return netip.AddrPort{}, fmt.Errorf("peeruid: port %q: %w", p, err)
	}
	raw, err := hex.DecodeString(a)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.AddrPort{}, fmt.Errorf("peeruid: address %q", a)
	}
	var b [16]byte
	for i := 0; i < len(raw); i += 4 {
		w := binary.BigEndian.Uint32(raw[i : i+4])
		binary.NativeEndian.PutUint32(b[i:i+4], w)
	}
	var addr netip.Addr
	if len(raw) == 4 {
		addr = netip.AddrFrom4([4]byte(b[:4]))
	} else {
		addr = netip.AddrFrom16(b)
	}
	return netip.AddrPortFrom(addr, uint16(port)), nil
}

// Find returns the owner of the established socket whose local end is client and whose remote
// end is listener. An IPv4 pair also matches its IPv4-mapped IPv6 form (a dual-stack client
// socket). More than one match with different owners is an error: fail closed.
func Find(entries []Entry, client, listener netip.AddrPort) (uint32, error) {
	want := func(e Entry) bool {
		return e.State == stateEstablished && sameAddrPort(e.Local, client) && sameAddrPort(e.Remote, listener)
	}
	found := false
	var uid uint32
	for _, e := range entries {
		if !want(e) {
			continue
		}
		if found && e.UID != uid {
			return 0, fmt.Errorf("peeruid: %s has sockets owned by uids %d and %d", client, uid, e.UID)
		}
		found, uid = true, e.UID
	}
	if !found {
		return 0, ErrNotFound
	}
	return uid, nil
}

func sameAddrPort(a, b netip.AddrPort) bool {
	return a.Port() == b.Port() && a.Addr().Unmap() == b.Addr().Unmap()
}
