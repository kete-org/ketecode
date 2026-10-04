//go:build integration && linux

package itest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/guestinit"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
)

// Host profiles (module README "Host profiles"; kete-code-platform ADR 0023 rule 16): the
// in-process runs set the profile and point the signal paths at test trees; the binary runs use
// the real boot stage.

// localAddr adds addr/32 (or /128) to lo for the test and listens on it with TCP on port, so the
// root host-boundary probe reaches it the way it would reach a host that doesn't isolate the guest.
func localAddr(t *testing.T, addr string, port int) {
	t.Helper()
	bits := "/32"
	if strings.Contains(addr, ":") {
		bits = "/128"
	}
	args := []string{"addr", "add", addr + bits, "dev", "lo"}
	if bits == "/128" {
		args = append(args, "nodad") // usable at once, not tentative
	}
	if out, err := exec.Command("ip", args...).CombinedOutput(); err != nil {
		t.Fatalf("ip addr add %s: %v: %s", addr, err, out)
	}
	t.Cleanup(func() { _ = exec.Command("ip", "addr", "del", addr+bits, "dev", "lo").Run() })
	ln, err := net.Listen("tcp", net.JoinHostPort(addr, strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
}

// guestTree is a test machine's signal tree: PID 1 is (or isn't) kete-job-init, no virtio
// device, the given DMI fields, no block device, and a route file.
type guestTree struct {
	dir string
}

func newGuestTree(t *testing.T, init bool, dmi map[string]string) guestTree {
	t.Helper()
	g := guestTree{dir: t.TempDir()}
	for _, d := range []string{"virtio", "dmi", "block", "dev"} {
		if err := os.MkdirAll(filepath.Join(g.dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	target := "/usr/local/bin/not-init"
	if init {
		target = layout.Default().InitBin
	}
	if err := os.Symlink(target, filepath.Join(g.dir, "exe")); err != nil {
		t.Fatal(err)
	}
	for k, v := range dmi {
		if err := os.WriteFile(filepath.Join(g.dir, "dmi", k), []byte(v+"\n"), 0o444); err != nil {
			t.Fatal(err)
		}
	}
	g.route(t, "198.51.100.1") // the netns's on-link default gateway (integration.sh); nothing answers
	return g
}

// route writes the route file: a default route via gw when set.
func (g guestTree) route(t *testing.T, gw string) {
	t.Helper()
	content := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
	if gw != "" {
		a := net.ParseIP(gw).To4()
		hex := strings.ToUpper(strconv.FormatUint(uint64(a[3])<<24|uint64(a[2])<<16|uint64(a[1])<<8|uint64(a[0]), 16))
		for len(hex) < 8 {
			hex = "0" + hex
		}
		content += "eth0\t00000000\t" + hex + "\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
	}
	if err := os.WriteFile(filepath.Join(g.dir, "route"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (g guestTree) apply(c *layout.Config) {
	c.Proc1Exe = filepath.Join(g.dir, "exe")
	c.VirtioDir = filepath.Join(g.dir, "virtio")
	c.DMIDir = filepath.Join(g.dir, "dmi")
	c.RouteFile = filepath.Join(g.dir, "route")
}

func profileBoot(profile, provider, generation string) func(*bootenv.Values) {
	return func(v *bootenv.Values) {
		v.Profile, v.Source, v.Provider, v.Generation = profile, "pipe", provider, generation
	}
}

var gcpDMI = map[string]string{"product_name": "Google Compute Engine"}

// TestProfileMismatch: every way a machine can contradict its profile stops setup_host before
// claim with its fixed code (ADR 0023 rule 16's fail-closed rules).
func TestProfileMismatch(t *testing.T) {
	flyDir := filepath.Join(stateDir, "fly-signal", ".fly")
	cases := []struct {
		name string
		boot func(*bootenv.Values)
		cfg  func(*testing.T, *layout.Config)
		code string
	}{
		{"fly variable with dedicated", func(v *bootenv.Values) { profileBoot("dedicated", "", "g1")(v); v.OnFly = true }, nil, "fly_signals"},
		{"fly directory with microvm", profileBoot("microvm", "", ""), func(t *testing.T, c *layout.Config) {
			newGuestTree(t, true, nil).apply(c)
			if err := os.MkdirAll(flyDir, 0o755); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(flyDir)) })
			c.FlyDir = flyDir
		}, "fly_signals"},
		{"fly variable with cloudvm", func(v *bootenv.Values) { profileBoot("cloudvm", "gcp", "")(v); v.OnFly = true }, func(t *testing.T, c *layout.Config) {
			newGuestTree(t, true, gcpDMI).apply(c)
		}, "fly_signals"},
		{"fly without a signal", func(v *bootenv.Values) { v.Profile, v.Source = "fly", "env" }, nil, "missing"},
		{"microvm without kete-job-init", profileBoot("microvm", "", ""), func(t *testing.T, c *layout.Config) {
			newGuestTree(t, false, nil).apply(c)
		}, "init"},
		{"microvm with a vsock device", profileBoot("microvm", "", ""), func(t *testing.T, c *layout.Config) {
			g := newGuestTree(t, true, nil)
			g.apply(c)
			dev := filepath.Join(g.dir, "virtio", "virtio3")
			if err := os.MkdirAll(dev, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dev, "device"), []byte("0x0013\n"), 0o444); err != nil {
				t.Fatal(err)
			}
		}, "vsock"},
		{"cloudvm on another provider's firmware", profileBoot("cloudvm", "hetzner", ""), func(t *testing.T, c *layout.Config) {
			newGuestTree(t, true, gcpDMI).apply(c)
		}, "dmi"},
		{"dedicated with values from the environment", func(v *bootenv.Values) { profileBoot("dedicated", "", "g1")(v); v.Source = "env" }, nil, "source"},
		{"dedicated without a generation", profileBoot("dedicated", "", ""), nil, "generation"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withBoot(t, c.boot)
			r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(cfg *layout.Config) {
				if c.cfg != nil {
					c.cfg(t, cfg)
				}
			})
			zeroClaims(t, r)
			if want := `"step":"setup_host","event":"failed","code":"` + c.code + `"`; !phaseLine(r.stdout, want) {
				t.Errorf("no %s line:\n%s", want, r.stdout)
			}
		})
	}
}

// TestHostBoundaryMicrovm: the microvm host-boundary probe, as root before the in-guest rules,
// refuses a reachable gateway port, private-range sample, metadata address or IPv6 sample and a
// config disk still present; with none of them the job runs.
func TestHostBoundaryMicrovm(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*testing.T, guestTree, *layout.Config)
		code  string
	}{
		{"gateway", func(t *testing.T, g guestTree, _ *layout.Config) {
			g.route(t, "198.51.100.77")
			localAddr(t, "198.51.100.77", 22)
		}, "gateway"},
		{"no default gateway", func(t *testing.T, g guestTree, _ *layout.Config) { g.route(t, "") }, "probe"},
		{"rfc1918 sample", func(t *testing.T, _ guestTree, _ *layout.Config) { localAddr(t, "10.0.0.1", 443) }, "private_range"},
		{"cgnat sample", func(t *testing.T, _ guestTree, _ *layout.Config) { localAddr(t, "100.64.0.1", 80) }, "private_range"},
		{"metadata", func(t *testing.T, _ guestTree, _ *layout.Config) { localAddr(t, "169.254.169.254", 80) }, "metadata"},
		{"ipv6", func(t *testing.T, _ guestTree, _ *layout.Config) { localAddr(t, "2606:4700:4700::1111", 443) }, "ipv6"},
		{"config disk", func(t *testing.T, g guestTree, c *layout.Config) {
			if err := os.MkdirAll(filepath.Join(g.dir, "block", "vdz"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(g.dir, "block", "vdz", "size"), []byte("8\n"), 0o444); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(g.dir, "dev", "vdz"), []byte(hostprofile.ConfigDiskHeader+`{"job_id":"x"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			c.SysBlockDir, c.DevDir = filepath.Join(g.dir, "block"), filepath.Join(g.dir, "dev")
		}, "config_disk"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withBoot(t, profileBoot("microvm", "", ""))
			g := newGuestTree(t, true, nil)
			r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(cfg *layout.Config) {
				g.apply(cfg)
				c.setup(t, g, cfg)
			})
			zeroClaims(t, r)
			if want := `"step":"host_boundary","event":"failed","code":"` + c.code + `"`; !phaseLine(r.stdout, want) {
				t.Errorf("no %s line:\n%s", want, r.stdout)
			}
		})
	}
	t.Run("nothing reachable", func(t *testing.T) {
		withBoot(t, profileBoot("microvm", "", ""))
		g := newGuestTree(t, true, nil)
		r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, g.apply)
		if r.code != 0 {
			t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
		}
		for _, want := range []string{`"step":"setup_host","event":"ok"`, `"step":"host_boundary","event":"ok"`, `"step":"isolation","event":"ok"`} {
			if !phaseLine(r.stdout, want) {
				t.Errorf("no %s line", want)
			}
		}
		if phaseLine(r.stdout, `"step":"setup_fly"`) {
			t.Error("the Fly guard ran off Fly")
		}
		if res := resultOf(t); res["outcome"] != "completed" {
			t.Errorf("result = %v", res)
		}
	})
}

// TestCloudvmMetadataDrop: cloudvm needs kete-job-init's metadata drop (ADR 0023 rule 14): without
// the table the job is refused before claim; with it (the ruleset init applies) a reachable
// metadata address is dropped for root too, and the job runs.
func TestCloudvmMetadataDrop(t *testing.T) {
	t.Cleanup(func() { _ = exec.Command("nft", "delete", "table", "inet", hostprofile.MetadataDropTable).Run() })
	localAddr(t, "169.254.169.254", 80)
	withBoot(t, profileBoot("cloudvm", "gcp", ""))
	g := newGuestTree(t, true, gcpDMI)

	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, g.apply)
	zeroClaims(t, r)
	if want := `"step":"host_boundary","event":"failed","code":"metadata_drop"`; !phaseLine(r.stdout, want) {
		t.Fatalf("no %s line:\n%s", want, r.stdout)
	}

	// A table of that name that doesn't hold exactly the drop rules is refused too.
	tampered := "table inet kete_job_init\ndelete table inet kete_job_init\ntable inet kete_job_init {\n chain output {\n  type filter hook output priority -150; policy accept;\n  ip daddr 169.254.169.254 accept\n  ip daddr 169.254.0.0/16 drop\n  ip6 daddr { fd00:ec2::254, fd20:ce::254 } drop\n }\n}\n"
	tcmd := exec.Command("nft", "-f", "-")
	tcmd.Stdin = strings.NewReader(tampered)
	if out, err := tcmd.CombinedOutput(); err != nil {
		t.Fatalf("nft: %v: %s", err, out)
	}
	r = runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, g.apply)
	zeroClaims(t, r)
	if want := `"step":"host_boundary","event":"failed","code":"metadata_drop"`; !phaseLine(r.stdout, want) {
		t.Fatalf("tampered table: no %s line:\n%s", want, r.stdout)
	}
	// kete-job-init's own function: apply the table, list it back and check its rules.
	if err := guestinit.ApplyMetadataDrop(context.Background(), layout.Default().NftBin); err != nil {
		t.Fatal(err)
	}
	r = runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, g.apply)
	if r.code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
	for _, want := range []string{`"step":"host_boundary","event":"ok"`, `"step":"isolation","event":"ok"`} {
		if !phaseLine(r.stdout, want) {
			t.Errorf("no %s line", want)
		}
	}
	if res := resultOf(t); res["outcome"] != "completed" {
		t.Errorf("result = %v", res)
	}
}

// runBinary runs the built entrypoint as a real process in its own cgroup with env, args and,
// when cfg isn't nil, a pipe carrying cfg on fd 3 (or a regular file with notPipe). It returns the
// exit code and stdout.
func runBinary(t *testing.T, j *fakeplatform.Job, env, args []string, cfg []byte, notPipe bool) (int, string) {
	t.Helper()
	prepareRoot(t)
	boot := filepath.Join(cgroupRoot, "bin-boot")
	if err := os.Mkdir(boot, 0o755); err != nil {
		t.Fatal(err)
	}
	cgfd, err := syscall.Open(boot, syscall.O_DIRECTORY|syscall.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(cgfd)
	cmd := exec.Command(entrypoint, args...)
	cmd.Env = env
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: cgfd}
	if cfg != nil {
		if notPipe {
			p := filepath.Join(stateDir, "config.json")
			if err := os.WriteFile(p, cfg, 0o600); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Remove(p) })
			f, err := os.Open(p)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			cmd.ExtraFiles = []*os.File{f}
		} else {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := w.Write(cfg); err != nil {
				t.Fatal(err)
			}
			w.Close()
			defer r.Close()
			cmd.ExtraFiles = []*os.File{r}
		}
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	errc := make(chan error, 1)
	go func() { errc <- cmd.Wait() }()
	// While it runs, no cmdline or environment of the entrypoint holds the claim token.
	done := false
	giveUp := time.After(3 * time.Minute)
	for !done {
		select {
		case err := <-errc:
			done = true
			var ee *exec.ExitError
			if err != nil && !errors.As(err, &ee) {
				t.Fatalf("entrypoint: %v", err)
			}
		case <-time.After(20 * time.Millisecond):
			for _, f := range []string{"cmdline", "environ"} {
				b, _ := os.ReadFile("/proc/" + pid + "/" + f)
				if bytes.Contains(b, []byte(j.ClaimToken)) {
					t.Errorf("the claim token is in the entrypoint's %s", f)
				}
			}
		case <-giveUp:
			_ = cmd.Process.Kill()
			t.Fatal("entrypoint did not finish")
		}
	}
	checkPhaseLines(t, out.String(), j)
	return cmd.ProcessState.ExitCode(), out.String()
}

func jobConfig(j *fakeplatform.Job, profile, generation string) []byte {
	b, _ := json.Marshal(bootenv.Config{
		JobID: j.ID, PlatformURL: "https://" + fakeplatform.PlatformHost, ClaimToken: j.ClaimToken,
		StorageHost: fakeplatform.StorageHost, HostProfile: profile, HostGeneration: generation,
	})
	return b
}

// TestBinaryBootDedicated: the built binary as the dedicated host agent launches it
// (KETE_JOB_HOST_PROFILE=dedicated, the values on a pipe, --config-fd 3) runs a whole job.
func TestBinaryBootDedicated(t *testing.T) {
	t.Cleanup(func() { cleanup(t) })
	j := FP.NewJob(fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 10 * time.Minute})
	code, out := runBinary(t, j, []string{"PATH=/usr/bin:/bin", hostprofile.Var + "=dedicated"}, []string{"--config-fd", "3"}, jobConfig(j, "dedicated", "gen-7"), false)
	if code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", code, out)
	}
	for _, want := range []string{`"step":"setup_host","event":"ok"`, `"step":"host_boundary","event":"ok"`, `"step":"isolation","event":"ok"`} {
		if !phaseLine(out, want) {
			t.Errorf("no %s line", want)
		}
	}
	if res := resultOf(t); res["outcome"] != "completed" {
		t.Errorf("result = %v", res)
	}
	if _, ok := FP.Uploaded("bundle"); !ok {
		t.Error("no bundle")
	}
}

// TestBinaryBootDedicatedStdin: the config on fd 0 (as `docker run -i` delivers it, e2e.sh) works
// the same: the handover pipe is moved above stdio.
func TestBinaryBootDedicatedStdin(t *testing.T) {
	t.Cleanup(func() { cleanup(t) })
	j := FP.NewJob(fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 10 * time.Minute})
	prepareRoot(t)
	boot := filepath.Join(cgroupRoot, "bin-boot")
	if err := os.Mkdir(boot, 0o755); err != nil {
		t.Fatal(err)
	}
	cgfd, err := syscall.Open(boot, syscall.O_DIRECTORY|syscall.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(cgfd)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(jobConfig(j, "dedicated", "gen-8")); err != nil {
		t.Fatal(err)
	}
	w.Close()
	defer r.Close()
	cmd := exec.Command(entrypoint, "--config-fd", "0")
	cmd.Env = []string{"PATH=/usr/bin:/bin", hostprofile.Var + "=dedicated"}
	cmd.Stdin = r
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: cgfd}
	if err := cmd.Run(); err != nil {
		t.Fatalf("entrypoint: %v; stdout:\n%s", err, out.String())
	}
	checkPhaseLines(t, out.String(), j)
	if res := resultOf(t); res["outcome"] != "completed" {
		t.Errorf("result = %v", res)
	}
}

// TestBinaryBootRefusals: boot-stage refusals exit 2 with no claim: no profile and no Fly signal
// (ADR 0023 rule 16 compatibility), an unknown profile, values from the environment for a pipe
// profile, a config fd that isn't a pipe, the four values in both places, a profile that differs
// between the environment and the config, and a config without its generation.
func TestBinaryBootRefusals(t *testing.T) {
	if _, err := os.Lstat("/.fly"); err == nil {
		t.Skip("/.fly exists in this container")
	}
	for _, c := range []struct {
		name    string
		env     []string
		args    []string
		cfg     func(*fakeplatform.Job) []byte
		notPipe bool
	}{
		{name: "no profile, no fly", env: nil},
		{name: "unknown profile", env: []string{hostprofile.Var + "=firecracker"}},
		{name: "dedicated from the environment", env: []string{hostprofile.Var + "=dedicated"}},
		{name: "config in a file", args: []string{"--config-fd", "3"}, cfg: func(j *fakeplatform.Job) []byte { return jobConfig(j, "dedicated", "g") }, notPipe: true},
		{name: "values in both places", env: []string{"__ENV__"}, args: []string{"--config-fd", "3"}, cfg: func(j *fakeplatform.Job) []byte { return jobConfig(j, "dedicated", "g") }},
		{name: "profile differs", env: []string{hostprofile.Var + "=microvm"}, args: []string{"--config-fd", "3"}, cfg: func(j *fakeplatform.Job) []byte { return jobConfig(j, "dedicated", "g") }},
		{name: "no generation", args: []string{"--config-fd", "3"}, cfg: func(j *fakeplatform.Job) []byte { return jobConfig(j, "dedicated", "") }},
		{name: "fly from a pipe", args: []string{"--config-fd", "3"}, cfg: func(j *fakeplatform.Job) []byte { return jobConfig(j, "fly", "") }},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Cleanup(func() { cleanup(t) })
			j := FP.NewJob(fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 10 * time.Minute})
			envVals := []string{"KETE_JOB_ID=" + j.ID, "KETE_JOB_PLATFORM_URL=https://" + fakeplatform.PlatformHost, "KETE_JOB_CLAIM_TOKEN=" + j.ClaimToken, "KETE_JOB_STORAGE_HOST=" + fakeplatform.StorageHost}
			env := []string{"PATH=/usr/bin:/bin"}
			for _, e := range c.env {
				if e == "__ENV__" {
					env = append(env, envVals...)
				} else {
					env = append(env, e)
				}
			}
			var cfg []byte
			if c.cfg != nil {
				cfg = c.cfg(j)
			} else {
				env = append(env, envVals...)
			}
			code, out := runBinary(t, j, env, c.args, cfg, c.notPipe)
			if code != 2 {
				t.Errorf("exit %d; stdout:\n%s", code, out)
			}
			if !phaseLine(out, `"step":"boot","event":"failed","code":"invalid"`) {
				t.Errorf("no boot invalid line:\n%s", out)
			}
			if n := countCalls("claim"); n != 0 {
				t.Errorf("%d claim requests", n)
			}
		})
	}
}
