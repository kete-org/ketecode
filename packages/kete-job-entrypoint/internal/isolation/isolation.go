// Package isolation is the in-VM isolation self-check (module README "Isolation check"): before
// claim, the entrypoint launches a short probe as the tool user (the identity every tool process
// has) that tries to reach what a tool must never reach: Fly's machine API socket, the helper's
// socket, any other listening unix socket, kete's directories, the metadata address, Fly's
// private network (fdaa::/16), the DNS resolvers and the privileged loopback ports other than
// port B. Anything reachable aborts the job before claim with a fixed reason (fail closed), as
// does a probe that doesn't run, finish or answer.
//
// The probe is a sample, not a proof: the structural guarantees are the nft ruleset (checked when
// applied), the file modes and the Fly guard. It catches a guard that silently didn't take effect
// on the real machine, a socket in an unexpected place, and a regression.
package isolation

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// ProbeArg is argv[1] of the probe (the entrypoint binary re-executed as the tool user).
const ProbeArg = "__isolation_probe"

// Kind is what a probe tries.
type Kind string

const (
	KindTCP  Kind = "tcp"  // connect to host:port
	KindDNS  Kind = "dns"  // send a DNS query over UDP to host:port and wait for any reply
	KindUnix Kind = "unix" // connect to a unix socket path ("@name" for the abstract namespace)
	KindDir  Kind = "dir"  // open a directory for reading
	KindFile Kind = "file" // open a file (a device node included) for reading, without following a symlink
)

// Probe is one attempt. It passes when the attempt fails (nothing reached), except a Control
// probe, which must succeed: it proves the probe can make connections at all, so a broken probe
// can't pass everything by accident.
type Probe struct {
	Kind    Kind          `json:"kind"`
	Target  string        `json:"target"`
	Reason  phaselog.Code `json:"reason"`
	Control bool          `json:"control,omitempty"`
}

// Request is what the entrypoint sends the probe (on fd 3).
type Request struct {
	Probes      []Probe `json:"probes"`
	DialTimeout int64   `json:"dial_timeout_ms"`
	Deadline    int64   `json:"deadline_ms"` // the probe's own budget for all attempts
	Workers     int     `json:"workers"`
}

// Defaults: every refusal on the job machine is an nft reject (instant); a dropped packet costs
// one DialTimeout, and Workers attempts run at once.
const (
	DefaultDialTimeout = 300 * time.Millisecond
	DefaultDeadline    = 10 * time.Second
	DefaultWorkers     = 64
	// ControlAttempts is how often Check tries a control probe before counting it unreached.
	ControlAttempts = 3
	maxRequest      = 1 << 20
	maxProbes       = 20000
)

// Priority orders the reasons: the one reported when several probes fail. Control comes first
// (when it fails, nothing else the probe says means anything).
var Priority = []phaselog.Code{
	phaselog.CodeControl, phaselog.CodeFlyAPI, phaselog.CodeHelperSocket, phaselog.CodeUnixSocket,
	phaselog.CodeKeteDir, phaselog.CodeGuardedPath, phaselog.CodeMetadata, phaselog.CodeSixPN,
	phaselog.CodeGateway, phaselog.CodePrivateRange, phaselog.CodeIPv6, phaselog.CodeResolver,
	phaselog.CodeLoopback,
}

func knownReason(c phaselog.Code) bool {
	for _, r := range Priority {
		if r == c {
			return true
		}
	}
	return false
}

// OK is the probe's answer when every probe passed.
const OK phaselog.Code = "ok"

// Failure is a failed check: the fixed reason, never a target or a message. Err is set only when
// the probe itself couldn't run (Reason CodeProbe): its class and errno reach the phase line.
type Failure struct {
	Reason phaselog.Code
	Err    error
}

func (f *Failure) Error() string {
	if f.Err != nil {
		return "isolation check failed: " + string(f.Reason) + ": " + f.Err.Error()
	}
	return "isolation check failed: " + string(f.Reason)
}

func (f *Failure) Unwrap() error { return f.Err }

// ErrInconclusive marks an attempt that neither reached nor was refused by its target (the probe
// ran out of descriptors, buffers or memory): the answer is then CodeProbe, never a pass.
var ErrInconclusive = errors.New("isolation: attempt inconclusive")

// Net is what the probe does; each method returns nil when it reached the target, an error
// wrapping ErrInconclusive when it couldn't tell, any other error when it was refused.
type Net interface {
	DialTCP(ctx context.Context, addr string) error
	ExchangeDNS(ctx context.Context, addr string) error
	DialUnix(ctx context.Context, path string) error
	OpenDir(path string) error
	OpenFile(path string) error
}

// Validate checks a request before it runs (the probe trusts nothing it's sent).
func (r Request) Validate() error {
	if len(r.Probes) == 0 || len(r.Probes) > maxProbes {
		return errors.New("isolation: probe count out of range")
	}
	if r.DialTimeout <= 0 || r.Deadline <= 0 || r.Workers <= 0 || r.Workers > 1024 {
		return errors.New("isolation: bad timing")
	}
	controls := 0
	for _, p := range r.Probes {
		switch p.Kind {
		case KindTCP, KindDNS, KindUnix, KindDir, KindFile:
		default:
			return fmt.Errorf("isolation: unknown kind %q", p.Kind)
		}
		if p.Target == "" {
			return errors.New("isolation: empty target")
		}
		if p.Control {
			if p.Reason != phaselog.CodeControl {
				return errors.New("isolation: a control probe must carry the control reason")
			}
			controls++
		} else if !knownReason(p.Reason) || p.Reason == phaselog.CodeControl {
			return fmt.Errorf("isolation: bad reason %q", p.Reason)
		}
	}
	if controls == 0 {
		return errors.New("isolation: no control probe")
	}
	return nil
}

// Check runs every probe (Workers at a time, each attempt bounded by DialTimeout, all of them by
// Deadline) and returns OK or the highest-priority failing reason. Attempts not finished by the
// deadline make the answer CodeProbe: an incomplete check never passes.
func Check(ctx context.Context, req Request, n Net) phaselog.Code {
	if err := req.Validate(); err != nil {
		return phaselog.CodeProbe
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.Deadline)*time.Millisecond)
	defer cancel()
	dial := time.Duration(req.DialTimeout) * time.Millisecond

	failed := make([]bool, len(req.Probes))
	done := make([]bool, len(req.Probes))
	unsure := make([]bool, len(req.Probes))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < req.Workers && w < len(req.Probes); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				p := req.Probes[i]
				actx, acancel := context.WithTimeout(ctx, dial)
				err := attempt(actx, n, p)
				acancel()
				// A control must be reached; a slow machine (a busy or nested-virtualized guest
				// right after boot) can miss one dial timeout, so a control gets ControlAttempts.
				// Only controls are retried: any probe that reaches a forbidden target fails at once.
				for try := 1; p.Control && err != nil && !errors.Is(err, ErrInconclusive) && try < ControlAttempts && ctx.Err() == nil; try++ {
					actx, acancel = context.WithTimeout(ctx, dial)
					err = attempt(actx, n, p)
					acancel()
				}
				reached := err == nil
				if ctx.Err() != nil && !reached {
					continue // cut short by the overall deadline: not done
				}
				unsure[i] = errors.Is(err, ErrInconclusive)
				failed[i] = reached != p.Control
				done[i] = true
			}
		}()
	}
feed:
	for i := range req.Probes {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()

	reasons := map[phaselog.Code]bool{}
	for i, p := range req.Probes {
		if !done[i] || unsure[i] {
			return phaselog.CodeProbe
		}
		if failed[i] {
			reasons[p.Reason] = true
		}
	}
	for _, r := range Priority {
		if reasons[r] {
			return r
		}
	}
	return OK
}

func attempt(ctx context.Context, n Net, p Probe) error {
	switch p.Kind {
	case KindTCP:
		return n.DialTCP(ctx, p.Target)
	case KindDNS:
		return n.ExchangeDNS(ctx, p.Target)
	case KindUnix:
		return n.DialUnix(ctx, p.Target)
	case KindDir:
		return n.OpenDir(p.Target)
	case KindFile:
		return n.OpenFile(p.Target)
	}
	return errors.New("unknown kind")
}

// Inputs are what the entrypoint knows when it builds the probes.
type Inputs struct {
	FlySockets   []string     // Fly's API socket paths (/.fly/api)
	HelperSocket string       // the helper's socket
	UnixSockets  []string     // every listening unix socket in the netns (ParseProcNetUnix)
	KeteDirs     []string     // kete's home and TMPDIR (its server socket's parent)
	Resolvers    []string     // resolv.conf's nameservers, "ip:53" / "[ipv6]:53"
	LocalAddrs   []netip.Addr // the machine's own addresses (the 6PN ones are probed)
	PortTool     int          // port B: the only privileged loopback port the tool user reaches
	Control      string       // a root-owned listener on an unprivileged loopback port
	UnixControl  string       // a root-owned abstract unix listener ("@name") anyone may connect to
	// OffFly is set for every host profile but fly (module README "Host profiles"): Fly's resolver
	// ([fdaa::3]) and private network (fdaa::/16) are then not probed. The zero value is fly's list.
	OffFly bool
	// Extra are the host profile's own targets (hostprofile.IsolationTargets): gateway, private
	// and IPv6 samples, extra metadata addresses and guarded paths. Fly has none.
	Extra []Probe
}

// ControlDir is the directory control: the tool user must be able to open "/" for reading, or the
// dir probes prove nothing.
const ControlDir = "/"

// NewRequest is a request for probes with the default timings.
func NewRequest(probes []Probe) Request {
	return Request{
		Probes: probes, DialTimeout: DefaultDialTimeout.Milliseconds(),
		Deadline: DefaultDeadline.Milliseconds(), Workers: DefaultWorkers,
	}
}

// FlyProbes are the Fly guard's own check (step setup_fly, right after locking): the control and
// Fly's API sockets only.
func FlyProbes(control, unixControl string, sockets []string) []Probe {
	out := Controls(control, unixControl)
	for _, s := range sockets {
		out = append(out, Probe{Kind: KindUnix, Target: s, Reason: phaselog.CodeFlyAPI})
	}
	return out
}

// Controls are the positive controls, one per way of probing that the inputs use: a TCP connect,
// a unix connect, and opening ControlDir. Each must succeed, or the answer is CodeControl. (The DNS
// probe has no control: a resolver that never answers looks the same as a refusal.)
func Controls(tcp, unix string) []Probe {
	var out []Probe
	if tcp != "" {
		out = append(out, Probe{Kind: KindTCP, Target: tcp, Reason: phaselog.CodeControl, Control: true})
	}
	if unix != "" {
		out = append(out, Probe{Kind: KindUnix, Target: unix, Reason: phaselog.CodeControl, Control: true})
	}
	return append(out, Probe{Kind: KindDir, Target: ControlDir, Reason: phaselog.CodeControl, Control: true})
}

// LogFailure writes the failed phase line for a check's error: the fixed reason, plus the class
// and number of a probe that couldn't run (never any text).
func LogFailure(log *phaselog.Logger, s phaselog.Step, err error) {
	var f *Failure
	switch {
	case errors.As(err, &f) && f.Err == nil:
		log.Fail(s, f.Reason)
	case errors.As(err, &f):
		log.FailErr(s, f.Reason, f.Err)
	default:
		log.FailErr(s, phaselog.CodeProbe, err)
	}
}

// Fixed targets.
var (
	MetadataAddrs = []string{"169.254.169.254:80", "169.254.169.254:443"}
	// FlyResolver is Fly's internal DNS server (also its 6PN gateway for _api.internal and
	// .internal names).
	FlyResolver = "[fdaa::3]:53"
	// SixPNSamples are fixed Fly private-network addresses and ports a tool must not reach: the
	// resolver's other ports and the Machines API port (4280) on it. Fly's private network is
	// fdaa::/16; the machine's own 6PN addresses are probed too (Inputs.LocalAddrs).
	SixPNSamples = []string{"[fdaa::3]:80", "[fdaa::3]:443", "[fdaa::3]:4280"}
	sixPN        = netip.MustParsePrefix("fdaa::/16")
)

// Build turns the inputs into the probe list, the control first and each target once (the first
// reason wins: Fly's socket and the helper's are also in the unix-socket list).
func Build(in Inputs) []Probe {
	var out []Probe
	seen := map[string]bool{}
	add := func(k Kind, target string, r phaselog.Code) {
		key := string(k) + " " + target
		if target == "" || seen[key] {
			return
		}
		seen[key] = true
		out = append(out, Probe{Kind: k, Target: target, Reason: r})
	}
	out = append(out, Controls(in.Control, in.UnixControl)...)
	for _, c := range out {
		seen[string(c.Kind)+" "+c.Target] = true
	}
	for _, s := range in.FlySockets {
		add(KindUnix, s, phaselog.CodeFlyAPI)
	}
	add(KindUnix, in.HelperSocket, phaselog.CodeHelperSocket)
	for _, s := range in.UnixSockets {
		add(KindUnix, s, phaselog.CodeUnixSocket)
	}
	for _, d := range in.KeteDirs {
		add(KindDir, d, phaselog.CodeKeteDir)
	}
	for _, a := range MetadataAddrs {
		add(KindTCP, a, phaselog.CodeMetadata)
	}
	for _, p := range in.Extra {
		add(p.Kind, p.Target, p.Reason)
	}
	resolvers := append([]string{}, in.Resolvers...)
	if !in.OffFly {
		resolvers = append(resolvers, FlyResolver)
	}
	for _, r := range resolvers {
		add(KindTCP, r, phaselog.CodeResolver)
		add(KindDNS, r, phaselog.CodeResolver)
	}
	if !in.OffFly {
		for _, a := range SixPNSamples {
			add(KindTCP, a, phaselog.CodeSixPN)
		}
	}
	for _, a := range in.LocalAddrs {
		if in.OffFly {
			break
		}
		a = a.Unmap()
		if !sixPN.Contains(a) {
			continue
		}
		for port := 1; port <= 1023; port++ {
			add(KindTCP, netip.AddrPortFrom(a, uint16(port)).String(), phaselog.CodeSixPN)
		}
		add(KindTCP, netip.AddrPortFrom(a, 4280).String(), phaselog.CodeSixPN)
	}
	for _, lo := range []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.IPv6Loopback()} {
		for port := 1; port <= 1023; port++ {
			if port == in.PortTool {
				continue
			}
			add(KindTCP, netip.AddrPortFrom(lo, uint16(port)).String(), phaselog.CodeLoopback)
		}
	}
	return out
}

// ParseProcNetUnix returns the listening unix sockets (SOCK_STREAM or SOCK_SEQPACKET with
// __SO_ACCEPTCON) that have a name in /proc/net/unix content: a path, or "@name" for the
// abstract namespace (whose name the kernel prints with each NUL as '@', so a name holding a NUL
// can't be reproduced; connecting to the misspelt name then fails and that socket goes unprobed).
func ParseProcNetUnix(r io.Reader) ([]string, error) {
	const acceptCon = 0x10000
	const limit = 16 << 20
	lr := &io.LimitedReader{R: r, N: limit + 1}
	sc := bufio.NewScanner(lr)
	sc.Buffer(make([]byte, 64<<10), 64<<10)
	var out []string
	first := true
	for sc.Scan() {
		line := sc.Text()
		if first {
			first = false
			if strings.HasPrefix(line, "Num") {
				continue
			}
		}
		// Num RefCount Protocol Flags Type St Inode Path
		f := strings.Fields(line)
		if len(f) < 8 {
			continue
		}
		flags, err1 := strconv.ParseUint(f[3], 16, 32)
		typ, err2 := strconv.ParseUint(f[4], 16, 16)
		if err1 != nil || err2 != nil {
			return nil, errors.New("isolation: malformed /proc/net/unix line")
		}
		if flags&acceptCon == 0 || (typ != 1 && typ != 5) {
			continue
		}
		path := afterFields(line, 7) // the path may hold spaces
		if path == "" {
			continue
		}
		out = append(out, path)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if lr.N <= 0 {
		return nil, errors.New("isolation: /proc/net/unix too large") // never treated as complete
	}
	return out, nil
}

// afterFields is line with its first n space-separated fields and the spaces after them removed.
func afterFields(line string, n int) string {
	rest := line
	for i := 0; i < n; i++ {
		rest = strings.TrimLeft(rest, " ")
		j := strings.IndexByte(rest, ' ')
		if j < 0 {
			return ""
		}
		rest = rest[j:]
	}
	return strings.TrimLeft(rest, " ")
}

// EncodeRequest serializes a request for the probe.
func EncodeRequest(r Request) ([]byte, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(r)
}

// DecodeRequest reads and validates a request.
func DecodeRequest(rd io.Reader) (Request, error) {
	b, err := io.ReadAll(io.LimitReader(rd, maxRequest+1))
	if err != nil {
		return Request{}, err
	}
	if len(b) > maxRequest {
		return Request{}, errors.New("isolation: request too large")
	}
	var r Request
	if err := json.Unmarshal(b, &r); err != nil {
		return Request{}, err
	}
	return r, r.Validate()
}

// ParseAnswer reads the probe's stdout: exactly one known reason or OK, nothing else (fail
// closed: anything unexpected is CodeProbe).
func ParseAnswer(b []byte) phaselog.Code {
	s := phaselog.Code(strings.TrimSuffix(string(b), "\n"))
	if s == OK || knownReason(s) || s == phaselog.CodeProbe {
		return s
	}
	return phaselog.CodeProbe
}
