package peeruid

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"strings"
	"testing"
)

func load(t *testing.T, name string) []Entry {
	t.Helper()
	if binary.NativeEndian.Uint16([]byte{1, 0}) != 1 {
		t.Skip("fixtures are little-endian")
	}
	f, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	e, err := Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func ap(s string) netip.AddrPort { return netip.MustParseAddrPort(s) }

func TestParseV4(t *testing.T) {
	e := load(t, "tcp")
	if len(e) != 7 {
		t.Fatalf("%d entries", len(e))
	}
	if e[0].Local != ap("127.0.0.1:81") || e[0].State != 0x0A || e[0].UID != 0 {
		t.Errorf("listener row = %+v", e[0])
	}
	if e[2].Local != ap("127.0.0.1:50000") || e[2].Remote != ap("127.0.0.1:81") || e[2].UID != 991 {
		t.Errorf("client row = %+v", e[2])
	}
	if e[6].Local != ap("198.51.100.10:54321") || e[6].Remote != ap("198.51.100.11:443") {
		t.Errorf("row 6 = %+v", e[6])
	}
}

func TestParseV6(t *testing.T) {
	e := load(t, "tcp6")
	if len(e) != 3 {
		t.Fatalf("%d entries", len(e))
	}
	if e[0].Local != ap("[::ffff:127.0.0.1]:50003") || e[0].Remote != ap("[::ffff:127.0.0.1]:83") || e[0].UID != 992 {
		t.Errorf("mapped row = %+v", e[0])
	}
	if e[1].Local != ap("[::1]:18032") {
		t.Errorf("::1 row = %+v", e[1])
	}
	if e[2].Local != ap("[2001:db8::10]:54322") || e[2].Remote != ap("[2001:db8::10]:443") {
		t.Errorf("row 2 = %+v", e[2])
	}
}

func TestFind(t *testing.T) {
	all := append(load(t, "tcp"), load(t, "tcp6")...)
	// The client end (local = peer, remote = listener), not the server's accepted socket (uid 0).
	if uid, err := Find(all, ap("127.0.0.1:50000"), ap("127.0.0.1:81")); err != nil || uid != 991 {
		t.Errorf("kete client: %d, %v", uid, err)
	}
	if uid, err := Find(all, ap("127.0.0.1:50002"), ap("127.0.0.1:82")); err != nil || uid != 992 {
		t.Errorf("tool client: %d, %v", uid, err)
	}
	// A dual-stack client socket (IPv4-mapped in tcp6).
	if uid, err := Find(all, ap("127.0.0.1:50003"), ap("127.0.0.1:83")); err != nil || uid != 992 {
		t.Errorf("mapped client: %d, %v", uid, err)
	}
	// TIME_WAIT rows (uid 0) never match; nothing established → not found.
	if _, err := Find(all, ap("127.0.0.1:50001"), ap("127.0.0.1:82")); !errors.Is(err, ErrNotFound) {
		t.Errorf("time-wait: %v", err)
	}
	if _, err := Find(all, ap("127.0.0.1:1"), ap("127.0.0.1:81")); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
	// Conflicting owners fail closed.
	dup := append(all, Entry{Local: ap("127.0.0.1:50000"), Remote: ap("127.0.0.1:81"), State: 1, UID: 5})
	if _, err := Find(dup, ap("127.0.0.1:50000"), ap("127.0.0.1:81")); err == nil {
		t.Error("conflicting owners accepted")
	}
}

func TestParseErrors(t *testing.T) {
	for _, in := range []string{
		"hdr local_address\n 0: zz:0051 00000000:0000 0A 0 0 0 0\n",
		"hdr local_address\n 0: 0100007F 00000000:0000 0A 0 0 0 0\n",
		"hdr local_address\n 0: 0100007F:0051 00000000:0000 0A 0 0 0 notuid\n",
		"hdr local_address\n 0: 0100007F:0051\n",
		"hdr local_address\n 0: 01007F:0051 00000000:0000 0A 0 0 0 0\n",
	} {
		if _, err := Parse(strings.NewReader(in)); err == nil {
			t.Errorf("%q parsed", in)
		}
	}
}
