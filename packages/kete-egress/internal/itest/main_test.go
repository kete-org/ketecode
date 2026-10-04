//go:build integration && linux

// Package itest runs the real kete-egress binary as the real proxy user, behind the real nftables
// rules, against fake HTTPS upstreams and a fake DNS server, with clients running as the real kete,
// tool, root and proxy users (module README "How to test"). scripts/integration.sh sets up the
// users and a fresh network namespace (so the rules never touch the host's or the CI runner's
// network) and runs this binary as root. It never runs in `go test ./...`.
//
// The binary plays two roles: the test process itself (root: the entrypoint and the internet),
// and a client re-executed as another uid (EGRESS_IT_CLIENT set; Go can't switch uid per
// goroutine), which runs one scenario and prints a JSON result.
package itest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type env struct {
	proxyUID, proxyGID uint32
	keteUID, keteGID   uint32
	toolUID, toolGID   uint32
	otherUID, otherGID uint32 // a fourth user the configuration doesn't name
	bin                string // the kete-egress binary
	work               string // world-traversable scratch directory
	self               string // this test binary
	testCA             string // PEM of the fake upstreams' CA (what SSL_CERT_FILE points at)
}

var E env
var W *world

func mustUint(name string) uint32 {
	v, err := strconv.ParseUint(os.Getenv(name), 10, 32)
	if err != nil {
		fmt.Fprintf(os.Stderr, "integration test requires %s (see scripts/integration.sh): %v\n", name, err)
		os.Exit(2)
	}
	return uint32(v)
}

func TestMain(m *testing.M) {
	if os.Getuid() != 0 {
		fmt.Fprintln(os.Stderr, "the integration suite must run as root (scripts/integration.sh)")
		os.Exit(2)
	}
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	E = env{
		proxyUID: mustUint("EGRESS_IT_PROXY_UID"), proxyGID: mustUint("EGRESS_IT_PROXY_GID"),
		keteUID: mustUint("EGRESS_IT_KETE_UID"), keteGID: mustUint("EGRESS_IT_KETE_GID"),
		toolUID: mustUint("EGRESS_IT_TOOL_UID"), toolGID: mustUint("EGRESS_IT_TOOL_GID"),
		otherUID: mustUint("EGRESS_IT_OTHER_UID"), otherGID: mustUint("EGRESS_IT_OTHER_GID"),
		bin: os.Getenv("EGRESS_IT_BIN"), work: os.Getenv("EGRESS_IT_WORK"), self: self,
	}
	if E.bin == "" || E.work == "" {
		fmt.Fprintln(os.Stderr, "EGRESS_IT_BIN and EGRESS_IT_WORK are required")
		os.Exit(2)
	}
	W, err = startWorld()
	if err != nil {
		fmt.Fprintln(os.Stderr, "start fakes:", err)
		os.Exit(2)
	}
	if err := applyRules(); err != nil {
		fmt.Fprintln(os.Stderr, "apply rules:", err)
		os.Exit(2)
	}
	code := m.Run()
	_ = exec.Command("nft", "delete", "table", "inet", "kete_egress").Run()
	W.close()
	os.Exit(code)
}

// baseConfig is the configuration every test starts from; limits are added per test.
func baseConfig(limits map[string]any) map[string]any {
	c := map[string]any{
		"version":   1,
		"uids":      map[string]any{"proxy": E.proxyUID, "kete": E.keteUID, "tool": E.toolUID},
		"ports":     map[string]any{"kete": portA, "tool": portB, "root": portR},
		"resolvers": []string{dnsAddr, dnsAddrV6},
		"phases": map[string]any{
			"clone":  map[string]any{"root": []string{"github.test"}},
			"agent":  map[string]any{"kete": []string{"gateway.test", "platform.test", "front.test", "evil.test", "internal.test", "v6only.test"}, "tool": []string{"registry.npm.test"}, "root": []string{"platform.test"}},
			"report": map[string]any{"root": []string{"platform.test", "storage.test"}},
		},
		"registries": []any{map[string]any{"host": "registry.npm.test", "kind": "npm"}},
	}
	if limits != nil {
		c["limits"] = limits
	}
	return c
}

func writeConfig(c map[string]any) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	f, err := os.CreateTemp(E.work, "config-*.json")
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = f.Write(b)
	return f.Name(), err
}

// applyRules installs the ruleset exactly as the entrypoint will:
// `kete-egress nft --config <file> | nft -f -`, then checks it with `nft list table`.
func applyRules() error {
	path, err := writeConfig(baseConfig(nil))
	if err != nil {
		return err
	}
	cmd := exec.Command("sh", "-c", fmt.Sprintf("%s nft --config %s | nft -f -", E.bin, path))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	out, err := exec.Command("nft", "list", "table", "inet", "kete_egress").CombinedOutput()
	if err != nil || !bytes.Contains(out, []byte("jump proxy_out")) {
		return fmt.Errorf("nft list: %v: %s", err, out)
	}
	return nil
}

func removeRules(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("nft", "delete", "table", "inet", "kete_egress").CombinedOutput(); err != nil {
		t.Fatalf("delete table: %v: %s", err, out)
	}
	t.Cleanup(func() {
		if err := applyRules(); err != nil {
			t.Fatalf("re-apply rules: %v", err)
		}
	})
}

// tempPath is a fresh path in the world-traversable work directory.
func tempPath(t *testing.T, pattern string) string {
	t.Helper()
	f, err := os.CreateTemp(E.work, pattern)
	if err != nil {
		t.Fatal(err)
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	t.Cleanup(func() { _ = os.Remove(name) })
	return name
}

func writePublic(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(E.work, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}
