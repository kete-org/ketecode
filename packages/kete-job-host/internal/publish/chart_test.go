package publish

import (
	"os"
	"testing"
)

// TestChartRenderedPublishConfig parses the publisher configuration the Helm chart renders
// (kete-runner.yml's chart job extracts publish.json from `helm template` into
// KETE_RUNNER_RENDERED_PUBLISH_CONFIG), so the chart and this parser can't drift apart. Skipped
// when the variable is unset.
func TestChartRenderedPublishConfig(t *testing.T) {
	path := os.Getenv("KETE_RUNNER_RENDERED_PUBLISH_CONFIG")
	if path == "" {
		t.Skip("KETE_RUNNER_RENDERED_PUBLISH_CONFIG is not set")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseConfig(b)
	if err != nil {
		t.Fatalf("the chart's rendered publisher configuration is refused: %v", err)
	}
	if len(c.Repos) == 0 {
		t.Fatal("no repository")
	}
}
