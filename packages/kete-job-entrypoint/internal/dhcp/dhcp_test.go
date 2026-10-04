package dhcp

import (
	"encoding/binary"
	"net"
	"net/netip"
	"reflect"
	"testing"
)

var testMAC = net.HardwareAddr{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}

// reply builds a server message as a provider's DHCP server would.
func reply(xid uint32, mac net.HardwareAddr, yiaddr string, opts ...[]byte) []byte {
	b := make([]byte, headerLen)
	b[0], b[1], b[2] = opReply, 1, 6
	binary.BigEndian.PutUint32(b[4:8], xid)
	a := netip.MustParseAddr(yiaddr).As4()
	copy(b[16:20], a[:])
	copy(b[28:34], mac)
	b = append(b, magicCookie...)
	for _, o := range opts {
		b = append(b, o...)
	}
	return append(b, optEnd)
}

func opt(code byte, data ...byte) []byte { return append([]byte{code, byte(len(data))}, data...) }

func ip(s string) []byte { a := netip.MustParseAddr(s).As4(); return a[:] }

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func TestDiscoverAndRequest(t *testing.T) {
	d := Discover(0xdeadbeef, testMAC)
	if len(d) < minPacket || d[0] != opRequest || binary.BigEndian.Uint16(d[10:12]) != flagBcast {
		t.Fatalf("discover header: len %d op %d", len(d), d[0])
	}
	m, err := Parse(d)
	if err != nil || m.Type != TypeDiscover || m.XID != 0xdeadbeef || m.CHAddr.String() != testMAC.String() {
		t.Fatalf("discover = %+v, %v", m, err)
	}
	if !reflect.DeepEqual(m.Options[optParamRequest], []byte{1, 3, 26, 51, 54, 121}) {
		t.Errorf("parameter request list %v", m.Options[optParamRequest])
	}
	offer, err := Parse(reply(0xdeadbeef, testMAC, "10.0.0.5", opt(optMessageType, TypeOffer), opt(optServerID, ip("10.0.0.1")...)))
	if err != nil {
		t.Fatal(err)
	}
	r, err := Request(0xdeadbeef, testMAC, offer)
	if err != nil {
		t.Fatal(err)
	}
	rm, err := Parse(r)
	if err != nil || rm.Type != TypeRequest || string(rm.Options[optRequestedIP]) != string(ip("10.0.0.5")) || string(rm.Options[optServerID]) != string(ip("10.0.0.1")) {
		t.Errorf("request = %+v, %v", rm, err)
	}
	noServer, _ := Parse(reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeOffer)))
	if _, err := Request(1, testMAC, noServer); err == nil {
		t.Error("offer without server id accepted")
	}
}

func TestMatches(t *testing.T) {
	m, err := Parse(reply(7, testMAC, "10.0.0.5", opt(optMessageType, TypeAck)))
	if err != nil {
		t.Fatal(err)
	}
	if !m.Matches(7, testMAC) || m.Matches(8, testMAC) || m.Matches(7, net.HardwareAddr{2, 0, 0, 0, 0, 2}) {
		t.Error("matching")
	}
	req, _ := Parse(Discover(7, testMAC))
	if req.Matches(7, testMAC) {
		t.Error("a client message matched as a reply")
	}
}

func TestParseRefuses(t *testing.T) {
	good := reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeAck))
	cases := map[string][]byte{
		"short":       good[:200],
		"no cookie":   func() []byte { b := append([]byte(nil), good...); b[cookieStart] = 0; return b }(),
		"not eth":     func() []byte { b := append([]byte(nil), good...); b[1] = 6; return b }(),
		"no end":      good[:len(good)-1],
		"truncated":   cat(reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeAck))[:headerLen+4], []byte{optRouter, 8, 1, 2}),
		"overload":    reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeAck), opt(optOverload, 3)),
		"no type":     reply(1, testMAC, "10.0.0.5"),
		"oversize":    make([]byte, maxMessage+1),
		"double type": reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeAck), opt(optMessageType, TypeAck)),
	}
	for name, b := range cases {
		if _, err := Parse(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func lease(t *testing.T, yiaddr string, opts ...[]byte) (Lease, error) {
	t.Helper()
	m, err := Parse(reply(1, testMAC, yiaddr, append([][]byte{opt(optMessageType, TypeAck)}, opts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return LeaseFrom(m)
}

func defaultVia(gw string) Route {
	return Route{Dst: netip.MustParsePrefix("0.0.0.0/0"), Via: netip.MustParseAddr(gw)}
}

// TestProviderLeases: the three shapes of lease the supported providers hand out.
func TestProviderLeases(t *testing.T) {
	// GCP: a /32, router in option 3 and classless routes (gateway on-link, default through it).
	gcp, err := lease(t, "10.128.0.7",
		opt(optSubnetMask, 255, 255, 255, 255), opt(optRouter, ip("10.128.0.1")...),
		opt(optServerID, ip("169.254.169.254")...), opt(optMTU, 0x05, 0xb4), opt(optLeaseTime, 0, 1, 0x51, 0x80),
		opt(optClasslessRte, cat([]byte{32}, ip("10.128.0.1"), ip("0.0.0.0"), []byte{0}, ip("10.128.0.1"))...))
	if err != nil {
		t.Fatal(err)
	}
	want := []Route{{Dst: netip.MustParsePrefix("10.128.0.1/32")}, defaultVia("10.128.0.1")}
	if got := Plan(gcp); !reflect.DeepEqual(got, want) || gcp.MTU != 1460 || gcp.LeaseSeconds != 86400 || gcp.Addr.String() != "10.128.0.7/32" {
		t.Errorf("gcp: %+v plan %v", gcp, got)
	}
	// Hetzner: a /32 with an off-link router and no classless routes.
	hz, err := lease(t, "49.12.1.2", opt(optSubnetMask, 255, 255, 255, 255), opt(optRouter, ip("172.31.1.1")...))
	if err != nil {
		t.Fatal(err)
	}
	want = []Route{{Dst: netip.MustParsePrefix("172.31.1.1/32")}, defaultVia("172.31.1.1")}
	if got := Plan(hz); !reflect.DeepEqual(got, want) {
		t.Errorf("hetzner plan %v", got)
	}
	// OCI: an ordinary subnet with the router inside it.
	oci, err := lease(t, "10.0.1.20", opt(optSubnetMask, 255, 255, 255, 0), opt(optRouter, ip("10.0.1.1")...))
	if err != nil {
		t.Fatal(err)
	}
	if got := Plan(oci); !reflect.DeepEqual(got, []Route{defaultVia("10.0.1.1")}) {
		t.Errorf("oci plan %v", got)
	}
	// Classless routes replace option 3 (RFC 3442), on-link routes first.
	cl, err := lease(t, "10.0.0.5", opt(optSubnetMask, 255, 255, 255, 0), opt(optRouter, ip("10.0.0.99")...),
		opt(optClasslessRte, cat([]byte{0}, ip("10.0.0.1"), []byte{24, 10, 9, 8}, ip("0.0.0.0"))...))
	if err != nil {
		t.Fatal(err)
	}
	want = []Route{{Dst: netip.MustParsePrefix("10.9.8.0/24")}, defaultVia("10.0.0.1")}
	if got := Plan(cl); !reflect.DeepEqual(got, want) {
		t.Errorf("classless plan %v", got)
	}
	// No router at all: no route (kete-job-init then finds no uplink).
	none, err := lease(t, "10.0.0.5", opt(optSubnetMask, 255, 255, 255, 0))
	if err != nil || Plan(none) != nil {
		t.Errorf("no router: %v %v", Plan(none), err)
	}
	// An MTU out of range is ignored, not applied.
	odd, err := lease(t, "10.0.0.5", opt(optSubnetMask, 255, 255, 255, 0), opt(optMTU, 0x00, 0x44))
	if err != nil || odd.MTU != 0 {
		t.Errorf("mtu %d %v", odd.MTU, err)
	}
}

func TestLeaseRefuses(t *testing.T) {
	mask := opt(optSubnetMask, 255, 255, 255, 0)
	cases := map[string][]any{
		"link-local address": {"169.254.3.4", mask},
		"zero address":       {"0.0.0.0", mask},
		"multicast address":  {"224.0.0.5", mask},
		"no mask":            {"10.0.0.5"},
		"holey mask":         {"10.0.0.5", opt(optSubnetMask, 255, 0, 255, 0)},
		"zero mask":          {"10.0.0.5", opt(optSubnetMask, 0, 0, 0, 0)},
		"router link-local":  {"10.0.0.5", mask, opt(optRouter, ip("169.254.0.1")...)},
		"router is me":       {"10.0.0.5", mask, opt(optRouter, ip("10.0.0.5")...)},
		"router length":      {"10.0.0.5", mask, opt(optRouter, 10, 0, 0)},
		"server length":      {"10.0.0.5", mask, opt(optServerID, 10, 0)},
		"route width":        {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{33}, ip("10.0.0.1"), ip("10.0.0.1"))...)},
		"route truncated":    {"10.0.0.5", mask, opt(optClasslessRte, 24, 10, 0)},
		"route host bits":    {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{7, 11}, ip("10.0.0.1"))...)},
		"route via loopback": {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{0}, ip("127.0.0.1"))...)},
		"route via me":       {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{0}, ip("10.0.0.5"))...)},
		"route to loopback":  {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{8, 127}, ip("10.0.0.1"))...)},
		"route to multicast": {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{4, 224}, ip("10.0.0.1"))...)},
		"route to reserved":  {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{24, 250, 1, 2}, ip("10.0.0.1"))...)},
		"route to this net":  {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{8, 0}, ip("10.0.0.1"))...)},
		"route over 127/8":   {"10.0.0.5", mask, opt(optClasslessRte, cat([]byte{1, 0}, ip("10.0.0.1"))...)},
		"address in 0/8":     {"0.1.2.3", mask},
		"address in 240/4":   {"240.0.0.5", mask},
		"broadcast address":  {"255.255.255.255", mask},
		"router in 240/4":    {"10.0.0.5", mask, opt(optRouter, ip("241.0.0.1")...)},
	}
	for name, c := range cases {
		var opts [][]byte
		for _, o := range c[1:] {
			opts = append(opts, o.([]byte))
		}
		if _, err := lease(t, c[0].(string), opts...); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	offer, _ := Parse(reply(1, testMAC, "10.0.0.5", opt(optMessageType, TypeOffer), mask))
	if _, err := LeaseFrom(offer); err == nil {
		t.Error("an OFFER accepted as a lease")
	}
}

func TestPackets(t *testing.T) {
	payload := Discover(1, testMAC)
	pkt := IPv4UDP(payload)
	if checksum(pkt[:20]) != 0 {
		t.Error("IPv4 header checksum")
	}
	if pkt[9] != 17 || string(pkt[16:20]) != string([]byte{255, 255, 255, 255}) {
		t.Error("header fields")
	}
	// A server reply: swap the ports.
	srv := append([]byte(nil), pkt...)
	binary.BigEndian.PutUint16(srv[20:22], ServerPort)
	binary.BigEndian.PutUint16(srv[22:24], ClientPort)
	got, ok := UDPPayload(srv)
	if !ok || string(got) != string(payload) {
		t.Fatal("payload not recovered")
	}
	if _, ok := UDPPayload(pkt); ok {
		t.Error("client-to-server datagram accepted as a reply")
	}
	frag := append([]byte(nil), srv...)
	frag[6] = 0x20 // MF
	if _, ok := UDPPayload(frag); ok {
		t.Error("fragment accepted")
	}
	tcp := append([]byte(nil), srv...)
	tcp[9] = 6
	if _, ok := UDPPayload(tcp); ok {
		t.Error("TCP accepted")
	}
	short := append([]byte(nil), srv...)
	binary.BigEndian.PutUint16(short[2:4], uint16(len(srv)+10))
	if _, ok := UDPPayload(short); ok {
		t.Error("total length beyond the packet accepted")
	}
	badUDP := append([]byte(nil), srv...)
	binary.BigEndian.PutUint16(badUDP[24:26], uint16(len(srv)))
	if _, ok := UDPPayload(badUDP); ok {
		t.Error("UDP length beyond the packet accepted")
	}
}

func TestCheckAck(t *testing.T) {
	msg := func(typ byte, yiaddr string, server ...string) Message {
		opts := [][]byte{opt(optMessageType, typ)}
		if len(server) > 0 {
			opts = append(opts, opt(optServerID, ip(server[0])...))
		}
		m, err := Parse(reply(1, testMAC, yiaddr, opts...))
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	offer := msg(TypeOffer, "10.0.0.5", "10.0.0.1")
	if err := CheckAck(offer, msg(TypeAck, "10.0.0.5", "10.0.0.1")); err != nil {
		t.Errorf("matching ACK refused: %v", err)
	}
	for name, ack := range map[string]Message{
		"no server id":    msg(TypeAck, "10.0.0.5"),
		"another server":  msg(TypeAck, "10.0.0.5", "10.0.0.2"),
		"another address": msg(TypeAck, "10.0.0.6", "10.0.0.1"),
	} {
		if err := CheckAck(offer, ack); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := CheckAck(msg(TypeOffer, "10.0.0.5"), msg(TypeAck, "10.0.0.5", "10.0.0.1")); err == nil {
		t.Error("offer without server id accepted")
	}
}
