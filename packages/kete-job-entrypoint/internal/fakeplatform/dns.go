package fakeplatform

import (
	"encoding/binary"
	"io"
	"net"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// answer resolves every *.kete.test A query to the fake's address; AAAA gets an empty answer;
// anything else goes to Config.Forward when set (the e2e's real registries), else NXDOMAIN.
func (s *Server) answer(req []byte, tcp bool) ([]byte, error) {
	var p dnsmessage.Parser
	h, err := p.Start(req)
	if err != nil {
		return nil, err
	}
	q, err := p.Question()
	if err != nil {
		return nil, err
	}
	name := strings.TrimSuffix(q.Name.String(), ".")
	s.mu.Lock()
	s.dnsSeen = append(s.dnsSeen, name)
	s.mu.Unlock()
	known := strings.HasSuffix(name, ".kete.test")
	if !known && s.cfg.Forward != "" {
		return forward(s.cfg.Forward, req, tcp)
	}
	rcode := dnsmessage.RCodeSuccess
	if !known {
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
	if known && q.Type == dnsmessage.TypeA {
		ip := net.ParseIP(s.cfg.Addr).To4()
		if err := b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}, dnsmessage.AResource{A: [4]byte(ip)}); err != nil {
			return nil, err
		}
	}
	return b.Finish()
}

func (s *Server) startDNS() error {
	pc, err := net.ListenPacket("udp", s.cfg.DNSAddr)
	if err != nil {
		return err
	}
	s.closers = append(s.closers, pc)
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			q := append([]byte(nil), buf[:n]...)
			go func() { // a forwarded query may take a while; never block the others
				if resp, err := s.answer(q, false); err == nil {
					_, _ = pc.WriteTo(resp, from)
				}
			}()
		}
	}()
	ln, err := net.Listen("tcp", s.cfg.DNSAddr)
	if err != nil {
		return err
	}
	s.closers = append(s.closers, ln)
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
					resp, err := s.answer(msg, true)
					if err != nil {
						return
					}
					if _, err := c.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(resp))), resp...)); err != nil {
						return
					}
				}
			}()
		}
	}()
	return nil
}

// forward relays one query to a real resolver over the same transport and returns its answer
// verbatim (the query's ID is kept).
func forward(addr string, req []byte, tcp bool) ([]byte, error) {
	network := "udp"
	if tcp {
		network = "tcp"
	}
	c, err := net.DialTimeout(network, addr, 3*time.Second)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if !tcp {
		if _, err := c.Write(req); err != nil {
			return nil, err
		}
		buf := make([]byte, 65535)
		n, err := c.Read(buf)
		if err != nil {
			return nil, err
		}
		return buf[:n], nil
	}
	if _, err := c.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(req))), req...)); err != nil {
		return nil, err
	}
	var l [2]byte
	if _, err := io.ReadFull(c, l[:]); err != nil {
		return nil, err
	}
	msg := make([]byte, binary.BigEndian.Uint16(l[:]))
	if _, err := io.ReadFull(c, msg); err != nil {
		return nil, err
	}
	return msg, nil
}
