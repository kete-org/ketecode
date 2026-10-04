// Package dhcp is kete-job-init's DHCPv4 client for cloudvm guests (kete-code-platform ADR 0023
// rule 15: "DHCP on a cloud VM"). The kernel's own client (`ip=dhcp`) can't configure GCP or
// Hetzner VMs: both hand out a /32 address whose gateway is outside it (GCP through the classless
// static routes of option 121, Hetzner through an off-link router), and the kernel refuses a gateway
// that isn't on a directly connected network. This client asks for one lease, validates it
// strictly (the reply comes from the provider's network, before anything else runs), and turns it
// into an address and routes (Plan) that the Linux half installs over netlink. It never renews: a
// job VM lives for at most its deadline and every supported provider binds the address to the VM.
//
// This file is pure (messages, parsing, the route plan); client_linux.go is the socket side.
package dhcp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
)

// Message types (option 53).
const (
	TypeDiscover byte = 1
	TypeOffer    byte = 2
	TypeRequest  byte = 3
	TypeAck      byte = 5
	TypeNak      byte = 6
)

// Option codes used here.
const (
	optPad          byte = 0
	optSubnetMask   byte = 1
	optRouter       byte = 3
	optDNS          byte = 6
	optMTU          byte = 26
	optRequestedIP  byte = 50
	optLeaseTime    byte = 51
	optOverload     byte = 52
	optMessageType  byte = 53
	optServerID     byte = 54
	optParamRequest byte = 55
	optMaxSize      byte = 57
	optClasslessRte byte = 121
	optEnd          byte = 255
)

const (
	opRequest   = 1
	opReply     = 2
	headerLen   = 236 // the fixed BOOTP header
	minPacket   = 300 // BOOTP's minimum message, padded with optPad
	maxMessage  = 1500
	flagBcast   = 0x8000
	ClientPort  = 68
	ServerPort  = 67
	cookieStart = headerLen
)

var magicCookie = []byte{99, 130, 83, 99}

// Message is a parsed DHCP reply (or request, for tests).
type Message struct {
	Op      byte
	XID     uint32
	CHAddr  net.HardwareAddr
	YIAddr  netip.Addr
	Type    byte
	Options map[byte][]byte // concatenated per RFC 3396 when an option repeats
}

// Route is one IPv4 route; an invalid Via means on-link (scope link).
type Route struct {
	Dst netip.Prefix
	Via netip.Addr
}

// Lease is a validated DHCPACK.
type Lease struct {
	Addr         netip.Prefix // the address with its subnet (option 1)
	Router       netip.Addr   // option 3's first router, or invalid
	Routes       []Route      // option 121, in order
	MTU          int          // option 26, 0 when absent
	Server       netip.Addr   // option 54
	LeaseSeconds uint32       // option 51, 0 when absent
}

// request builds a client message of type t.
func request(t byte, xid uint32, mac net.HardwareAddr, extra ...[]byte) []byte {
	b := make([]byte, headerLen, maxMessage)
	b[0] = opRequest
	b[1] = 1 // Ethernet
	b[2] = 6
	binary.BigEndian.PutUint32(b[4:8], xid)
	binary.BigEndian.PutUint16(b[10:12], flagBcast) // replies broadcast: no address is configured yet
	copy(b[28:34], mac)
	b = append(b, magicCookie...)
	b = append(b, optMessageType, 1, t)
	b = append(b, optParamRequest, 6, optSubnetMask, optRouter, optMTU, optLeaseTime, optServerID, optClasslessRte)
	b = append(b, optMaxSize, 2, byte(maxMessage>>8), byte(maxMessage&0xff))
	for _, e := range extra {
		b = append(b, e...)
	}
	b = append(b, optEnd)
	for len(b) < minPacket {
		b = append(b, optPad)
	}
	return b
}

func addrOption(code byte, a netip.Addr) []byte {
	v := a.As4()
	return []byte{code, 4, v[0], v[1], v[2], v[3]}
}

// Discover is the first message of an exchange.
func Discover(xid uint32, mac net.HardwareAddr) []byte {
	return request(TypeDiscover, xid, mac)
}

// Request asks the server that sent offer for its offered address.
func Request(xid uint32, mac net.HardwareAddr, offer Message) ([]byte, error) {
	server, err := addr4(offer.Options[optServerID])
	if err != nil || !offer.YIAddr.Is4() {
		return nil, errors.New("dhcp: offer without server id or address")
	}
	return request(TypeRequest, xid, mac, addrOption(optRequestedIP, offer.YIAddr), addrOption(optServerID, server)), nil
}

// Parse decodes a DHCP message: the BOOTP header, the magic cookie and the options (bounded; a
// repeated option is concatenated, RFC 3396). Option overload (52) is refused: no supported
// provider uses it and the file/sname fields are not read.
func Parse(b []byte) (Message, error) {
	if len(b) < headerLen+len(magicCookie)+1 || len(b) > maxMessage {
		return Message{}, errors.New("dhcp: bad length")
	}
	if b[1] != 1 || b[2] != 6 {
		return Message{}, errors.New("dhcp: not Ethernet")
	}
	if string(b[cookieStart:cookieStart+4]) != string(magicCookie) {
		return Message{}, errors.New("dhcp: no magic cookie")
	}
	m := Message{
		Op:      b[0],
		XID:     binary.BigEndian.Uint32(b[4:8]),
		CHAddr:  net.HardwareAddr(append([]byte(nil), b[28:34]...)),
		YIAddr:  netip.AddrFrom4([4]byte(b[16:20])),
		Options: map[byte][]byte{},
	}
	opts := b[cookieStart+4:]
	ended := false
	for i := 0; i < len(opts); {
		code := opts[i]
		if code == optPad {
			i++
			continue
		}
		if code == optEnd {
			ended = true
			break
		}
		if i+1 >= len(opts) {
			return Message{}, errors.New("dhcp: truncated option")
		}
		n := int(opts[i+1])
		if i+2+n > len(opts) {
			return Message{}, errors.New("dhcp: truncated option")
		}
		m.Options[code] = append(m.Options[code], opts[i+2:i+2+n]...)
		i += 2 + n
	}
	if !ended {
		return Message{}, errors.New("dhcp: options without end")
	}
	if _, ok := m.Options[optOverload]; ok {
		return Message{}, errors.New("dhcp: option overload not supported")
	}
	t := m.Options[optMessageType]
	if len(t) != 1 {
		return Message{}, errors.New("dhcp: no message type")
	}
	m.Type = t[0]
	return m, nil
}

// Matches says whether m is a server reply to this client's exchange.
func (m Message) Matches(xid uint32, mac net.HardwareAddr) bool {
	return m.Op == opReply && m.XID == xid && string(m.CHAddr) == string(mac)
}

func addr4(b []byte) (netip.Addr, error) {
	if len(b) != 4 {
		return netip.Addr{}, errors.New("dhcp: bad address option")
	}
	return netip.AddrFrom4([4]byte(b)), nil
}

// Ranges no lease may use as an address or route anywhere into (RFC 6890): "this network",
// loopback, multicast, reserved (with the limited broadcast).
var (
	thisNet   = netip.MustParsePrefix("0.0.0.0/8")
	loopback  = netip.MustParsePrefix("127.0.0.0/8")
	multicast = netip.MustParsePrefix("224.0.0.0/4")
	reserved  = netip.MustParsePrefix("240.0.0.0/4")
)

// unicast4 is an address a host may use as its own or as a next hop: not in 0/8, 127/8, 224/4,
// 240/4 or link-local.
func unicast4(a netip.Addr) bool {
	return a.Is4() && !a.IsLinkLocalUnicast() && !thisNet.Contains(a) && !loopback.Contains(a) &&
		!multicast.Contains(a) && !reserved.Contains(a)
}

// routable says whether a classless route's destination is acceptable: the default route, or a
// prefix that overlaps none of 0/8, 127/8, 224/4 and 240/4.
func routable(p netip.Prefix) bool {
	if p.Bits() == 0 {
		return true
	}
	for _, bad := range []netip.Prefix{thisNet, loopback, multicast, reserved} {
		if p.Overlaps(bad) {
			return false
		}
	}
	return true
}

// maskBits returns the prefix length of a contiguous IPv4 netmask.
func maskBits(b []byte) (int, error) {
	if len(b) != 4 {
		return 0, errors.New("dhcp: bad subnet mask")
	}
	ones, bits := net.IPMask(b).Size()
	if bits != 32 || ones == 0 {
		return 0, errors.New("dhcp: bad subnet mask")
	}
	return ones, nil
}

// classless parses option 121 (RFC 3442): per route, a width, the significant octets of the
// destination, then the router (0.0.0.0 = on-link).
func classless(b []byte) ([]Route, error) {
	var out []Route
	for i := 0; i < len(b); {
		width := int(b[i])
		if width > 32 {
			return nil, errors.New("dhcp: bad classless route width")
		}
		sig := (width + 7) / 8
		if i+1+sig+4 > len(b) {
			return nil, errors.New("dhcp: truncated classless route")
		}
		var dst [4]byte
		copy(dst[:], b[i+1:i+1+sig])
		p, err := netip.AddrFrom4(dst).Prefix(width)
		if err != nil {
			return nil, err
		}
		if p.Addr() != netip.AddrFrom4(dst) {
			return nil, errors.New("dhcp: classless route with host bits")
		}
		if !routable(p) {
			return nil, errors.New("dhcp: classless route into a reserved range")
		}
		via := netip.AddrFrom4([4]byte(b[i+1+sig : i+1+sig+4]))
		r := Route{Dst: p}
		if !via.IsUnspecified() {
			if !unicast4(via) {
				return nil, errors.New("dhcp: bad classless route router")
			}
			r.Via = via
		}
		out = append(out, r)
		i += 1 + sig + 4
		if len(out) > 32 {
			return nil, errors.New("dhcp: too many classless routes")
		}
	}
	return out, nil
}

// LeaseFrom validates an ACK: a unicast address (not link-local: every provider's metadata range is
// dropped after the configuration is read), a contiguous subnet mask, a unicast router and server
// id, well-formed classless routes, and an MTU only within Ethernet's sane range (else ignored).
func LeaseFrom(m Message) (Lease, error) {
	if m.Type != TypeAck {
		return Lease{}, fmt.Errorf("dhcp: message type %d, want ACK", m.Type)
	}
	if !unicast4(m.YIAddr) {
		return Lease{}, errors.New("dhcp: bad leased address")
	}
	bits, err := maskBits(m.Options[optSubnetMask])
	if err != nil {
		return Lease{}, err
	}
	l := Lease{Addr: netip.PrefixFrom(m.YIAddr, bits)}
	if r := m.Options[optRouter]; len(r) > 0 {
		if len(r)%4 != 0 {
			return Lease{}, errors.New("dhcp: bad router option")
		}
		l.Router = netip.AddrFrom4([4]byte(r[:4]))
		if !unicast4(l.Router) || l.Router == m.YIAddr {
			return Lease{}, errors.New("dhcp: bad router")
		}
	}
	if s, ok := m.Options[optServerID]; ok {
		if l.Server, err = addr4(s); err != nil {
			return Lease{}, err
		}
	}
	if c, ok := m.Options[optClasslessRte]; ok {
		if l.Routes, err = classless(c); err != nil {
			return Lease{}, err
		}
		for _, r := range l.Routes {
			if r.Via == m.YIAddr {
				return Lease{}, errors.New("dhcp: classless route through the leased address")
			}
		}
	}
	if v := m.Options[optMTU]; len(v) == 2 {
		if mtu := int(binary.BigEndian.Uint16(v)); mtu >= 576 && mtu <= 9216 {
			l.MTU = mtu
		}
	}
	if v := m.Options[optLeaseTime]; len(v) == 4 {
		l.LeaseSeconds = binary.BigEndian.Uint32(v)
	}
	return l, nil
}

// CheckAck binds an ACK to the offer it answers: the same server id (option 54, required in both)
// and the same address.
func CheckAck(offer, ack Message) error {
	offerServer, err := addr4(offer.Options[optServerID])
	if err != nil {
		return errors.New("dhcp: offer without server id")
	}
	as, err := addr4(ack.Options[optServerID])
	if err != nil {
		return errors.New("dhcp: ACK without server id")
	}
	if as != offerServer {
		return errors.New("dhcp: ACK from another server than the offer")
	}
	if ack.YIAddr != offer.YIAddr {
		return errors.New("dhcp: ACK for another address than offered")
	}
	return nil
}

// Plan is the routes to install after the address, in order: option 121's when present (RFC 3442:
// they replace option 3), on-link ones first; else a default route through the router, preceded
// by an on-link host route to it when it's outside the leased subnet (Hetzner's 172.31.1.1). A
// lease without either yields no route, and kete-job-init then finds no uplink and powers off.
func Plan(l Lease) []Route {
	var link, via []Route
	if len(l.Routes) > 0 {
		for _, r := range l.Routes {
			if r.Via.IsValid() {
				via = append(via, r)
			} else {
				link = append(link, r)
			}
		}
		return append(link, via...)
	}
	if !l.Router.IsValid() {
		return nil
	}
	if !l.Addr.Masked().Contains(l.Router) {
		link = append(link, Route{Dst: netip.PrefixFrom(l.Router, 32)})
	}
	return append(link, Route{Dst: netip.PrefixFrom(netip.IPv4Unspecified(), 0), Via: l.Router})
}
