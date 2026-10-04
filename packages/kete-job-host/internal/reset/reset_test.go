package reset

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
)

func TestDetectRefuses(t *testing.T) {
	dir := t.TempDir()
	if a, err := detect(filepath.Join(dir, "tpmrm0")); a != nil || !errors.Is(err, ErrNoTPM) {
		t.Fatalf("no device: %v %v", a, err)
	}
	f := filepath.Join(dir, "file")
	if err := os.WriteFile(f, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if a, err := detect(f); a != nil || !errors.Is(err, ErrNoTPM) {
		t.Fatalf("regular file: %v %v", a, err)
	}
	// A character device (any will do) still gets no attestor: R2 isn't implemented.
	if a, err := detect("/dev/null"); a != nil || !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("char device: %v %v", a, err)
	}
	if a, err := Detect(); a != nil || err == nil {
		t.Fatalf("Detect: %v %v", a, err)
	}
}

func TestConfigRefusesMeasuredBoot(t *testing.T) {
	_, err := config.Parse([]byte(`{"platform_url":"https://portal.kete.example","driver":"dedicated","slots":1,"reset":"measured_boot","generation":"g-1","image_allowlist":[],"versions":{}}`))
	if err == nil {
		t.Fatal("measured_boot accepted")
	}
}
