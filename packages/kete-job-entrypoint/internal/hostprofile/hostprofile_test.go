package hostprofile

import (
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

func TestResolve(t *testing.T) {
	cases := []struct {
		explicit string
		fly      bool
		want     Name
		err      bool
	}{
		{"", true, Fly, false}, // compatibility: today's Fly adapter sets no profile
		{"", false, "", true},  // unset with no Fly signal: exit 2
		{"fly", false, Fly, false},
		{"microvm", false, MicroVM, false},
		{"dedicated", true, Dedicated, false}, // resolved; setup then refuses it (fly_signals)
		{"cloudvm", false, CloudVM, false},
		{"firecracker", false, "", true},
		{"FLY", true, "", true},
	}
	for _, c := range cases {
		got, err := Resolve(c.explicit, c.fly)
		if (err != nil) != c.err || got != c.want {
			t.Errorf("Resolve(%q, %v) = %q, %v", c.explicit, c.fly, got, err)
		}
	}
	if _, err := Resolve("", false); !errors.Is(err, ErrUnset) {
		t.Errorf("unset: %v", err)
	}
}

func code(err error) phaselog.Code {
	if err == nil {
		return "ok"
	}
	var r *Refusal
	if errors.As(err, &r) {
		return r.Code
	}
	return "not a refusal"
}

// valid returns a profile's signals with every requirement met.
func valid(n Name) Signals {
	switch n {
	case Fly:
		return Signals{FlyEnv: true, Source: SourceEnv}
	case MicroVM:
		return Signals{Source: SourcePipe, Init: true}
	case CloudVM:
		return Signals{Source: SourcePipe, Init: true, Provider: "gcp", DMI: "gcp"}
	case Dedicated:
		return Signals{Source: SourcePipe, Generation: "gen-1"}
	}
	return Signals{}
}

// TestCheckMatrix covers every row of ADR 0023 rule 16's table: each profile with its signals
// passes; Fly signals with each non-fly profile, each missing required signal and each present
// forbidden signal is refused with its code.
func TestCheckMatrix(t *testing.T) {
	for _, n := range []Name{Fly, MicroVM, CloudVM, Dedicated} {
		if got := code(Check(n, valid(n))); got != "ok" {
			t.Errorf("%s with its signals: %s", n, got)
		}
	}
	// Fly signals (a variable or the directory) with each non-fly profile.
	for _, n := range []Name{MicroVM, CloudVM, Dedicated} {
		for name, mod := range map[string]func(*Signals){
			"variable":  func(s *Signals) { s.FlyEnv = true },
			"directory": func(s *Signals) { s.FlyDir = true },
		} {
			s := valid(n)
			mod(&s)
			if got := code(Check(n, s)); got != phaselog.CodeFlySignals {
				t.Errorf("%s with a Fly %s: %s", n, name, got)
			}
		}
	}
	cases := []struct {
		name string
		n    Name
		mod  func(*Signals)
		want phaselog.Code
	}{
		{"fly, no signal", Fly, func(s *Signals) { s.FlyEnv = false }, phaselog.CodeMissing},
		{"fly, directory only", Fly, func(s *Signals) { s.FlyEnv, s.FlyDir = false, true }, "ok"},
		{"fly from a pipe", Fly, func(s *Signals) { s.Source = SourcePipe }, phaselog.CodeSource},
		{"microvm from the environment", MicroVM, func(s *Signals) { s.Source = SourceEnv }, phaselog.CodeSource},
		{"microvm without init", MicroVM, func(s *Signals) { s.Init = false }, phaselog.CodeInit},
		{"microvm with vsock", MicroVM, func(s *Signals) { s.Vsock = true }, phaselog.CodeVsock},
		{"cloudvm from the environment", CloudVM, func(s *Signals) { s.Source = SourceEnv }, phaselog.CodeSource},
		{"cloudvm without init", CloudVM, func(s *Signals) { s.Init = false }, phaselog.CodeInit},
		{"cloudvm, other firmware", CloudVM, func(s *Signals) { s.DMI = "hetzner" }, phaselog.CodeDMI},
		{"cloudvm, no firmware match", CloudVM, func(s *Signals) { s.DMI = "" }, phaselog.CodeDMI},
		{"cloudvm, unknown provider", CloudVM, func(s *Signals) { s.Provider, s.DMI = "aws", "aws" }, phaselog.CodeDMI},
		{"cloudvm with vsock is still fine", CloudVM, func(s *Signals) { s.Vsock = true }, "ok"},
		{"dedicated from the environment", Dedicated, func(s *Signals) { s.Source = SourceEnv }, phaselog.CodeSource},
		{"dedicated without a generation", Dedicated, func(s *Signals) { s.Generation = "" }, phaselog.CodeGeneration},
		{"dedicated, bad generation", Dedicated, func(s *Signals) { s.Generation = "a b" }, phaselog.CodeGeneration},
	}
	for _, c := range cases {
		s := valid(c.n)
		c.mod(&s)
		if got := code(Check(c.n, s)); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	if got := code(Check("", Signals{})); got != phaselog.CodeInvalid {
		t.Errorf("empty profile: %s", got)
	}
	if got := code(Check("firecracker", valid(MicroVM))); got != phaselog.CodeInvalid {
		t.Errorf("unknown profile: %s", got)
	}
}

func TestProviderForDMI(t *testing.T) {
	fields := func(m map[string]string) func(string) (string, error) {
		return func(f string) (string, error) {
			v, ok := m[f]
			if !ok {
				return "", errors.New("no such field")
			}
			return v, nil
		}
	}
	cases := map[string]struct {
		m    map[string]string
		want string
	}{
		"gcp":          {map[string]string{"product_name": "Google Compute Engine\n", "sys_vendor": "Google\n"}, "gcp"},
		"digitalocean": {map[string]string{"sys_vendor": "DigitalOcean\n"}, "digitalocean"},
		"hetzner":      {map[string]string{"sys_vendor": "Hetzner\n"}, "hetzner"},
		"oci":          {map[string]string{"chassis_asset_tag": "OracleCloud.com\n", "sys_vendor": "QEMU\n"}, "oci"},
		"qemu":         {map[string]string{"sys_vendor": "QEMU\n"}, ""},
		"nothing":      {map[string]string{}, ""},
		"two match":    {map[string]string{"sys_vendor": "Hetzner", "chassis_asset_tag": "OracleCloud.com"}, ""},
	}
	for name, c := range cases {
		if got := ProviderForDMI(fields(c.m)); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

func TestDefaultGateways(t *testing.T) {
	route := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" + // default via 192.168.0.1
		"eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n" + // 192.168.0.0/24, no gateway
		"eth1\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n" + // the same gateway again
		"eth2\t00000000\t02020A0A\t0001\t0\t0\t0\t00000000\t0\t0\t0\n" // default, no RTF_GATEWAY
	got, err := DefaultGateways(strings.NewReader(route))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != netip.MustParseAddr("192.168.0.1") {
		t.Errorf("gateways = %v", got)
	}
	if _, err := DefaultGateways(strings.NewReader("Iface\nbad line here\n")); err == nil {
		t.Error("malformed route accepted")
	}
	if got, err := DefaultGateways(strings.NewReader("")); err != nil || len(got) != 0 {
		t.Errorf("empty: %v %v", got, err)
	}
}

func TestBoundaryTargets(t *testing.T) {
	gw := netip.MustParseAddr("10.200.0.1")
	probes := BoundaryTargets([]netip.Addr{gw})
	has := func(k isolation.Kind, target string, r phaselog.Code) bool {
		for _, p := range probes {
			if p.Kind == k && p.Target == target && p.Reason == r {
				return true
			}
		}
		return false
	}
	for _, want := range []struct {
		k isolation.Kind
		t string
		r phaselog.Code
	}{
		{isolation.KindTCP, "10.200.0.1:22", phaselog.CodeGateway},
		{isolation.KindTCP, "10.200.0.1:443", phaselog.CodeGateway},
		{isolation.KindDNS, "10.200.0.1:53", phaselog.CodeGateway},
		{isolation.KindTCP, "169.254.169.254:80", phaselog.CodeMetadata},
		{isolation.KindDNS, "169.254.169.254:53", phaselog.CodeMetadata},
		{isolation.KindTCP, "10.0.0.1:443", phaselog.CodePrivateRange},
		{isolation.KindTCP, "100.64.0.1:80", phaselog.CodePrivateRange},
		{isolation.KindTCP, "[fd00::1]:443", phaselog.CodePrivateRange},
		{isolation.KindTCP, "[2606:4700:4700::1111]:443", phaselog.CodeIPv6},
	} {
		if !has(want.k, want.t, want.r) {
			t.Errorf("no %s %s (%s)", want.k, want.t, want.r)
		}
	}
	// Every target is valid for the probe (with a control, Validate accepts the request).
	req := isolation.NewRequest(append(isolation.Controls("127.0.0.1:1", ""), probes...))
	if err := req.Validate(); err != nil {
		t.Errorf("boundary request invalid: %v", err)
	}
}

func TestIsolationTargets(t *testing.T) {
	if got := IsolationTargets(Fly, nil, []string{"/dev/vda"}); got != nil {
		t.Errorf("fly gets extra targets: %v", got)
	}
	devs := []string{"/dev/vda", "/dev/vdb"}
	for _, n := range []Name{MicroVM, CloudVM, Dedicated} {
		got := IsolationTargets(n, nil, devs)
		files, dirs := 0, 0
		for _, p := range got {
			if p.Reason == phaselog.CodeGuardedPath && p.Kind == isolation.KindFile {
				files++
			}
			if p.Reason == phaselog.CodeGuardedPath && p.Kind == isolation.KindDir {
				dirs++
			}
		}
		if files != len(devs) {
			t.Errorf("%s: %d guarded block devices", n, files)
		}
		if wantDirs := map[Name]int{Dedicated: len(AgentDirs)}[n]; dirs != wantDirs {
			t.Errorf("%s: %d guarded dirs, want %d", n, dirs, wantDirs)
		}
	}
}

func TestMetadataDropRuleset(t *testing.T) {
	r := MetadataDropRuleset()
	for _, want := range []string{"table inet kete_job_init", "delete table inet kete_job_init", "hook output", "ip daddr 169.254.0.0/16 drop"} {
		if !strings.Contains(r, want) {
			t.Errorf("ruleset lacks %q:\n%s", want, r)
		}
	}
}

func TestValidGeneration(t *testing.T) {
	for g, want := range map[string]bool{"1": true, "gen-7": true, "a.b_c-d": true, "": false, "-x": false, "a b": false, strings.Repeat("a", 65): false, strings.Repeat("a", 64): true} {
		if ValidGeneration(g) != want {
			t.Errorf("%q: %v", g, !want)
		}
	}
}

// nftDropJSON is `nft -j list table inet kete_job_init` after MetadataDropRuleset (nft 1.0.6).
const nftDropJSON = `{"nftables": [{"metainfo": {"version": "1.0.6", "release_name": "Lester Gooch #5", "json_schema_version": 1}}, {"table": {"family": "inet", "name": "kete_job_init", "handle": 2}}, {"chain": {"family": "inet", "table": "kete_job_init", "name": "output", "handle": 1, "type": "filter", "hook": "output", "prio": -150, "policy": "accept"}}, {"rule": {"family": "inet", "table": "kete_job_init", "chain": "output", "handle": 2, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": {"prefix": {"addr": "169.254.0.0", "len": 16}}}}, {"drop": null}]}}, {"rule": {"family": "inet", "table": "kete_job_init", "chain": "output", "handle": 4, "expr": [{"match": {"op": "==", "left": {"payload": {"protocol": "ip6", "field": "daddr"}}, "right": {"set": ["fd00:ec2::254", "fd20:ce::254"]}}}, {"drop": null}]}}]}`

func TestVerifyMetadataDrop(t *testing.T) {
	if err := VerifyMetadataDrop([]byte(nftDropJSON)); err != nil {
		t.Fatalf("the real ruleset: %v", err)
	}
	accept := `{"rule": {"family": "inet", "table": "kete_job_init", "chain": "output", "handle": 5, "expr": [{"accept": null}]}}`
	for name, mod := range map[string]func(string) string{
		"no rules":        func(s string) string { return s[:strings.Index(s, `, {"rule"`)] + "]}" },
		"extra accept":    func(s string) string { return strings.Replace(s, `{"rule"`, accept+`, {"rule"`, 1) },
		"wider prefix":    func(s string) string { return strings.Replace(s, `"len": 16`, `"len": 24`, 1) },
		"accept not drop": func(s string) string { return strings.Replace(s, `{"drop": null}`, `{"accept": null}`, 1) },
		"other hook":      func(s string) string { return strings.Replace(s, `"hook": "output"`, `"hook": "input"`, 1) },
		"other priority":  func(s string) string { return strings.Replace(s, `"prio": -150`, `"prio": 10`, 1) },
		"drop policy only": func(s string) string {
			return strings.Replace(s, `"name": "output", "handle": 1`, `"name": "out2", "handle": 1`, 1)
		},
		"one ipv6 address": func(s string) string { return strings.Replace(s, `"fd00:ec2::254", `, ``, 1) },
		"not json":         func(string) string { return "table inet kete_job_init {}" },
	} {
		if err := VerifyMetadataDrop([]byte(mod(nftDropJSON))); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
