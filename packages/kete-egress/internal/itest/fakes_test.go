//go:build integration && linux

package itest

import (
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
)

// The fake internet lives on documentation addresses scripts/integration.sh puts on a dummy
// interface inside the test's own network namespace; the bait addresses are in blocked ranges.
const (
	portA   = 81
	portB   = 82
	portR   = 83
	dnsAddr = "198.51.100.53:53"
	// Fly's resolver address (inside the blocked fdaa::/16): the firewall's DNS exception must
	// come before the blocked ranges for the proxy to reach it.
	dnsAddrV6 = "[fdaa::3]:53"

	upMain  = "198.51.100.10"
	upFront = "198.51.100.11"
	upV6    = "2001:db8::10"
	ownPort = 18080
)

var baitAddrs = []string{"169.254.169.254", "10.9.9.9", "fdaa::3"}

var upstreamNames = []string{"gateway.test", "platform.test", "storage.test", "github.test", "registry.npm.test", "front.test", "evil.test", "v6only.test", "internal.test"}

// dnsA / dnsAAAA are the fake DNS server's records.
var dnsA = map[string]string{
	"gateway.test": upMain, "platform.test": upMain, "storage.test": upMain, "github.test": upMain,
	"registry.npm.test": upMain, "front.test": upFront, "evil.test": upFront, "internal.test": "10.9.9.9",
}
var dnsAAAA = map[string]string{"v6only.test": upV6}

type echo struct {
	SNI     string `json:"sni"`
	Host    string `json:"host"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	BodyLen int    `json:"body_len"`
}

type world struct {
	caPEM    []byte
	mu       sync.Mutex
	seen     []string // Host of every upstream request
	baitHits atomic.Int64
	closers  []io.Closer
}

func (w *world) sawHost(h string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return contains(w.seen, h)
}

func (w *world) close() {
	for _, c := range w.closers {
		_ = c.Close()
	}
}

func startWorld() (*world, error) {
	w := &world{}
	testCA, err := ca.NewNamed("Test upstream CA", upstreamNames, time.Now())
	if err != nil {
		return nil, err
	}
	w.caPEM = testCA.CertPEM()
	E.testCA = filepath.Join(E.work, "test-ca.pem")
	if err := os.WriteFile(E.testCA, w.caPEM, 0o644); err != nil {
		return nil, err
	}

	handler := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.mu.Lock()
		w.seen = append(w.seen, r.Host)
		w.mu.Unlock()
		_ = json.NewEncoder(rw).Encode(echo{SNI: r.TLS.ServerName, Host: r.Host, Method: r.Method, Path: r.RequestURI, BodyLen: len(body)})
	})
	tlsCfg := &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		return testCA.Leaf(h.ServerName)
	}}
	for _, addr := range []string{upMain, upFront, upV6} {
		ln, err := net.Listen("tcp", net.JoinHostPort(addr, "443"))
		if err != nil {
			return nil, err
		}
		srv := &http.Server{Handler: handler, TLSConfig: tlsCfg, ErrorLog: log.New(io.Discard, "", 0)}
		go func() { _ = srv.ServeTLS(ln, "", "") }()
		w.closers = append(w.closers, srv)
	}

	// Bait: anything reaching these is a failure.
	for _, addr := range baitAddrs {
		ln, err := net.Listen("tcp", net.JoinHostPort(addr, "443"))
		if err != nil {
			return nil, err
		}
		w.closers = append(w.closers, ln)
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				w.baitHits.Add(1)
				_ = c.Close()
			}
		}()
	}

	// Loopback listeners standing in for the tool user's own test servers.
	for _, addr := range []string{"127.0.0.1", "::1"} {
		ln, err := net.Listen("tcp", net.JoinHostPort(addr, "18080"))
		if err != nil {
			return nil, err
		}
		w.closers = append(w.closers, ln)
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
			}
		}()
	}

	if err := w.startDNS(); err != nil {
		return nil, err
	}
	return w, nil
}

// answer builds the fake DNS server's reply to one query message.
func answer(req []byte) ([]byte, error) {
	var p dnsmessage.Parser
	h, err := p.Start(req)
	if err != nil {
		return nil, err
	}
	q, err := p.Question()
	if err != nil {
		return nil, err
	}
	name := q.Name.String()
	if len(name) > 0 && name[len(name)-1] == '.' {
		name = name[:len(name)-1]
	}
	_, knownA := dnsA[name]
	_, known6 := dnsAAAA[name]
	rcode := dnsmessage.RCodeSuccess
	if !knownA && !known6 {
		rcode = dnsmessage.RCodeNameError
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true, RecursionDesired: h.RecursionDesired, RecursionAvailable: true, RCode: rcode})
	b.EnableCompression()
	if err := b.StartQuestions(); err != nil {
		return nil, err
	}
	if err := b.Question(q); err != nil {
		return nil, err
	}
	if err := b.StartAnswers(); err != nil {
		return nil, err
	}
	rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}
	switch q.Type {
	case dnsmessage.TypeA:
		if a, ok := dnsA[name]; ok {
			ip := net.ParseIP(a).To4()
			if err := b.AResource(rh, dnsmessage.AResource{A: [4]byte(ip)}); err != nil {
				return nil, err
			}
		}
	case dnsmessage.TypeAAAA:
		if a, ok := dnsAAAA[name]; ok {
			ip := net.ParseIP(a).To16()
			if err := b.AAAAResource(rh, dnsmessage.AAAAResource{AAAA: [16]byte(ip)}); err != nil {
				return nil, err
			}
		}
	}
	return b.Finish()
}

func (w *world) startDNS() error {
	for _, addr := range []string{dnsAddr, dnsAddrV6} {
		if err := w.startDNSOn(addr); err != nil {
			return err
		}
	}
	return nil
}

func (w *world) startDNSOn(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	w.closers = append(w.closers, pc)
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if resp, err := answer(buf[:n]); err == nil {
				_, _ = pc.WriteTo(resp, from)
			}
		}
	}()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	w.closers = append(w.closers, ln)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				for {
					var l [2]byte
					if _, err := io.ReadFull(c, l[:]); err != nil {
						return
					}
					msg := make([]byte, binary.BigEndian.Uint16(l[:]))
					if _, err := io.ReadFull(c, msg); err != nil {
						return
					}
					resp, err := answer(msg)
					if err != nil {
						return
					}
					out := binary.BigEndian.AppendUint16(nil, uint16(len(resp)))
					if _, err := c.Write(append(out, resp...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return nil
}

// dnsQuery sends one A query for name over network ("udp" or "tcp") to addr and reports whether
// an answer came back.
func dnsQuery(network, addr, name string) error {
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: 4242, RecursionDesired: true})
	_ = b.StartQuestions()
	_ = b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name + "."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET})
	msg, _ := b.Finish()
	c, err := net.DialTimeout(network, addr, 3*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	if network == "tcp" {
		msg = append(binary.BigEndian.AppendUint16(nil, uint16(len(msg))), msg...)
	}
	if _, err := c.Write(msg); err != nil {
		return err
	}
	buf := make([]byte, 1500)
	n, err := c.Read(buf)
	if err != nil {
		return err
	}
	if n < 12 {
		return errors.New("short DNS answer")
	}
	return nil
}
