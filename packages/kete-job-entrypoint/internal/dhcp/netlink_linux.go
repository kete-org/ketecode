//go:build linux

package dhcp

import (
	"encoding/binary"
	"errors"
	"net/netip"
	"syscall"

	"golang.org/x/sys/unix"
)

const rtprotDHCP = 16 // RTPROT_DHCP

func nlAlign(n int) int { return (n + 3) &^ 3 }

// nlMessage builds one netlink request: header, fixed body, then attributes.
func nlMessage(typ uint16, flags uint16, seq uint32, body []byte, attrs ...[]byte) []byte {
	b := make([]byte, unix.SizeofNlMsghdr, 256)
	b = append(b, body...)
	for len(b)%4 != 0 {
		b = append(b, 0)
	}
	for _, a := range attrs {
		b = append(b, a...)
	}
	binary.NativeEndian.PutUint32(b[0:4], uint32(len(b)))
	binary.NativeEndian.PutUint16(b[4:6], typ)
	binary.NativeEndian.PutUint16(b[6:8], flags)
	binary.NativeEndian.PutUint32(b[8:12], seq)
	return b
}

func rtAttr(typ uint16, data []byte) []byte {
	l := unix.SizeofRtAttr + len(data)
	b := make([]byte, nlAlign(l))
	binary.NativeEndian.PutUint16(b[0:2], uint16(l))
	binary.NativeEndian.PutUint16(b[2:4], typ)
	copy(b[unix.SizeofRtAttr:], data)
	return b
}

func ip4(a netip.Addr) []byte { v := a.As4(); return v[:] }

func u32(v uint32) []byte {
	b := make([]byte, 4)
	binary.NativeEndian.PutUint32(b, v)
	return b
}

// AddrMessage is RTM_NEWADDR for p on ifindex (create, exclusive, acknowledged).
func AddrMessage(seq uint32, ifindex int, p netip.Prefix) []byte {
	body := make([]byte, unix.SizeofIfAddrmsg)
	body[0] = unix.AF_INET
	body[1] = byte(p.Bits())
	body[3] = unix.RT_SCOPE_UNIVERSE
	binary.NativeEndian.PutUint32(body[4:8], uint32(ifindex))
	attrs := [][]byte{rtAttr(unix.IFA_LOCAL, ip4(p.Addr())), rtAttr(unix.IFA_ADDRESS, ip4(p.Addr()))}
	if p.Bits() < 31 {
		v := p.Masked().Addr().As4()
		m := ^uint32(0) >> p.Bits()
		bc := binary.BigEndian.Uint32(v[:]) | m
		var out [4]byte
		binary.BigEndian.PutUint32(out[:], bc)
		attrs = append(attrs, rtAttr(unix.IFA_BROADCAST, out[:]))
	}
	return nlMessage(unix.RTM_NEWADDR, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, seq, body, attrs...)
}

// RouteMessage is RTM_NEWROUTE for r in the main table through ifindex: scope link without a
// router, universe with one; src is the preferred source address.
func RouteMessage(seq uint32, ifindex int, r Route, src netip.Addr) []byte {
	body := make([]byte, unix.SizeofRtMsg)
	body[0] = unix.AF_INET
	body[1] = byte(r.Dst.Bits())
	body[4] = unix.RT_TABLE_MAIN
	body[5] = rtprotDHCP
	body[6] = unix.RT_SCOPE_UNIVERSE
	if !r.Via.IsValid() {
		body[6] = unix.RT_SCOPE_LINK
	}
	body[7] = unix.RTN_UNICAST
	var attrs [][]byte
	if r.Dst.Bits() > 0 {
		attrs = append(attrs, rtAttr(unix.RTA_DST, ip4(r.Dst.Addr())))
	}
	if r.Via.IsValid() {
		attrs = append(attrs, rtAttr(unix.RTA_GATEWAY, ip4(r.Via)))
	}
	attrs = append(attrs, rtAttr(unix.RTA_OIF, u32(uint32(ifindex))), rtAttr(unix.RTA_PREFSRC, ip4(src)))
	return nlMessage(unix.RTM_NEWROUTE, unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_EXCL, seq, body, attrs...)
}

// AckFor scans netlink replies for the acknowledgement of seq: done with nil for an ACK, done
// with the errno for an error; not done when the buffer holds neither.
func AckFor(b []byte, seq uint32) (bool, error) {
	for len(b) >= unix.SizeofNlMsghdr {
		l := int(binary.NativeEndian.Uint32(b[0:4]))
		if l < unix.SizeofNlMsghdr || l > len(b) {
			return true, errors.New("netlink: malformed reply")
		}
		typ := binary.NativeEndian.Uint16(b[4:6])
		s := binary.NativeEndian.Uint32(b[8:12])
		if s == seq && typ == unix.NLMSG_ERROR {
			if l < unix.SizeofNlMsghdr+4 {
				return true, errors.New("netlink: short error")
			}
			code := int32(binary.NativeEndian.Uint32(b[unix.SizeofNlMsghdr : unix.SizeofNlMsghdr+4]))
			if code == 0 {
				return true, nil
			}
			return true, syscall.Errno(-code)
		}
		if nlAlign(l) >= len(b) {
			break
		}
		b = b[nlAlign(l):]
	}
	return false, nil
}
