//go:build integration && linux

package itest

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// clientReq is one scenario a re-executed client runs as its uid.
type clientReq struct {
	Kind string `json:"kind"` // curl | http | raw | dial | dns | open

	// curl / http
	Port    int               `json:"port"`
	CA      string            `json:"ca"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Body    string            `json:"body"`
	Headers map[string]string `json:"headers"`

	// raw: CONNECT Authority (with an optional Host header), then TLS with SNI ("-" for none),
	// then each request in turn on the same connection. Before request i (i ≥ 1) it creates
	// SignalFile and waits for WaitFile, if set.
	Authority  string   `json:"authority"`
	ConnectHdr string   `json:"connect_hdr"`
	SNI        string   `json:"sni"`
	Requests   []string `json:"requests"`
	SignalFile string   `json:"signal_file"`
	WaitFile   string   `json:"wait_file"`

	// dial / dns / open
	Network string `json:"network"`
	Addr    string `json:"addr"`
	Path    string `json:"path"`
}

type clientRes struct {
	Status        int    `json:"status"`
	Body          string `json:"body"`
	ConnectStatus int    `json:"connect_status"`
	TLSErr        string `json:"tls_err"`
	Statuses      []int  `json:"statuses"`
	Err           string `json:"err"`
	Errno         string `json:"errno"`
	UID           int    `json:"uid"`
	ElapsedMS     int64  `json:"elapsed_ms"` // dial / dns: time to success or failure
}

func init() {
	raw := os.Getenv("EGRESS_IT_CLIENT")
	if raw == "" {
		return
	}
	var req clientReq
	if err := json.Unmarshal([]byte(raw), &req); err != nil {
		fmt.Fprintln(os.Stderr, "parse client request:", err)
		os.Exit(3)
	}
	res := runClient(req)
	res.UID = os.Getuid()
	_ = json.NewEncoder(os.Stdout).Encode(res)
	os.Exit(0)
}

func setErr(res *clientRes, err error) {
	res.Err = err.Error()
	var errno syscall.Errno
	if errors.As(err, &errno) {
		res.Errno = unix.ErrnoName(errno)
	}
}

func proxyURL(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

func runClient(req clientReq) clientRes {
	var res clientRes
	switch req.Kind {
	case "curl":
		args := []string{"-q", "-sS", "--max-time", "10", "--proxy", proxyURL(req.Port), "--cacert", req.CA, "-X", req.Method, "-o", "-", "-w", "\n%{http_code}"}
		if req.Body != "" {
			args = append(args, "--data-binary", req.Body)
		}
		for k, v := range req.Headers {
			args = append(args, "-H", k+": "+v)
		}
		args = append(args, req.URL)
		cmd := exec.Command("curl", args...)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent"}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		s := string(out)
		if i := strings.LastIndexByte(s, '\n'); i >= 0 {
			res.Status, _ = strconv.Atoi(s[i+1:])
			res.Body = s[:i]
		}
		if err != nil {
			res.Err = fmt.Sprintf("%v: %s", err, stderr.String())
		}
	case "http":
		pem, err := os.ReadFile(req.CA)
		if err != nil {
			setErr(&res, err)
			return res
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pem)
		pu, _ := url.Parse(proxyURL(req.Port))
		cl := &http.Client{
			Transport:     &http.Transport{Proxy: http.ProxyURL(pu), TLSClientConfig: &tls.Config{RootCAs: pool}},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			Timeout:       10 * time.Second,
		}
		hr, err := http.NewRequest(req.Method, req.URL, strings.NewReader(req.Body))
		if err != nil {
			setErr(&res, err)
			return res
		}
		for k, v := range req.Headers {
			hr.Header.Set(k, v)
		}
		resp, err := cl.Do(hr)
		if err != nil {
			setErr(&res, err)
			return res
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		res.Status, res.Body = resp.StatusCode, string(b)
	case "raw":
		runRaw(req, &res)
	case "dial":
		t0 := time.Now()
		c, err := net.DialTimeout(req.Network, req.Addr, 3*time.Second)
		res.ElapsedMS = time.Since(t0).Milliseconds()
		if err != nil {
			setErr(&res, err)
			return res
		}
		_ = c.Close()
	case "dns":
		t0 := time.Now()
		err := dnsQuery(req.Network, req.Addr, "gateway.test")
		res.ElapsedMS = time.Since(t0).Milliseconds()
		if err != nil {
			setErr(&res, err)
		}
	case "unixlisten":
		// Listen on Path, accept one connection, hold it until the peer closes it.
		ln, err := net.Listen("unix", req.Path)
		if err != nil {
			setErr(&res, err)
			return res
		}
		_ = os.Chmod(req.Path, 0o777)
		c, err := ln.Accept()
		if err != nil {
			setErr(&res, err)
			return res
		}
		_ = c.SetDeadline(time.Now().Add(10 * time.Second))
		_, _ = io.Copy(io.Discard, c)
		_ = c.Close()
		_ = ln.Close()
	case "open":
		f, err := os.Open(req.Path)
		if err != nil {
			setErr(&res, err)
			return res
		}
		_ = f.Close()
	default:
		res.Err = "unknown kind " + req.Kind
	}
	return res
}

func runRaw(req clientReq, res *clientRes) {
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(req.Port), 3*time.Second)
	if err != nil {
		setErr(res, err)
		return
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	head := "CONNECT " + req.Authority + " HTTP/1.1\r\n" + req.ConnectHdr + "\r\n"
	if _, err := io.WriteString(c, head); err != nil {
		setErr(res, err)
		return
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		res.ConnectStatus = -1
		setErr(res, err)
		return
	}
	res.ConnectStatus = resp.StatusCode
	if resp.StatusCode != 200 || req.SNI == "" {
		return
	}
	pem, _ := os.ReadFile(req.CA)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	cfg := &tls.Config{RootCAs: pool, ServerName: req.SNI, NextProtos: []string{"http/1.1"}}
	if req.SNI == "-" {
		cfg.ServerName, cfg.InsecureSkipVerify = "", true
	}
	tc := tls.Client(&bufConn{Conn: c, r: br}, cfg)
	if err := tc.Handshake(); err != nil {
		res.TLSErr = err.Error()
		return
	}
	tbr := bufio.NewReader(tc)
	for i, r := range req.Requests {
		if i > 0 && req.SignalFile != "" {
			_ = os.WriteFile(req.SignalFile, nil, 0o644)
			for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
				if _, err := os.Stat(req.WaitFile); err == nil {
					break
				}
			}
		}
		if _, err := io.WriteString(tc, r); err != nil {
			setErr(res, err)
			return
		}
		resp, err := http.ReadResponse(tbr, nil)
		if err != nil {
			setErr(res, err)
			return
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		res.Statuses = append(res.Statuses, resp.StatusCode)
		res.Body = string(b)
	}
}

type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }

// users
type user struct {
	name     string
	uid, gid uint32
}

func kete() user  { return user{"kete", E.keteUID, E.keteGID} }
func tool() user  { return user{"tool", E.toolUID, E.toolGID} }
func root() user  { return user{"root", 0, 0} }
func proxy() user { return user{"proxy", E.proxyUID, E.proxyGID} }
func other() user { return user{"other", E.otherUID, E.otherGID} }

// start re-executes this binary as u to run req, without waiting.
func start(t *testing.T, u user, req clientReq) (wait func() clientRes) {
	t.Helper()
	body, _ := json.Marshal(req)
	cmd := exec.Command(E.self)
	cmd.Env = []string{"EGRESS_IT_CLIENT=" + string(body), "PATH=/usr/bin:/bin"}
	cmd.Dir = E.work
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: u.uid, Gid: u.gid, Groups: []uint32{}}}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start client as %s: %v", u.name, err)
	}
	return func() clientRes {
		if err := cmd.Wait(); err != nil {
			t.Fatalf("client as %s: %v; stderr=%s", u.name, err, stderr.String())
		}
		var res clientRes
		if err := json.Unmarshal(stdout.Bytes(), &res); err != nil {
			t.Fatalf("client as %s: bad result %q: %v", u.name, stdout.String(), err)
		}
		if res.UID != int(u.uid) {
			t.Fatalf("client ran as uid %d, want %d", res.UID, u.uid)
		}
		return res
	}
}

func run(t *testing.T, u user, req clientReq) clientRes {
	t.Helper()
	return start(t, u, req)()
}
