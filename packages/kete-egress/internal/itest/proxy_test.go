//go:build integration && linux

package itest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// proxyOpts varies how a test launches the proxy.
type proxyOpts struct {
	limits      map[string]any
	noCertFile  bool // no SSL_CERT_FILE: the proxy has the (empty) system roots only
	asRoot      bool // no Credential: start-up must refuse
	listenPorts [3]int
	fd3UDP      bool // a UDP socket in place of port A's listener
	noAppendLog bool
	logOwner    uint32
	extraFD     bool // an fd 8
	noNNP       bool // start without no_new_privs
	groups      []uint32
	gid0        bool
	ctl         *os.File // fd 7 in place of the root-created socketpair end
	certFile    string   // SSL_CERT_FILE in place of the fake upstreams' CA
	certDir     string   // SSL_CERT_DIR, if set
}

type proxyProc struct {
	cmd     *exec.Cmd
	ctl     *os.File
	br      *bufio.Reader
	caPath  string
	logPath string
	stderr  *bytes.Buffer
	done    chan struct{}
	exitErr error
}

// launch starts kete-egress serve exactly per the fd contract (module README "File
// descriptors"): root binds the listeners, opens the root-owned log and a socketpair, and
// starts the proxy as the proxy uid with setgroups([]) and the config on stdin.
func launch(t *testing.T, o proxyOpts) *proxyProc {
	t.Helper()
	ports := o.listenPorts
	if ports == [3]int{} {
		ports = [3]int{portA, portB, portR}
	}
	var files []*os.File
	for i, p := range ports {
		var f *os.File
		if i == 0 && o.fd3UDP {
			pc, err := net.ListenPacket("udp4", fmt.Sprintf("127.0.0.1:%d", p))
			if err != nil {
				t.Fatal(err)
			}
			f, err = pc.(*net.UDPConn).File()
			if err != nil {
				t.Fatal(err)
			}
			_ = pc.Close()
		} else {
			ln, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", p))
			if err != nil {
				t.Fatalf("listen %d: %v", p, err)
			}
			f, err = ln.(*net.TCPListener).File()
			if err != nil {
				t.Fatal(err)
			}
			_ = ln.Close()
		}
		files = append(files, f)
	}
	logPath := filepath.Join(E.work, fmt.Sprintf("proxy-%d.jsonl", time.Now().UnixNano()))
	flags := os.O_WRONLY | os.O_APPEND | os.O_CREATE
	if o.noAppendLog {
		flags = os.O_WRONLY | os.O_CREATE
	}
	logF, err := os.OpenFile(logPath, flags, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if o.logOwner != 0 {
		if err := os.Chown(logPath, int(o.logOwner), 0); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = os.Remove(logPath) })
	files = append(files, logF)
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	ours := os.NewFile(uintptr(fds[0]), "ctl-root")
	theirs := os.NewFile(uintptr(fds[1]), "ctl-proxy")
	if o.ctl != nil {
		_ = theirs.Close()
		theirs = o.ctl
	}
	files = append(files, theirs)
	if o.extraFD {
		extra, err := os.Open("/dev/null")
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, extra)
	}

	cfgJSON, _ := json.Marshal(baseConfig(o.limits))
	// The entrypoint starts the proxy with no_new_privs; setpriv sets it here (Go's SysProcAttr
	// can't) and execs the binary, keeping the inherited fds.
	cmd := exec.Command("setpriv", "--no-new-privs", "--", E.bin, "serve", "--config", "-")
	if o.noNNP {
		cmd = exec.Command(E.bin, "serve", "--config", "-")
	}
	cmd.ExtraFiles = files
	cmd.Stdin = bytes.NewReader(cfgJSON)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	switch {
	case o.certFile != "":
		cmd.Env = append(cmd.Env, "SSL_CERT_FILE="+o.certFile)
	case !o.noCertFile:
		cmd.Env = append(cmd.Env, "SSL_CERT_FILE="+E.testCA)
	default:
		// An empty bundle: the proxy has no root that could verify the fake upstreams.
		cmd.Env = append(cmd.Env, "SSL_CERT_FILE=/dev/null", "SSL_CERT_DIR=/nonexistent")
	}
	if o.certDir != "" {
		cmd.Env = append(cmd.Env, "SSL_CERT_DIR="+o.certDir)
	}
	if !o.asRoot {
		cred := &syscall.Credential{Uid: E.proxyUID, Gid: E.proxyGID, Groups: []uint32{}}
		if o.groups != nil {
			cred.Groups = o.groups
		}
		if o.gid0 {
			cred.Gid = 0
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
	}
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		_ = f.Close()
	}
	pp := &proxyProc{cmd: cmd, ctl: ours, br: bufio.NewReader(ours), logPath: logPath, stderr: stderr, done: make(chan struct{})}
	go func() { pp.exitErr = cmd.Wait(); close(pp.done) }()
	t.Cleanup(func() {
		_ = ours.Close()
		select {
		case <-pp.done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-pp.done
		}
	})
	return pp
}

// start launches a proxy that must come up, and returns it after its "ready" line.
func startProxy(t *testing.T, o proxyOpts) *proxyProc {
	t.Helper()
	pp := launch(t, o)
	msg := pp.read(t)
	if msg["type"] != "ready" || msg["version"] != 1.0 {
		t.Fatalf("first control line %v; stderr=%s", msg, pp.stderr.String())
	}
	pem, _ := msg["ca_cert_pem"].(string)
	if !strings.Contains(pem, "BEGIN CERTIFICATE") {
		t.Fatalf("ready carries no CA")
	}
	pp.caPath = writePublic(t, fmt.Sprintf("proxy-ca-%d.pem", time.Now().UnixNano()), []byte(pem))
	return pp
}

func (pp *proxyProc) read(t *testing.T) map[string]any {
	t.Helper()
	_ = pp.ctl.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := pp.br.ReadString('\n')
	if err != nil {
		select {
		case <-pp.done:
		case <-time.After(2 * time.Second):
		}
		t.Fatalf("control read: %v; exit=%v; stderr=%s", err, pp.exitErr, pp.stderr.String())
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("control line %q: %v", line, err)
	}
	return m
}

func (pp *proxyProc) send(t *testing.T, line string) map[string]any {
	t.Helper()
	if _, err := pp.ctl.WriteString(line + "\n"); err != nil {
		t.Fatalf("control write: %v", err)
	}
	return pp.read(t)
}

func (pp *proxyProc) phase(t *testing.T, ph string) int {
	t.Helper()
	m := pp.send(t, `{"type":"phase","phase":"`+ph+`"}`)
	if m["type"] != "phase_ok" || m["phase"] != ph {
		t.Fatalf("phase %s: %v", ph, m)
	}
	return int(m["closed_connections"].(float64))
}

// stop closes the control channel and expects exit 0.
func (pp *proxyProc) stop(t *testing.T) {
	t.Helper()
	_ = pp.ctl.Close()
	select {
	case <-pp.done:
	case <-time.After(10 * time.Second):
		t.Fatal("proxy didn't exit after the control channel closed")
	}
	if pp.exitErr != nil {
		t.Fatalf("proxy exit: %v; stderr=%s", pp.exitErr, pp.stderr.String())
	}
}

// exitCode waits for a proxy that must refuse to start.
func (pp *proxyProc) exitCode(t *testing.T) int {
	t.Helper()
	select {
	case <-pp.done:
	case <-time.After(10 * time.Second):
		t.Fatal("proxy didn't exit")
	}
	var ee *exec.ExitError
	if errors.As(pp.exitErr, &ee) {
		return ee.ExitCode()
	}
	if pp.exitErr == nil {
		return 0
	}
	t.Fatalf("wait: %v", pp.exitErr)
	return -1
}

func (pp *proxyProc) logLines(t *testing.T) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(pp.logPath)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, ln := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if ln == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(ln), &m); err != nil {
			t.Fatalf("log line %q: %v", ln, err)
		}
		out = append(out, m)
	}
	return out
}

// hasReason polls the log: a line can be written just after the client saw its response.
func (pp *proxyProc) hasReason(t *testing.T, reason string) bool {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		for _, m := range pp.logLines(t) {
			if m["reason"] == reason {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
	}
}
