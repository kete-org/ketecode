package dhcp

import "encoding/binary"

// IPv4UDP wraps a DHCP payload in the IPv4 and UDP headers of a client broadcast: 0.0.0.0:68 to
// 255.255.255.255:67, TTL 64, no options; the UDP checksum is left 0 (optional over IPv4).
func IPv4UDP(payload []byte) []byte {
	const ipLen, udpLen = 20, 8
	b := make([]byte, ipLen+udpLen+len(payload))
	b[0] = 0x45 // version 4, IHL 5
	binary.BigEndian.PutUint16(b[2:4], uint16(len(b)))
	b[8] = 64 // TTL
	b[9] = 17 // UDP
	copy(b[16:20], []byte{255, 255, 255, 255})
	binary.BigEndian.PutUint16(b[10:12], checksum(b[:ipLen]))
	u := b[ipLen:]
	binary.BigEndian.PutUint16(u[0:2], ClientPort)
	binary.BigEndian.PutUint16(u[2:4], ServerPort)
	binary.BigEndian.PutUint16(u[4:6], uint16(udpLen+len(payload)))
	copy(u[udpLen:], payload)
	return b
}

// UDPPayload returns the payload of an IPv4 packet that is an unfragmented UDP datagram from port
// 67 to port 68 with consistent lengths, or false.
func UDPPayload(b []byte) ([]byte, bool) {
	if len(b) < 20 || b[0]>>4 != 4 {
		return nil, false
	}
	ihl := int(b[0]&0x0f) * 4
	total := int(binary.BigEndian.Uint16(b[2:4]))
	if ihl < 20 || total < ihl+8 || total > len(b) || b[9] != 17 {
		return nil, false
	}
	if frag := binary.BigEndian.Uint16(b[6:8]); frag&0x3fff != 0 { // MF set or an offset
		return nil, false
	}
	u := b[ihl:total]
	if binary.BigEndian.Uint16(u[0:2]) != ServerPort || binary.BigEndian.Uint16(u[2:4]) != ClientPort {
		return nil, false
	}
	ul := int(binary.BigEndian.Uint16(u[4:6]))
	if ul < 8 || ul > len(u) {
		return nil, false
	}
	return u[8:ul], true
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i : i+2]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}
