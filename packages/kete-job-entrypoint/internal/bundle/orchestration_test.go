package bundle

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

func file(path string, data string) entry {
	return entry{ManifestEntry: ManifestEntry{Path: path, Mode: "100644"}, data: []byte(data)}
}

func TestOrchestrationRule(t *testing.T) {
	planText := `{"plan":1}`
	plan := file(orchestration.PlanPath, planText)
	code := file("src/a.ts", "x")
	proposed := Rule{Kind: KindPlan, PlanDigest: orchestration.SHA256Hex([]byte(planText))}

	// A standing proposal: exactly the plan file, the other change left out with a note.
	got, notes, err := applyOrchestration([]entry{code, plan}, proposed)
	if err != nil || len(got) != 1 || got[0].Path != orchestration.PlanPath {
		t.Fatalf("plan bundle %v, %v", got, err)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "1 other change") {
		t.Errorf("notes %v", notes)
	}
	// A plan file other than the proposal's, an executable or oversized one, or none: refused.
	for name, es := range map[string][]entry{
		"another plan": {file(orchestration.PlanPath, `{"plan":2}`)},
		"executable":   {{ManifestEntry: ManifestEntry{Path: orchestration.PlanPath, Mode: "100755"}, data: []byte(planText)}},
		"oversized":    {file(orchestration.PlanPath, strings.Repeat("a", orchestration.PlanFileMaxBytes+1))},
		"missing":      {code},
	} {
		if _, _, err := applyOrchestration(es, proposed); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// No standing proposal (decided, or never planned): .kete-orchestration is left out, the
	// integration kept — a plan file written by hand never turns it into a plan bundle.
	got, notes, err = applyOrchestration([]entry{code, plan, file(".Kete-Orchestration./x", "y")}, Rule{Kind: KindCoordinator})
	if err != nil || len(got) != 1 || got[0].Path != "src/a.ts" || len(notes) != 1 || !strings.Contains(notes[0], "2 .kete-orchestration") {
		t.Errorf("integration bundle %v %v %v", got, notes, err)
	}
	// Every other bundle refuses .kete-orchestration, deletions included.
	for _, e := range []entry{plan, {ManifestEntry: ManifestEntry{Path: orchestration.PlanPath, Deleted: true}}, file("pkg/.kete-orchestration. /x", "1")} {
		_, _, err := applyOrchestration([]entry{code, e}, Rule{})
		if kind, _, ok := AsRefusal(err); !ok || kind != RefuseUnreadable {
			t.Errorf("%s: %v", e.Path, err)
		}
	}
	if got, _, err := applyOrchestration([]entry{code}, Rule{}); err != nil || len(got) != 1 {
		t.Errorf("plain bundle %v, %v", got, err)
	}
}
