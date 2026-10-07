// Package hostprofile is the entrypoint's host profiles (module README "Host profiles";
// kete-code-platform ADR 0023 rule 16): which kind of host the job runs on, the signals each
// profile requires and forbids, where its four values come from, and the targets of its guards.
// Profiles replace the Fly-only guard; fly keeps today's guard and probe unchanged.
//
//	fly        Fly Machines; values from the environment; the Fly guard
//	microvm    the host agent's firecracker driver; values from the config disk via kete-job-init
//	dedicated  the host agent's dedicated driver; values on the agent's pipe
//	cloudvm    a provider VM per job; values from the provider's user data via kete-job-init
//
// Everything here fails closed: an unknown profile, a missing required signal or a present
// forbidden one refuses the job before claim. The package is pure; the Linux file reads the
// signals from the machine.
package hostprofile

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// Var selects the profile: in the environment for fly and dedicated, in the configuration
// (config disk, user data, agent pipe: Config.HostProfile) for microvm and cloudvm.
const Var = "KETE_JOB_HOST_PROFILE"

// Name is a host profile.
type Name string

const (
	Fly       Name = "fly"
	MicroVM   Name = "microvm"
	Dedicated Name = "dedicated"
	CloudVM   Name = "cloudvm"
)

// Source is where the four values came from.
type Source string

const (
	SourceEnv  Source = "env"  // the machine's environment (fly)
	SourcePipe Source = "pipe" // --config-fd: kete-job-init's or the host agent's pipe (the others)
)

// Parse checks a profile name.
func Parse(s string) (Name, error) {
	switch n := Name(s); n {
	case Fly, MicroVM, Dedicated, CloudVM:
		return n, nil
	}
	return "", errors.New("unknown host profile")
}

// ErrUnset: no profile was named and nothing says this is Fly (ADR 0023 rule 16 compatibility:
// unset means fly only when Fly's signals are present).
var ErrUnset = errors.New("no host profile and no Fly signal")

// Resolve is the boot rule: an explicit profile must be known; an unset one is fly only when Fly
// signals (a FLY_* machine variable or /.fly) are present, else ErrUnset.
func Resolve(explicit string, flySignals bool) (Name, error) {
	if explicit == "" {
		if flySignals {
			return Fly, nil
		}
		return "", ErrUnset
	}
	return Parse(explicit)
}

// SourceFor is where a profile's values must come from.
func SourceFor(n Name) Source {
	if n == Fly {
		return SourceEnv
	}
	return SourcePipe
}

// Providers for cloudvm, with the DMI field (under /sys/class/dmi/id) and value that identify each
// one's VMs (the fields cloud-init's datasources check). To verify on real VMs in P6.
var Providers = map[string]DMIMatch{
	"gcp":          {Field: "product_name", Value: "Google Compute Engine"},
	"digitalocean": {Field: "sys_vendor", Value: "DigitalOcean"},
	"hetzner":      {Field: "sys_vendor", Value: "Hetzner"},
	"oci":          {Field: "chassis_asset_tag", Value: "OracleCloud.com"},
}

// DMIMatch is one firmware field and its expected value.
type DMIMatch struct{ Field, Value string }

// ProviderForDMI returns the provider whose DMI field matches (read returns the field's content,
// trailing whitespace trimmed by the caller or here), or "" when none or more than one does.
func ProviderForDMI(read func(field string) (string, error)) string {
	found := ""
	for name, m := range Providers {
		v, err := read(m.Field)
		if err != nil || strings.TrimSpace(v) != m.Value {
			continue
		}
		if found != "" {
			return ""
		}
		found = name
	}
	return found
}

var generationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidGeneration checks a dedicated host's reset generation: 1-64 of letters, digits, '.', '_'
// and '-', starting with a letter or digit.
func ValidGeneration(g string) bool { return generationPattern.MatchString(g) }

// Signals are what the machine shows about its host (signals_linux.go reads them).
type Signals struct {
	FlyEnv     bool   // a FLY_* machine variable was set at boot (bootenv.Values.OnFly)
	FlyDir     bool   // /.fly exists (of any type)
	Source     Source // where the values came from
	Init       bool   // PID 1's executable is kete-job-init
	Vsock      bool   // a virtio vsock device exists
	Provider   string // cloudvm: the configuration's provider
	DMI        string // cloudvm: the provider whose DMI field matched (ProviderForDMI), or ""
	Generation string // dedicated: the agent's reset generation
	Kernel     Kernel // whose kernel this is (GatherKernel; read for every profile but fly)
}

// Refusal is a profile check's failure: a fixed code, never a value.
type Refusal struct{ Code phaselog.Code }

func (r *Refusal) Error() string { return "host profile refused: " + string(r.Code) }

// Check is the setup rule (step setup_host, before anything else): the profile's required
// signals present, its forbidden ones absent (ADR 0023 rule 16's table), and for every profile
// but fly the shared-kernel guard (kernel.go).
func Check(n Name, s Signals) error {
	if _, err := Parse(string(n)); err != nil {
		return &Refusal{Code: phaselog.CodeInvalid}
	}
	fly := s.FlyEnv || s.FlyDir
	if n == Fly {
		if !fly {
			return &Refusal{Code: phaselog.CodeMissing}
		}
		if s.Source != SourceEnv {
			return &Refusal{Code: phaselog.CodeSource}
		}
		return nil
	}
	if fly {
		return &Refusal{Code: phaselog.CodeFlySignals}
	}
	if s.Source != SourcePipe {
		return &Refusal{Code: phaselog.CodeSource}
	}
	// The shared-kernel guard (kernel.go): nothing below Check may write kernel state unless the
	// kernel is the VM's own, or the dedicated driver's single-tenant host's.
	if (n == Dedicated && !DedicatedReaper(s.Kernel)) || (n != Dedicated && !OwnKernel(s.Kernel)) {
		return &Refusal{Code: phaselog.CodeSharedKernel}
	}
	switch n {
	case MicroVM:
		if !s.Init {
			return &Refusal{Code: phaselog.CodeInit}
		}
		if s.Vsock {
			return &Refusal{Code: phaselog.CodeVsock}
		}
	case CloudVM:
		if !s.Init {
			return &Refusal{Code: phaselog.CodeInit}
		}
		if _, ok := Providers[s.Provider]; !ok || s.DMI != s.Provider {
			return &Refusal{Code: phaselog.CodeDMI}
		}
	case Dedicated:
		if !ValidGeneration(s.Generation) {
			return &Refusal{Code: phaselog.CodeGeneration}
		}
	}
	return nil
}

// ConfigDiskHeader starts the microvm config disk (ADR 0023 rule 13): this line, then one JSON
// object (bootenv.Config), then NUL padding to the disk's size.
const ConfigDiskHeader = "kete-job-config v1\n"

// Sample targets of the host-boundary probe and the tool user's per-profile isolation targets.
var (
	// GatewayPorts are sample TCP ports on the default gateway (the host side of the guest's
	// link): ssh, smtp, dns, http(s), rpcbind, docker, dev servers, the Fly and Kubernetes APIs,
	// node exporter, kubelet. Any answer means the host's table doesn't isolate the guest.
	GatewayPorts = []uint16{22, 25, 53, 80, 111, 443, 2375, 2376, 3000, 4280, 5000, 6443, 8000, 8080, 8443, 9100, 10250}
	// PrivateSamples are addresses in the ranges ADR 0023 rule 7 blocks: RFC 1918 (common gateways
	// and Docker's and providers' defaults), CGNAT, and IPv6 ULA. Re-verify this list on each
	// provider in P6: a provider whose own gateway or resolver sits at one of these addresses and
	// answers a sample port (e.g. Hetzner Cloud's 172.31.1.1) would refuse every cloudvm job there.
	PrivateSamples = []string{
		"10.0.0.1", "10.0.0.2", "10.128.0.1", "10.255.255.254", "172.16.0.1", "172.17.0.1",
		"172.31.1.1", "192.168.0.1", "192.168.1.1", "100.64.0.1", "100.100.100.100", "fd00::1",
	}
	PrivatePorts = []uint16{22, 53, 80, 443}
	// MetadataTargets are cloud metadata services beyond isolation.MetadataAddrs (port 80/443 on
	// 169.254.169.254): its DNS (GCP), AWS's resolver and IPv6 metadata addresses.
	MetadataTCP = []string{"169.254.169.254:80", "169.254.169.254:443", "169.254.169.253:53", "[fd00:ec2::254]:80", "[fd20:ce::254]:80"}
	MetadataDNS = []string{"169.254.169.254:53"}
	// IPv6Samples are public IPv6 addresses (Cloudflare's and Google's resolvers): guests get no
	// IPv6 route, and the host table drops every IPv6 packet.
	IPv6Samples = []string{"[2606:4700:4700::1111]:443", "[2001:4860:4860::8888]:443"}
	// AgentDirs are the dedicated host agent's state and configuration: never visible in a job.
	AgentDirs = []string{"/var/lib/kete-job-host", "/etc/kete-job-host"}
)

func addrPort(a string, port uint16) string {
	return netip.AddrPortFrom(netip.MustParseAddr(a), port).String()
}

// BoundaryTargets are the host-boundary probe's targets (root, before the in-guest rules; every
// profile but fly), without the control. gateways are the IPv4 default gateways (DefaultGateways).
func BoundaryTargets(gateways []netip.Addr) []isolation.Probe {
	var out []isolation.Probe
	add := func(k isolation.Kind, target string, r phaselog.Code) {
		out = append(out, isolation.Probe{Kind: k, Target: target, Reason: r})
	}
	for _, g := range gateways {
		for _, port := range GatewayPorts {
			add(isolation.KindTCP, netip.AddrPortFrom(g, port).String(), phaselog.CodeGateway)
		}
		add(isolation.KindDNS, netip.AddrPortFrom(g, 53).String(), phaselog.CodeGateway)
	}
	for _, t := range MetadataTCP {
		add(isolation.KindTCP, t, phaselog.CodeMetadata)
	}
	for _, t := range MetadataDNS {
		add(isolation.KindDNS, t, phaselog.CodeMetadata)
	}
	for _, a := range PrivateSamples {
		for _, port := range PrivatePorts {
			add(isolation.KindTCP, addrPort(a, port), phaselog.CodePrivateRange)
		}
	}
	for _, t := range IPv6Samples {
		add(isolation.KindTCP, t, phaselog.CodeIPv6)
	}
	return out
}

// IsolationTargets are the profile's extra targets for the tool user's isolation check
// (isolation.Inputs.Extra): none for fly (its list is unchanged); for the others the boundary
// targets, every block device node (guarded_path: a raw disk, the config disk included, must
// never open for the tool user), and for dedicated the host agent's directories.
func IsolationTargets(n Name, gateways []netip.Addr, blockDevices []string) []isolation.Probe {
	if n == Fly {
		return nil
	}
	out := BoundaryTargets(gateways)
	for _, d := range blockDevices {
		out = append(out, isolation.Probe{Kind: isolation.KindFile, Target: d, Reason: phaselog.CodeGuardedPath})
	}
	if n == Dedicated {
		for _, d := range AgentDirs {
			out = append(out, isolation.Probe{Kind: isolation.KindDir, Target: d, Reason: phaselog.CodeGuardedPath})
		}
	}
	return out
}

// DefaultGateways parses /proc/net/route content: the gateway of every IPv4 default route
// (destination and mask 0, RTF_GATEWAY set). Malformed content is an error (never a silently
// shorter list).
func DefaultGateways(r io.Reader) ([]netip.Addr, error) {
	const rtfUp, rtfGateway = 0x1, 0x2
	sc := bufio.NewScanner(io.LimitReader(r, 1<<20))
	var out []netip.Addr
	seen := map[netip.Addr]bool{}
	first := true
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if first {
			first = false
			if len(f) > 0 && f[0] == "Iface" {
				continue
			}
		}
		if len(f) < 8 {
			if len(f) == 0 {
				continue
			}
			return nil, errors.New("hostprofile: malformed route line")
		}
		dst, err1 := hex.DecodeString(f[1])
		gw, err2 := hex.DecodeString(f[2])
		flags, err3 := strconv.ParseUint(f[3], 16, 32)
		mask, err4 := hex.DecodeString(f[7])
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil || len(dst) != 4 || len(gw) != 4 || len(mask) != 4 {
			return nil, errors.New("hostprofile: malformed route line")
		}
		if binary.LittleEndian.Uint32(dst) != 0 || binary.LittleEndian.Uint32(mask) != 0 || flags&rtfUp == 0 || flags&rtfGateway == 0 {
			continue
		}
		// The kernel prints the address in host byte order (little-endian on every supported arch).
		a := netip.AddrFrom4([4]byte{gw[3], gw[2], gw[1], gw[0]})
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// MetadataDropTable is kete-job-init's nftables table in cloudvm guests (ADR 0023 rule 14): it
// drops the provider's metadata service for every user, root included, before the entrypoint
// starts. The entrypoint's own ruleset (kete-egress, table inet kete_egress) never touches it.
const MetadataDropTable = "kete_job_init"

// MetadataDropRuleset is the table, one atomic `nft -f -` input (re-applying replaces it).
func MetadataDropRuleset() string {
	return fmt.Sprintf(`table inet %[1]s
delete table inet %[1]s
table inet %[1]s {
	chain output {
		type filter hook output priority -150; policy accept;
		ip daddr 169.254.0.0/16 drop
		ip6 daddr { fd00:ec2::254, fd20:ce::254 } drop
	}
}
`, MetadataDropTable)
}

// VerifyMetadataDrop checks `nft -j list table inet kete_job_init` output: exactly the table of
// MetadataDropRuleset — one chain, type filter, hook output, priority -150, policy accept, and
// exactly its two rules (ip daddr 169.254.0.0/16 drop; ip6 daddr {fd00:ec2::254, fd20:ce::254}
// drop), nothing else. A table that exists but was emptied or altered fails.
func VerifyMetadataDrop(data []byte) error {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("metadata drop: %w", err)
	}
	type chain struct {
		Family, Table, Name, Type, Hook, Policy string
		Prio                                    *int
	}
	type rule struct {
		Family, Table, Chain string
		Expr                 []json.RawMessage
	}
	tables, chains := 0, []chain{}
	var rules []rule
	for _, obj := range doc.Nftables {
		for k, v := range obj {
			switch k {
			case "metainfo":
			case "table":
				tables++
			case "chain":
				var c chain
				if err := json.Unmarshal(v, &c); err != nil {
					return fmt.Errorf("metadata drop: %w", err)
				}
				chains = append(chains, c)
			case "rule":
				var r rule
				if err := json.Unmarshal(v, &r); err != nil {
					return fmt.Errorf("metadata drop: %w", err)
				}
				rules = append(rules, r)
			default:
				return fmt.Errorf("metadata drop: unexpected %q object", k)
			}
		}
	}
	if tables != 1 || len(chains) != 1 {
		return errors.New("metadata drop: want one table with one chain")
	}
	c := chains[0]
	if c.Family != "inet" || c.Table != MetadataDropTable || c.Type != "filter" || c.Hook != "output" || c.Prio == nil || *c.Prio != -150 || c.Policy != "accept" {
		return errors.New("metadata drop: chain differs")
	}
	want := map[string]bool{}
	for _, w := range []string{
		`[{"match":{"op":"==","left":{"payload":{"protocol":"ip","field":"daddr"}},"right":{"prefix":{"addr":"169.254.0.0","len":16}}}},{"drop":null}]`,
		`[{"match":{"op":"==","left":{"payload":{"protocol":"ip6","field":"daddr"}},"right":{"set":["fd00:ec2::254","fd20:ce::254"]}}},{"drop":null}]`,
	} {
		norm, err := canonicalJSON([]byte(w))
		if err != nil {
			return err
		}
		want[norm] = false
	}
	if len(rules) != len(want) {
		return errors.New("metadata drop: want exactly its two rules")
	}
	for _, r := range rules {
		if r.Family != "inet" || r.Table != MetadataDropTable || r.Chain != c.Name {
			return errors.New("metadata drop: rule outside the chain")
		}
		b, err := json.Marshal(r.Expr)
		if err != nil {
			return err
		}
		norm, err := canonicalJSON(b)
		if err != nil {
			return err
		}
		seen, ok := want[norm]
		if !ok || seen {
			return errors.New("metadata drop: unexpected rule")
		}
		want[norm] = true
	}
	return nil
}

// canonicalJSON re-encodes JSON with sorted keys and no spaces (encoding/json sorts map keys).
func canonicalJSON(b []byte) (string, error) {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return "", err
	}
	out, err := json.Marshal(v)
	return string(out), err
}
