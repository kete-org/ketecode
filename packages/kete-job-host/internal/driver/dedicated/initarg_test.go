package dedicated

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// TestInitArgMatchesEntrypointGuard: the job entrypoint's shared-kernel guard requires PID 1's
// argv[1] to be InitArg (kete-job-entrypoint hostprofile.DedicatedInitArg, a separate Go module,
// read here from its source). If the two differ, every dedicated job is refused.
func TestInitArgMatchesEntrypointGuard(t *testing.T) {
	src := filepath.Join("..", "..", "..", "..", "kete-job-entrypoint", "internal", "hostprofile", "kernel.go")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("the entrypoint's guard source (same repository): %v", err)
	}
	m := regexp.MustCompile(`(?m)^const DedicatedInitArg = "([^"]*)"$`).FindSubmatch(b)
	if m == nil {
		t.Fatalf("no `const DedicatedInitArg = \"...\"` line in %s", src)
	}
	if got := string(m[1]); got != InitArg {
		t.Fatalf("hostprofile.DedicatedInitArg = %q, dedicated.InitArg = %q: change both together", got, InitArg)
	}
}
