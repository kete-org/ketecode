package outbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/job"
)

func TestPutAndCommit(t *testing.T) {
	dir := t.TempDir()
	if err := Prepare(dir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	d := Dir{Path: dir, UID: os.Getuid(), GID: os.Getgid()}
	f, err := d.Put("result.json", strings.NewReader(`{"version":1}`), 100)
	if err != nil || f.Size != 13 || len(f.SHA256) != 64 {
		t.Fatalf("put: %+v %v", f, err)
	}
	if _, err := d.Put("result.json", strings.NewReader("x"), 100); err == nil {
		t.Error("an existing file was overwritten")
	}
	if _, err := d.Put("big", strings.NewReader("0123456789"), 5); err == nil {
		t.Error("a file over its limit was written")
	}
	if _, err := os.Lstat(filepath.Join(dir, "big")); !os.IsNotExist(err) {
		t.Error("the over-limit file was left behind")
	}
	if _, err := d.Put("../escape", strings.NewReader("x"), 5); err == nil {
		t.Error("a path name was accepted")
	}
	m := job.OutboxManifest{Version: 1, JobID: "j", Files: map[string]job.OutboxFile{"result": f}, Notes: []string{}}
	if err := d.Commit(m); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, ManifestName))
	var back job.OutboxManifest
	if err != nil || json.Unmarshal(b, &back) != nil || back.Files["result"].SHA256 != f.SHA256 {
		t.Errorf("manifest %s %v", b, err)
	}
	st, _ := os.Stat(filepath.Join(dir, "result.json"))
	if st.Mode().Perm() != 0o640 {
		t.Errorf("mode %v", st.Mode())
	}
	// A manifest naming a file that isn't as written is refused.
	m.Files["result"] = job.OutboxFile{Name: "result.json", Size: 99}
	if err := d.Commit(m); err == nil {
		t.Error("a wrong manifest was committed")
	}
}

func TestPrepareRefusesANonEmptyVolume(t *testing.T) {
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "lost+found"), 0o700)
	if err := Prepare(dir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatalf("lost+found alone: %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, "stale"), nil, 0o600)
	if err := Prepare(dir, os.Getuid(), os.Getgid()); err != ErrNotEmpty {
		t.Errorf("err %v, want ErrNotEmpty", err)
	}
}
