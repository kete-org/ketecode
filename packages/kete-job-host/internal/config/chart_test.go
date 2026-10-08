package config

import (
	"os"
	"testing"
)

// TestChartRenderedConfig parses the configuration the Helm chart renders (kete-runner.yml's chart
// job extracts config.json from `helm template` into KETE_RUNNER_RENDERED_CONFIG), so the chart and
// this parser can't drift apart. Skipped when the variable is unset.
func TestChartRenderedConfig(t *testing.T) {
	path := os.Getenv("KETE_RUNNER_RENDERED_CONFIG")
	if path == "" {
		t.Skip("KETE_RUNNER_RENDERED_CONFIG is not set")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(b); err != nil {
		t.Fatalf("the chart's rendered configuration is refused: %v", err)
	}
}
