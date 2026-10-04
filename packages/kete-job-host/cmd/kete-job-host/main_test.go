package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

func TestUsageAndVersion(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run(nil, nil, &out, &errb); code != 2 {
		t.Fatalf("no args: %d", code)
	}
	if code := run([]string{"version"}, nil, &out, &errb); code != 0 || strings.TrimSpace(out.String()) != version {
		t.Fatalf("version: %d %q", code, out.String())
	}
	if code := run([]string{"run", "--config", filepath.Join(t.TempDir(), "missing.json")}, nil, &out, &errb); code != 2 {
		t.Fatalf("missing config: %d", code)
	}
}

// TestRunRefusesWithoutDriver: `run` refuses to start rather than pretend (CLAUDE.md §10) when
// the firecracker driver has no firecracker section, or the dedicated driver has no resolvers.
func TestRunRefusesWithoutDriver(t *testing.T) {
	for name, c := range map[string]struct{ driver, want string }{
		"firecracker without its section": {`"driver":"firecracker","slots":1,"reset":"none","versions":{"firecracker":"1.17.0","guest_kernel":"6.18.55-kete.1"}`, "firecracker section"},
		"dedicated without resolvers":     {`"driver":"dedicated","slots":1,"reset":"provider_rebuild","generation":"g-1","versions":{}`, "resolvers"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := testroot.Dir(t)
			p := filepath.Join(dir, "config.json")
			cfg := `{"platform_url":"https://portal.kete.example",` + c.driver + `,"image_allowlist":[],"state_dir":"` + filepath.Join(dir, "state") + `"}`
			if err := os.WriteFile(p, []byte(cfg), 0o600); err != nil {
				t.Fatal(err)
			}
			var out, errb bytes.Buffer
			code := run([]string{"run", "--config", p}, nil, &out, &errb)
			if code != 2 || !strings.Contains(errb.String(), c.want) {
				t.Fatalf("code %d: %s", code, errb.String())
			}
		})
	}
}

// TestDoctorReportsConfigFile: doctor reports a config file it refuses instead of exiting 2.
func TestDoctorReportsConfigFile(t *testing.T) {
	dir := testroot.Dir(t)
	p := filepath.Join(dir, "config.json")
	_ = os.WriteFile(p, []byte(`{}`), 0o666)
	var out, errb bytes.Buffer
	if code := run([]string{"doctor", "--config", p}, nil, &out, &errb); code != 1 || !strings.Contains(out.String(), "FAIL config") {
		t.Fatalf("code %d: %s", code, out.String())
	}
}
