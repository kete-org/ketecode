package isolation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

var errRefused = errors.New("refused")

// fakeNet reaches exactly the targets in reach (per kind); hang targets block until the attempt's
// context ends.
type fakeNet struct {
	mu     sync.Mutex
	reach  map[string]bool
	hang   map[string]bool
	unsure map[string]bool
	flaky  map[string]int // attempts that time out before the target answers
	tries  atomic.Int64
}

func (f *fakeNet) try(ctx context.Context, kind Kind, target string) error {
	f.tries.Add(1)
	key := string(kind) + " " + target
	f.mu.Lock()
	if f.flaky[key] > 0 {
		f.flaky[key]--
		f.mu.Unlock()
		return context.DeadlineExceeded
	}
	f.mu.Unlock()
	if f.hang[key] {
		<-ctx.Done()
		return ctx.Err()
	}
	if f.unsure[key] {
		return fmt.Errorf("%w: emfile", ErrInconclusive)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reach[key] {
		return nil
	}
	return errRefused
}

func (f *fakeNet) DialTCP(ctx context.Context, a string) error     { return f.try(ctx, KindTCP, a) }
func (f *fakeNet) ExchangeDNS(ctx context.Context, a string) error { return f.try(ctx, KindDNS, a) }
func (f *fakeNet) DialUnix(ctx context.Context, p string) error    { return f.try(ctx, KindUnix, p) }
func (f *fakeNet) OpenDir(p string) error                          { return f.try(context.Background(), KindDir, p) }
func (f *fakeNet) OpenFile(p string) error                         { return f.try(context.Background(), KindFile, p) }

const (
	control     = "127.0.0.1:40000"
	unixControl = "@kete-isolation-control-test"
)

func inputs() Inputs {
	return Inputs{
		FlySockets:   []string{"/.fly/api"},
		HelperSocket: "/run/kete-helper/helper.sock",
		UnixSockets:  []string{"/run/kete-helper/helper.sock", "/.fly/api", "/run/other.sock", "@abstract"},
		KeteDirs:     []string{"/var/lib/kete-job/kete", "/var/lib/kete-job/kete/tmp"},
		Resolvers:    []string{"198.51.100.53:53", "[fdaa::3]:53"},
		LocalAddrs:   []netip.Addr{netip.MustParseAddr("172.19.0.2"), netip.MustParseAddr("fdaa:0:1:a7b:1::2")},
		PortTool:     82,
		Control:      control,
		UnixControl:  unixControl,
	}
}

func newNet(reach ...string) *fakeNet {
	f := &fakeNet{reach: map[string]bool{"tcp " + control: true, "unix " + unixControl: true, "dir /": true}, hang: map[string]bool{}}
	for _, r := range reach {
		f.reach[r] = true
	}
	return f
}

func TestCheckPasses(t *testing.T) {
	n := newNet()
	req := NewRequest(Build(inputs()))
	if got := Check(context.Background(), req, n); got != OK {
		t.Fatalf("Check = %q", got)
	}
	if int(n.tries.Load()) != len(req.Probes) {
		t.Errorf("tries %d, probes %d", n.tries.Load(), len(req.Probes))
	}
}

func TestCheckReasons(t *testing.T) {
	cases := map[string]phaselog.Code{
		"unix /.fly/api":                    phaselog.CodeFlyAPI,
		"unix /run/kete-helper/helper.sock": phaselog.CodeHelperSocket,
		"unix /run/other.sock":              phaselog.CodeUnixSocket,
		"unix @abstract":                    phaselog.CodeUnixSocket,
		"dir /var/lib/kete-job/kete":        phaselog.CodeKeteDir,
		"dir /var/lib/kete-job/kete/tmp":    phaselog.CodeKeteDir,
		"tcp 169.254.169.254:80":            phaselog.CodeMetadata,
		"tcp [fdaa::3]:4280":                phaselog.CodeSixPN,
		"tcp [fdaa:0:1:a7b:1::2]:22":        phaselog.CodeSixPN,
		"tcp [fdaa:0:1:a7b:1::2]:4280":      phaselog.CodeSixPN,
		"dns 198.51.100.53:53":              phaselog.CodeResolver,
		"tcp 198.51.100.53:53":              phaselog.CodeResolver,
		"dns [fdaa::3]:53":                  phaselog.CodeResolver,
		"tcp 127.0.0.1:1":                   phaselog.CodeLoopback,
		"tcp 127.0.0.1:1023":                phaselog.CodeLoopback,
		"tcp [::1]:22":                      phaselog.CodeLoopback,
	}
	for reach, want := range cases {
		if got := Check(context.Background(), NewRequest(Build(inputs())), newNet(reach)); got != want {
			t.Errorf("%s reachable: Check = %q, want %q", reach, got, want)
		}
	}
	// Port B and unprivileged loopback ports aren't probed; IPv4 non-6PN addresses aren't either.
	for _, reach := range []string{"tcp 127.0.0.1:82", "tcp [::1]:82", "tcp 127.0.0.1:1024", "tcp 172.19.0.2:22"} {
		if got := Check(context.Background(), NewRequest(Build(inputs())), newNet(reach)); got != OK {
			t.Errorf("%s reachable: Check = %q, want ok", reach, got)
		}
	}
}

func TestCheckPriority(t *testing.T) {
	n := newNet("tcp 127.0.0.1:22", "unix /.fly/api", "tcp 169.254.169.254:80")
	if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != phaselog.CodeFlyAPI {
		t.Errorf("Check = %q", got)
	}
}

func TestCheckControl(t *testing.T) {
	for _, c := range []string{"tcp " + control, "unix " + unixControl, "dir /"} {
		n := newNet()
		n.reach[c] = false
		if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != phaselog.CodeControl {
			t.Errorf("%s unreachable: Check = %q", c, got)
		}
	}
}

// A control that misses a dial timeout or two still counts (a slow guest right after boot); one
// that never answers fails, and other probes are never retried.
func TestCheckControlRetried(t *testing.T) {
	n := newNet()
	n.flaky = map[string]int{"tcp " + control: ControlAttempts - 1}
	if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != OK {
		t.Errorf("slow control: Check = %q", got)
	}
	n = newNet()
	n.flaky = map[string]int{"tcp " + control: ControlAttempts}
	if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != phaselog.CodeControl {
		t.Errorf("control never reached: Check = %q", got)
	}
	n = newNet("tcp 169.254.169.254:80")
	n.flaky = map[string]int{"tcp 169.254.169.254:80": 1}
	if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != OK {
		t.Errorf("a non-control probe was retried (and reached): Check = %q", got)
	}
}

// Resource errors are inconclusive, never a pass.
func TestCheckInconclusive(t *testing.T) {
	n := newNet()
	n.unsure = map[string]bool{"tcp 127.0.0.1:22": true}
	if got := Check(context.Background(), NewRequest(Build(inputs())), n); got != phaselog.CodeProbe {
		t.Errorf("Check = %q", got)
	}
}

// A dropped packet costs one dial timeout and still passes; attempts cut off by the overall
// deadline make the answer "probe" (never ok).
func TestCheckTimeouts(t *testing.T) {
	n := newNet()
	n.hang["tcp 169.254.169.254:80"] = true
	req := NewRequest(Build(inputs()))
	req.DialTimeout = 20
	start := time.Now()
	if got := Check(context.Background(), req, n); got != OK {
		t.Errorf("one dropped probe: Check = %q", got)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("took %v", time.Since(start))
	}

	n = newNet()
	for _, p := range Build(inputs()) {
		if p.Reason == phaselog.CodeLoopback {
			n.hang[string(p.Kind)+" "+p.Target] = true
		}
	}
	req = NewRequest(Build(inputs()))
	req.DialTimeout, req.Deadline, req.Workers = 50, 200, 4
	start = time.Now()
	if got := Check(context.Background(), req, n); got != phaselog.CodeProbe {
		t.Errorf("incomplete check: Check = %q", got)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("deadline not enforced: %v", time.Since(start))
	}
}

func TestBuild(t *testing.T) {
	ps := Build(inputs())
	if !ps[0].Control || ps[0].Target != control || !ps[1].Control || ps[1].Target != unixControl || !ps[2].Control || ps[2].Target != ControlDir {
		t.Errorf("first probes %+v", ps[:3])
	}
	seen := map[string]phaselog.Code{}
	for _, p := range ps {
		key := string(p.Kind) + " " + p.Target
		if _, dup := seen[key]; dup {
			t.Errorf("duplicate %s", key)
		}
		seen[key] = p.Reason
	}
	if seen["unix /.fly/api"] != phaselog.CodeFlyAPI || seen["unix /run/kete-helper/helper.sock"] != phaselog.CodeHelperSocket {
		t.Error("the first reason must win for Fly's and the helper's socket")
	}
	if seen["tcp [fdaa::3]:53"] != phaselog.CodeResolver || seen["dns [fdaa::3]:53"] != phaselog.CodeResolver {
		t.Error("Fly's resolver isn't probed")
	}
	if _, ok := seen["tcp 127.0.0.1:82"]; ok {
		t.Error("port B is probed")
	}
	if _, ok := seen["tcp 127.0.0.1:0"]; ok {
		t.Error("port 0 is probed")
	}
	if err := NewRequest(ps).Validate(); err != nil {
		t.Errorf("Validate: %v", err)
	}
	fly := FlyProbes(control, unixControl, []string{"/.fly/api"})
	if len(fly) != 4 || !fly[0].Control || !fly[2].Control || fly[3].Reason != phaselog.CodeFlyAPI {
		t.Errorf("FlyProbes = %+v", fly)
	}
}

func TestValidate(t *testing.T) {
	good := NewRequest(FlyProbes(control, "", []string{"/.fly/api"}))
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(*Request){
		"no probes":     func(r *Request) { r.Probes = nil },
		"no control":    func(r *Request) { r.Probes = r.Probes[2:] },
		"unknown kind":  func(r *Request) { r.Probes[2].Kind = "icmp" },
		"empty target":  func(r *Request) { r.Probes[2].Target = "" },
		"bad reason":    func(r *Request) { r.Probes[2].Reason = "free text" },
		"ok reason":     func(r *Request) { r.Probes[2].Reason = OK },
		"control flag":  func(r *Request) { r.Probes[0].Reason = phaselog.CodeLoopback },
		"control probe": func(r *Request) { r.Probes[2].Reason = phaselog.CodeControl },
		"no timeout":    func(r *Request) { r.DialTimeout = 0 },
		"no deadline":   func(r *Request) { r.Deadline = 0 },
		"no workers":    func(r *Request) { r.Workers = 0 },
	}
	for name, mod := range bad {
		r := NewRequest(FlyProbes(control, "", []string{"/.fly/api"}))
		mod(&r)
		if r.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
		if got := Check(context.Background(), r, newNet()); got != phaselog.CodeProbe {
			t.Errorf("%s: Check = %q", name, got)
		}
	}
}

func TestRequestRoundTrip(t *testing.T) {
	r := NewRequest(Build(inputs()))
	b, err := EncodeRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeRequest(bytes.NewReader(b))
	if err != nil || len(got.Probes) != len(r.Probes) {
		t.Fatalf("decode: %d probes, %v", len(got.Probes), err)
	}
	if _, err := DecodeRequest(strings.NewReader(`{"probes":[]}`)); err == nil {
		t.Error("empty request accepted")
	}
	if _, err := DecodeRequest(bytes.NewReader(bytes.Repeat([]byte(" "), maxRequest+2))); err == nil {
		t.Error("oversized request accepted")
	}
}

func TestParseAnswer(t *testing.T) {
	for in, want := range map[string]phaselog.Code{
		"ok\n": OK, "ok": OK, "fly_api\n": phaselog.CodeFlyAPI, "loopback": phaselog.CodeLoopback,
		"probe": phaselog.CodeProbe, "": phaselog.CodeProbe, "ok\nok\n": phaselog.CodeProbe,
		"garbage": phaselog.CodeProbe, "missing": phaselog.CodeProbe,
	} {
		if got := ParseAnswer([]byte(in)); got != want {
			t.Errorf("ParseAnswer(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseProcNetUnix(t *testing.T) {
	const content = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 12345 /run/kete-helper/helper.sock
0000000000000000: 00000002 00000000 00010000 0001 01 12346 @fly-abstract
0000000000000000: 00000002 00000000 00010000 0005 01 12347 /run/seq packet.sock
0000000000000000: 00000003 00000000 00000000 0001 03 12348 /run/kete-helper/helper.sock
0000000000000000: 00000002 00000000 00000000 0002 01 12349 /dev/log
0000000000000000: 00000002 00000000 00010000 0001 01 12350
0000000000000000: 00000002 00000000 00010000 0001 01 1 /.fly/api
`
	got, err := ParseProcNetUnix(strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/run/kete-helper/helper.sock", "@fly-abstract", "/run/seq packet.sock", "/.fly/api"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got %q, want %q", got, want)
	}
	if _, err := ParseProcNetUnix(strings.NewReader(strings.Repeat("x\n", 8<<20+1))); err == nil {
		t.Error("an over-limit /proc/net/unix was treated as complete")
	}
	if _, err := ParseProcNetUnix(strings.NewReader("Num\n0: 1 0 zz 0001 01 1 /x\n")); err == nil {
		t.Error("malformed line accepted")
	}
}

func TestFailure(t *testing.T) {
	var buf bytes.Buffer
	log := phaselog.New(&buf)
	LogFailure(log, phaselog.StepIsolation, &Failure{Reason: phaselog.CodeSixPN})
	LogFailure(log, phaselog.StepIsolation, &Failure{Reason: phaselog.CodeProbe, Err: context.DeadlineExceeded})
	LogFailure(log, phaselog.StepIsolation, errors.New("text never logged"))
	out := buf.String()
	for _, want := range []string{`"code":"sixpn"}`, `"code":"probe","class":"timeout"}`, `"code":"probe","class":"other"}`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
	if strings.Contains(out, "text never logged") {
		t.Error("error text logged")
	}
}
