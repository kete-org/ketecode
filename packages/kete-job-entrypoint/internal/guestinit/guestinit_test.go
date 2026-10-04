package guestinit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// fakeMachine records the order of operations; fail names an operation that fails.
type fakeMachine struct {
	calls    []string
	fail     string
	disk     string
	diskCfg  string
	provider string
	userData string
	payload  []byte
	exit     int
	power    *Power
}

func (f *fakeMachine) op(name string) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New(name + " failed")
	}
	return nil
}

func (f *fakeMachine) Mounts() error { return f.op("mounts") }
func (f *fakeMachine) Network(context.Context) error {
	if f.fail == "network_panic" {
		panic("boom")
	}
	return f.op("network")
}
func (f *fakeMachine) FindConfigDisk() (string, error) {
	return f.disk, f.op("find_disk")
}
func (f *fakeMachine) ReadConfigDisk(string) (bootenv.Config, error) {
	if err := f.op("read_disk"); err != nil {
		return bootenv.Config{}, err
	}
	return ParseConfigDisk(bytes.NewReader(disk(f.diskCfg, 64)))
}
func (f *fakeMachine) RemoveConfigDisk(string) error { return f.op("remove_disk") }
func (f *fakeMachine) Provider() string              { f.calls = append(f.calls, "provider"); return f.provider }
func (f *fakeMachine) UserData(context.Context, string) ([]byte, error) {
	return []byte(f.userData), f.op("user_data")
}
func (f *fakeMachine) MetadataDrop(context.Context) error { return f.op("metadata_drop") }
func (f *fakeMachine) StartEntrypoint(p []byte) (int, error) {
	f.payload = append([]byte(nil), p...)
	return 42, f.op("start")
}
func (f *fakeMachine) Wait(pid int) int {
	f.calls = append(f.calls, "wait")
	return f.exit
}
func (f *fakeMachine) Shutdown(p Power) {
	f.calls = append(f.calls, "shutdown")
	f.power = &p
}

func run(f *fakeMachine) (Power, string) {
	var out bytes.Buffer
	p := Run(context.Background(), f, pl.New(&out))
	return p, out.String()
}

func indexOf(calls []string, name string) int {
	for i, c := range calls {
		if c == name {
			return i
		}
	}
	return -1
}

func TestRunMicroVM(t *testing.T) {
	f := &fakeMachine{disk: "/dev/vdc", diskCfg: microvmJSON, exit: 3}
	p, out := run(f)
	want := []string{"mounts", "network", "find_disk", "read_disk", "remove_disk", "start", "wait", "shutdown"}
	if strings.Join(f.calls, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v", f.calls)
	}
	if p != Restart || f.power == nil || *f.power != Restart {
		t.Errorf("microvm ends with %v", p)
	}
	var cfg bootenv.Config
	if err := json.Unmarshal(f.payload, &cfg); err != nil || cfg.HostProfile != "microvm" || cfg.ClaimToken != token {
		t.Errorf("payload: %+v %v", cfg, err)
	}
	if !strings.Contains(out, `"step":"init_entrypoint","event":"exit","exit_code":3`) {
		t.Errorf("no exit line:\n%s", out)
	}
	if strings.Contains(out, token) {
		t.Error("the claim token reached the console")
	}
}

// TestRunCloudVM: the metadata drop is installed after the user data is read and before the
// entrypoint starts; on exit the VM powers off (never a reboot that would boot-loop).
func TestRunCloudVM(t *testing.T) {
	f := &fakeMachine{provider: "gcp", userData: cloudJSON("gcp")}
	p, _ := run(f)
	ud, drop, start := indexOf(f.calls, "user_data"), indexOf(f.calls, "metadata_drop"), indexOf(f.calls, "start")
	if ud < 0 || drop < 0 || start < 0 || !(ud < drop && drop < start) {
		t.Errorf("order: %v", f.calls)
	}
	if p != PowerOff || f.power == nil || *f.power != PowerOff {
		t.Errorf("cloudvm ends with %v", p)
	}
}

// TestRunFailures: any failure before the entrypoint powers off without starting it.
func TestRunFailures(t *testing.T) {
	cases := map[string]*fakeMachine{
		"mounts":              {fail: "mounts", disk: "/dev/vdc", diskCfg: microvmJSON},
		"network":             {fail: "network", disk: "/dev/vdc", diskCfg: microvmJSON},
		"find disk":           {fail: "find_disk"},
		"read disk":           {fail: "read_disk", disk: "/dev/vdc", diskCfg: microvmJSON},
		"bad disk":            {disk: "/dev/vdc", diskCfg: `{"job_id":1}`},
		"remove disk":         {fail: "remove_disk", disk: "/dev/vdc", diskCfg: microvmJSON},
		"no source":           {},
		"user data":           {fail: "user_data", provider: "hetzner"},
		"user data, other vm": {provider: "hetzner", userData: cloudJSON("gcp")},
		"user data, microvm":  {provider: "hetzner", userData: microvmJSON},
		"metadata drop":       {fail: "metadata_drop", provider: "oci", userData: cloudJSON("oci")},
	}
	for name, f := range cases {
		p, out := run(f)
		if indexOf(f.calls, "start") >= 0 {
			t.Errorf("%s: the entrypoint started: %v", name, f.calls)
		}
		if p != PowerOff || indexOf(f.calls, "shutdown") != len(f.calls)-1 {
			t.Errorf("%s: ended with %v, calls %v", name, p, f.calls)
		}
		if !strings.Contains(out, `"event":"failed"`) {
			t.Errorf("%s: no failed line:\n%s", name, out)
		}
	}
	// A failing start still shuts down (Restart: the microvm's mode was known).
	f := &fakeMachine{fail: "start", disk: "/dev/vdc", diskCfg: microvmJSON}
	if p, _ := run(f); p != Restart || indexOf(f.calls, "wait") >= 0 {
		t.Errorf("failed start: %v %v", p, f.calls)
	}
}

// TestRunPanic: a panic in a step (here the network) is recovered, powers off (even on a microvm,
// whose mode isn't known yet) and never starts the entrypoint.
func TestRunPanic(t *testing.T) {
	f := &fakeMachine{fail: "network_panic", disk: "/dev/vdc", diskCfg: microvmJSON}
	p, out := run(f)
	if p != PowerOff || f.power == nil || *f.power != PowerOff {
		t.Errorf("panic ended with %v (%v)", p, f.power)
	}
	if indexOf(f.calls, "start") >= 0 {
		t.Errorf("entrypoint started: %v", f.calls)
	}
	if !strings.Contains(out, `"step":"init_poweroff","event":"failed"`) {
		t.Errorf("no failed poweroff line:\n%s", out)
	}
	// After the microvm's mode is known, a panic still powers off (fail safe), never restarts.
	g := &fakeMachine{disk: "/dev/vdc", diskCfg: microvmJSON}
	gp := &panicStart{fakeMachine: g}
	if p := Run(context.Background(), gp, pl.New(&bytes.Buffer{})); p != PowerOff || g.power == nil || *g.power != PowerOff {
		t.Errorf("panic at start ended with %v", p)
	}
}

type panicStart struct{ *fakeMachine }

func (p *panicStart) StartEntrypoint([]byte) (int, error) { panic("start") }
