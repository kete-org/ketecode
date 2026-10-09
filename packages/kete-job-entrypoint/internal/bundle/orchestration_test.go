package bundle

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

func file(path string, size int) entry {
	return entry{ManifestEntry: ManifestEntry{Path: path, Mode: "100644"}, data: make([]byte, size)}
}

func TestOrchestrationRule(t *testing.T) {
	plan := file(orchestration.PlanPath, 100)
	code := file("src/a.ts", 10)

	// A coordinator turn with the plan file: exactly that file is published.
	got, notes, err := applyOrchestration([]entry{code, plan}, KindCoordinator)
	if err != nil || len(got) != 1 || got[0].Path != orchestration.PlanPath {
		t.Fatalf("plan bundle %v, %v", got, err)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "1 other change") {
		t.Errorf("notes %v", notes)
	}
	// Only the plan file: no note.
	if _, notes, err := applyOrchestration([]entry{plan}, KindCoordinator); err != nil || len(notes) != 0 {
		t.Errorf("notes %v, %v", notes, err)
	}
	// An executable or oversized plan file is refused.
	exec := plan
	exec.Mode = "100755"
	if _, _, err := applyOrchestration([]entry{exec}, KindCoordinator); err == nil {
		t.Error("an executable plan file accepted")
	}
	if _, _, err := applyOrchestration([]entry{file(orchestration.PlanPath, orchestration.PlanFileMaxBytes+1)}, KindCoordinator); err == nil {
		t.Error("an oversized plan file accepted")
	}
	// A coordinator without the plan file (an integration): the ordinary rule.
	if got, _, err := applyOrchestration([]entry{code}, KindCoordinator); err != nil || len(got) != 1 {
		t.Errorf("integration bundle %v, %v", got, err)
	}
	other := file(".Kete-Orchestration/x", 1)
	if _, _, err := applyOrchestration([]entry{code, other}, KindCoordinator); err == nil {
		t.Error("a coordinator's other bundle touching .kete-orchestration accepted")
	}
	// Every other bundle refuses .kete-orchestration, deletions included.
	for _, e := range []entry{plan, {ManifestEntry: ManifestEntry{Path: orchestration.PlanPath, Deleted: true}}, file("pkg/.kete-orchestration. /x", 1)} {
		_, _, err := applyOrchestration([]entry{code, e}, KindOther)
		if kind, _, ok := AsRefusal(err); !ok || kind != RefuseUnreadable {
			t.Errorf("%s: %v", e.Path, err)
		}
	}
	if got, _, err := applyOrchestration([]entry{code}, KindOther); err != nil || len(got) != 1 {
		t.Errorf("plain bundle %v, %v", got, err)
	}
}
