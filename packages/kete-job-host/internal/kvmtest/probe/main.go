//go:build linux

// Command probe is a test-only guest program for the KVM acceptance tests (internal/kvmtest,
// build tag kvm). It replaces the job entrypoint in a derived test image, so kete-job-init starts
// it as guest root with no in-guest firewall at all, and tries to reach what ADR 0023 rule 7 says
// the host table must keep from a guest: the host, other guests, private and special ranges, the
// metadata address and IPv6, plus the two things it allows (TCP 443 out and DNS to the resolver).
// Results go to the console as `KPROBE {json}` lines. Never part of a release image.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type target struct {
	Name string `json:"name"`
	Net  string `json:"net"` // tcp, udp, icmp, dns
	Addr string `json:"addr"`
	// Query is the DNS name for net=dns (resolved through Addr).
	Query string `json:"query,omitempty"`
}

type probeConfig struct {
	Listen      []string `json:"listen"`
	WaitSecs    int      `json:"wait_secs"`
	ListenSecs  int      `json:"listen_secs"`
	SleepAfter  bool     `json:"sleep_after"`
	Targets     []target `json:"targets"`
	TimeoutSecs int      `json:"timeout_secs"`
}

func emit(v any) {
	b, _ := json.Marshal(v)
	fmt.Printf("KPROBE %s\n", b)
}

func main() {
	raw, err := os.ReadFile("/etc/kete-probe.json")
	if err != nil {
		emit(map[string]string{"name": "config", "result": "error: " + err.Error()})
		os.Exit(1)
	}
	var c probeConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		emit(map[string]string{"name": "config", "result": "error: " + err.Error()})
		os.Exit(1)
	}
	self := selfAddr()
	gw := gateway()
	emit(map[string]string{"name": "self", "result": self, "gateway": gw, "uid": strconv.Itoa(os.Getuid())})
	for _, l := range c.Listen {
		ln, err := net.Listen("tcp4", l)
		if err != nil {
			emit(map[string]string{"name": "listen " + l, "result": "error: " + err.Error()})
			continue
		}
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				emit(map[string]string{"name": "accepted", "result": conn.RemoteAddr().String()})
				conn.Close()
			}
		}()
	}
	time.Sleep(time.Duration(c.WaitSecs) * time.Second)
	timeout := time.Duration(max(c.TimeoutSecs, 2)) * time.Second
	for _, t := range c.Targets {
		addr := strings.ReplaceAll(t.Addr, "GATEWAY", gw)
		if host, _, err := net.SplitHostPort(addr); err == nil && host == self {
			continue // a VM doesn't probe itself
		}
		emit(map[string]string{"name": t.Name, "addr": addr, "result": try(t, addr, timeout)})
	}
	emit(map[string]string{"name": "done", "result": "ok"})
	for c.SleepAfter { // a guest that never exits (the deadline killer's target)
		time.Sleep(time.Hour)
	}
	time.Sleep(time.Duration(c.ListenSecs) * time.Second)
}

// try returns "open" (a connection or an answer), "refused" (something answered with a reset or
// ICMP error: reachable), or "blocked" (silence or no route).
func try(t target, addr string, timeout time.Duration) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	switch t.Net {
	case "tcp", "tcp6":
		var d net.Dialer
		c, err := d.DialContext(ctx, t.Net, addr)
		if err == nil {
			c.Close()
			return "open"
		}
		return classify(err)
	case "udp":
		var d net.Dialer
		c, err := d.DialContext(ctx, "udp4", addr)
		if err != nil {
			return classify(err)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(timeout))
		if _, err := c.Write([]byte("kprobe")); err != nil {
			return classify(err)
		}
		buf := make([]byte, 512)
		if _, err := c.Read(buf); err != nil {
			return classify(err)
		}
		return "open"
	case "dns":
		r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}}
		ips, err := r.LookupHost(ctx, t.Query)
		if err != nil {
			return classify(err)
		}
		return "open " + strings.Join(ips, ",")
	case "icmp":
		return ping(addr, timeout)
	case "storm":
		return storm(addr)
	}
	return "error: unknown net " + t.Net
}

func classify(err error) string {
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, os.ErrDeadlineExceeded),
		errors.Is(err, context.DeadlineExceeded), errors.Is(err, syscall.EADDRNOTAVAIL):
		return "blocked"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "blocked"
	}
	return "error: " + err.Error()
}

// ping sends one ICMP echo request from a raw socket (guest root) and waits for any reply.
func ping(addr string, timeout time.Duration) string {
	ip := net.ParseIP(addr).To4()
	if ip == nil {
		return "error: not ipv4"
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_RAW, unix.IPPROTO_ICMP)
	if err != nil {
		return "error: " + err.Error()
	}
	defer unix.Close(fd)
	msg := []byte{8, 0, 0, 0, 0x4b, 0x50, 0, 1, 'k', 'p', 'r', 'o', 'b', 'e'}
	binary.BigEndian.PutUint16(msg[2:], checksum(msg))
	sa := &unix.SockaddrInet4{}
	copy(sa.Addr[:], ip)
	if err := unix.Sendto(fd, msg, 0, sa); err != nil {
		return classify(err)
	}
	tv := unix.NsecToTimeval(timeout.Nanoseconds())
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	buf := make([]byte, 1500)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		n, from, err := unix.Recvfrom(fd, buf, 0)
		if err != nil {
			return "blocked"
		}
		if f, ok := from.(*unix.SockaddrInet4); ok && net.IP(f.Addr[:]).Equal(ip) && n > 20 && buf[20] == 0 {
			return "open"
		}
	}
	return "blocked"
}

func checksum(b []byte) uint16 {
	var s uint32
	for i := 0; i+1 < len(b); i += 2 {
		s += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		s += uint32(b[len(b)-1]) << 8
	}
	for s>>16 != 0 {
		s = s&0xffff + s>>16
	}
	return ^uint16(s)
}

func selfAddr() string {
	ifs, _ := net.InterfaceAddrs()
	for _, a := range ifs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && !n.IP.IsLoopback() {
			return n.IP.String()
		}
	}
	return ""
}

func gateway() string {
	b, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n")[1:] {
		f := strings.Fields(line)
		if len(f) >= 3 && f[1] == "00000000" {
			v, err := strconv.ParseUint(f[2], 16, 32)
			if err == nil {
				ip := make(net.IP, 4)
				binary.LittleEndian.PutUint32(ip, uint32(v))
				return ip.String()
			}
		}
	}
	return ""
}

// storm mirrors the entrypoint's host-boundary check's timing (64 concurrent dials with 300 ms
// timeouts to blocked targets) while dialing a loopback control and opening "/", and reports how
// the controls fared (diagnostics for the KVM tests).
func storm(gw string) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "error: " + err.Error()
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	jobs := make(chan string)
	var out []string
	var mu = make(chan struct{}, 1)
	done := make(chan struct{})
	n := 0
	for w := 0; w < 64; w++ {
		go func() {
			for a := range jobs {
				start := time.Now()
				ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
				c, err := (&net.Dialer{}).DialContext(ctx, "tcp", a)
				cancel()
				if a == ln.Addr().String() {
					mu <- struct{}{}
					if err != nil {
						out = append(out, fmt.Sprintf("control %v after %v", err, time.Since(start)))
					} else {
						out = append(out, fmt.Sprintf("control ok after %v", time.Since(start)))
					}
					<-mu
				}
				if c != nil {
					c.Close()
				}
				done <- struct{}{}
			}
		}()
	}
	targets := []string{ln.Addr().String()}
	for _, p := range []int{22, 25, 53, 80, 111, 443, 2375, 2376, 3000, 4280, 5000, 6443, 8000, 8080, 8443, 9100, 10250} {
		targets = append(targets, net.JoinHostPort(gw, strconv.Itoa(p)))
	}
	for _, a := range []string{"10.0.0.1", "10.0.0.2", "10.128.0.1", "172.16.0.1", "172.17.0.1", "192.168.0.1", "100.64.0.1"} {
		for _, p := range []string{"22", "53", "80", "443"} {
			targets = append(targets, net.JoinHostPort(a, p))
		}
	}
	go func() {
		for _, t := range targets {
			jobs <- t
		}
		close(jobs)
	}()
	for range targets {
		<-done
		n++
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		out = append(out, "dir "+err.Error())
	} else {
		unix.Close(fd)
		out = append(out, "dir ok")
	}
	return strings.Join(out, "; ")
}
