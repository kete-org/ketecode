//go:build linux

package dhcp

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// attrs returns a message's attributes after its fixed body of n bytes.
func attrs(t *testing.T, msg []byte, n int) map[uint16][]byte {
	t.Helper()
	if int(binary.NativeEndian.Uint32(msg[0:4])) != len(msg) {
		t.Fatalf("length field %d, message %d", binary.NativeEndian.Uint32(msg[0:4]), len(msg))
	}
	out := map[uint16][]byte{}
	b := msg[unix.SizeofNlMsghdr+nlAlign(n):]
	for len(b) >= unix.SizeofRtAttr {
		l := int(binary.NativeEndian.Uint16(b[0:2]))
		out[binary.NativeEndian.Uint16(b[2:4])] = b[unix.SizeofRtAttr:l]
		b = b[nlAlign(l):]
	}
	return out
}

func TestAddrMessage(t *testing.T) {
	m := AddrMessage(3, 2, netip.MustParsePrefix("10.0.1.20/24"))
	body := m[unix.SizeofNlMsghdr:]
	if binary.NativeEndian.Uint16(m[4:6]) != unix.RTM_NEWADDR || body[0] != unix.AF_INET || body[1] != 24 || binary.NativeEndian.Uint32(body[4:8]) != 2 {
		t.Fatal("header/body")
	}
	a := attrs(t, m, unix.SizeofIfAddrmsg)
	if string(a[unix.IFA_LOCAL]) != string([]byte{10, 0, 1, 20}) || string(a[unix.IFA_BROADCAST]) != string([]byte{10, 0, 1, 255}) {
		t.Errorf("attrs %v", a)
	}
	if _, ok := attrs(t, AddrMessage(1, 2, netip.MustParsePrefix("10.0.0.7/32")), unix.SizeofIfAddrmsg)[unix.IFA_BROADCAST]; ok {
		t.Error("broadcast on a /32")
	}
}

func TestRouteMessage(t *testing.T) {
	src := netip.MustParseAddr("49.12.1.2")
	link := RouteMessage(1, 2, Route{Dst: netip.MustParsePrefix("172.31.1.1/32")}, src)
	body := link[unix.SizeofNlMsghdr:]
	if body[1] != 32 || body[6] != unix.RT_SCOPE_LINK {
		t.Error("on-link route scope")
	}
	a := attrs(t, link, unix.SizeofRtMsg)
	if _, ok := a[unix.RTA_GATEWAY]; ok || string(a[unix.RTA_DST]) != string([]byte{172, 31, 1, 1}) {
		t.Errorf("on-link attrs %v", a)
	}
	def := RouteMessage(2, 2, defaultVia("172.31.1.1"), src)
	body = def[unix.SizeofNlMsghdr:]
	a = attrs(t, def, unix.SizeofRtMsg)
	if body[1] != 0 || body[6] != unix.RT_SCOPE_UNIVERSE || string(a[unix.RTA_GATEWAY]) != string([]byte{172, 31, 1, 1}) {
		t.Errorf("default route %v", a)
	}
	if _, ok := a[unix.RTA_DST]; ok {
		t.Error("default route with a destination")
	}
}

func nlReply(seq uint32, typ uint16, code int32) []byte {
	b := make([]byte, unix.SizeofNlMsghdr+4)
	binary.NativeEndian.PutUint32(b[0:4], uint32(len(b)))
	binary.NativeEndian.PutUint16(b[4:6], typ)
	binary.NativeEndian.PutUint32(b[8:12], seq)
	binary.NativeEndian.PutUint32(b[16:20], uint32(code))
	return b
}

func TestAckFor(t *testing.T) {
	if done, err := AckFor(nlReply(5, unix.NLMSG_ERROR, 0), 5); !done || err != nil {
		t.Error("ack")
	}
	done, err := AckFor(append(nlReply(4, unix.NLMSG_ERROR, 0), nlReply(5, unix.NLMSG_ERROR, -int32(unix.EEXIST))...), 5)
	if !done || !errors.Is(err, syscall.EEXIST) {
		t.Errorf("error reply: %v %v", done, err)
	}
	if done, _ := AckFor(nlReply(4, unix.NLMSG_ERROR, 0), 5); done {
		t.Error("another sequence taken as the ack")
	}
	bad := nlReply(5, unix.NLMSG_ERROR, 0)
	binary.NativeEndian.PutUint32(bad[0:4], 1000)
	if done, err := AckFor(bad, 5); !done || err == nil {
		t.Error("malformed reply accepted")
	}
}
