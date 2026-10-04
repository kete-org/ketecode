//go:build linux

package dhcp

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Uplink is the guest's one Ethernet interface.
type Uplink struct {
	Name  string
	Index int
	MAC   net.HardwareAddr
}

// FindUplink returns the only non-loopback interface with an Ethernet address. None or more than
// one is an error: a job VM has exactly one NIC, and guessing would configure the wrong one.
func FindUplink() (Uplink, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return Uplink{}, err
	}
	var found []Uplink
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || len(i.HardwareAddr) != 6 {
			continue
		}
		found = append(found, Uplink{Name: i.Name, Index: i.Index, MAC: i.HardwareAddr})
	}
	if len(found) != 1 {
		return Uplink{}, fmt.Errorf("dhcp: %d Ethernet interfaces, want 1", len(found))
	}
	return found[0], nil
}

// Client runs one DHCP exchange on an interface.
type Client struct {
	Wait     time.Duration // per reply
	Attempts int           // whole exchanges
	SysNet   string        // /sys/class/net
}

// DefaultClient: up to four exchanges of at most 4 s per reply (with the carrier wait, well
// inside kete-job-init's network step).
func DefaultClient() Client {
	return Client{Wait: 4 * time.Second, Attempts: 4, SysNet: "/sys/class/net"}
}

// Configure brings u up, waits for its carrier, obtains a lease and installs it: the MTU, the
// address and Plan's routes. It returns the lease (for tests and logs: no value is printed by
// kete-job-init).
func (c Client) Configure(ctx context.Context, u Uplink) (Lease, error) {
	if err := setUp(u.Name); err != nil {
		return Lease{}, err
	}
	if err := c.waitCarrier(ctx, u.Name, 10*time.Second); err != nil {
		return Lease{}, err
	}
	l, err := c.Acquire(ctx, u)
	if err != nil {
		return Lease{}, err
	}
	if err := Install(u, l); err != nil {
		return Lease{}, err
	}
	return l, nil
}

func (c Client) waitCarrier(ctx context.Context, name string, d time.Duration) error {
	deadline := time.Now().Add(d)
	for {
		b, err := os.ReadFile(filepath.Join(c.SysNet, name, "carrier"))
		if err == nil && strings.TrimSpace(string(b)) == "1" {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("dhcp: no carrier")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Acquire runs DISCOVER/OFFER/REQUEST/ACK over a packet socket (the interface has no address
// yet, and a server may unicast its reply to the offered address).
func (c Client) Acquire(ctx context.Context, u Uplink) (Lease, error) {
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, int(htons(unix.ETH_P_IP)))
	if err != nil {
		return Lease{}, fmt.Errorf("dhcp: socket: %w", err)
	}
	defer unix.Close(fd)
	if err := unix.Bind(fd, &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_IP), Ifindex: u.Index}); err != nil {
		return Lease{}, fmt.Errorf("dhcp: bind: %w", err)
	}
	var last error = errors.New("dhcp: no attempt")
	for a := 0; a < max(c.Attempts, 1); a++ {
		if a > 0 {
			select {
			case <-ctx.Done():
				return Lease{}, ctx.Err()
			case <-time.After(time.Duration(a) * time.Second):
			}
		}
		l, err := c.exchange(ctx, fd, u)
		if err == nil {
			return l, nil
		}
		last = err
		if ctx.Err() != nil {
			return Lease{}, ctx.Err()
		}
	}
	return Lease{}, last
}

func (c Client) exchange(ctx context.Context, fd int, u Uplink) (Lease, error) {
	var x [4]byte
	if _, err := rand.Read(x[:]); err != nil {
		return Lease{}, err
	}
	xid := binary.BigEndian.Uint32(x[:])
	if err := send(fd, u, Discover(xid, u.MAC)); err != nil {
		return Lease{}, err
	}
	offer, err := c.receive(ctx, fd, xid, u.MAC, TypeOffer)
	if err != nil {
		return Lease{}, err
	}
	req, err := Request(xid, u.MAC, offer)
	if err != nil {
		return Lease{}, err
	}
	if err := send(fd, u, req); err != nil {
		return Lease{}, err
	}
	ack, err := c.receive(ctx, fd, xid, u.MAC, TypeAck)
	if err != nil {
		return Lease{}, err
	}
	if err := CheckAck(offer, ack); err != nil {
		return Lease{}, err
	}
	return LeaseFrom(ack)
}

// receive waits up to c.Wait for a reply of type want to xid (a NAK ends the exchange).
func (c Client) receive(ctx context.Context, fd int, xid uint32, mac net.HardwareAddr, want byte) (Message, error) {
	deadline := time.Now().Add(c.Wait)
	buf := make([]byte, 2048)
	for {
		if err := ctx.Err(); err != nil {
			return Message{}, err
		}
		left := time.Until(deadline)
		if left <= 0 {
			return Message{}, errors.New("dhcp: no reply")
		}
		ms := min(int(left/time.Millisecond)+1, 250)
		n, err := unix.Poll([]unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}, ms)
		if err != nil && !errors.Is(err, unix.EINTR) {
			return Message{}, err
		}
		if n <= 0 {
			continue
		}
		got, _, err := unix.Recvfrom(fd, buf, unix.MSG_DONTWAIT)
		if err != nil {
			if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
				continue
			}
			return Message{}, err
		}
		payload, ok := UDPPayload(buf[:got])
		if !ok {
			continue
		}
		m, err := Parse(payload)
		if err != nil || !m.Matches(xid, mac) {
			continue
		}
		if m.Type == TypeNak {
			return Message{}, errors.New("dhcp: NAK")
		}
		if m.Type == want {
			return m, nil
		}
	}
}

func send(fd int, u Uplink, payload []byte) error {
	pkt := IPv4UDP(payload)
	to := &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_IP), Ifindex: u.Index, Halen: 6}
	copy(to.Addr[:], []byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	if err := unix.Sendto(fd, pkt, 0, to); err != nil {
		return fmt.Errorf("dhcp: send: %w", err)
	}
	return nil
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

func setUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}

func setMTU(name string, mtu int) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	ifr.SetUint32(uint32(mtu))
	return unix.IoctlIfreq(fd, unix.SIOCSIFMTU, ifr)
}

// Install sets the lease's MTU (when given), adds its address and Plan's routes over netlink, and
// fails on the first error the kernel reports.
func Install(u Uplink, l Lease) error {
	if l.MTU > 0 {
		if err := setMTU(u.Name, l.MTU); err != nil {
			return fmt.Errorf("dhcp: mtu: %w", err)
		}
	}
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	tv := unix.NsecToTimeval(int64(5 * time.Second))
	if err := unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv); err != nil {
		return err
	}
	seq := uint32(1)
	if err := netlinkDo(fd, AddrMessage(seq, u.Index, l.Addr)); err != nil {
		return fmt.Errorf("dhcp: address: %w", err)
	}
	for _, r := range Plan(l) {
		seq++
		if err := netlinkDo(fd, RouteMessage(seq, u.Index, r, l.Addr.Addr())); err != nil {
			return fmt.Errorf("dhcp: route %s: %w", r.Dst, err)
		}
	}
	return nil
}

func netlinkDo(fd int, msg []byte) error {
	if err := unix.Sendto(fd, msg, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	seq := binary.NativeEndian.Uint32(msg[8:12])
	buf := make([]byte, 8192)
	for {
		n, _, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		done, err := AckFor(buf[:n], seq)
		if done {
			return err
		}
	}
}
