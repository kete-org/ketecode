package publish

// Reading a job's outbox (packages/kete-job-entrypoint internal/outbox, manifest v1) as hostile
// input: the job's root entrypoint wrote it, and a job VM compromised to root could have written
// anything instead. Only manifest.json and bundle.tar.gz are read; nothing is followed, executed
// or extracted; sizes and SHA-256 are checked against the manifest.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

const (
	manifestName = "manifest.json"
	maxManifest  = 64 << 10
)

// Manifest is the outbox's manifest.json (the entrypoint's job.OutboxManifest, version 1).
type Manifest struct {
	Version    int                     `json:"version"`
	JobID      string                  `json:"job_id"`
	Repository string                  `json:"repository"`
	Ref        string                  `json:"ref"`
	BaseSHA    string                  `json:"base_sha,omitempty"`
	Branch     string                  `json:"branch,omitempty"`
	Outcome    string                  `json:"outcome"`
	ExitCode   int                     `json:"exit_code"`
	PushError  string                  `json:"push_error,omitempty"`
	Files      map[string]ManifestFile `json:"files"`
	Notes      []string                `json:"notes"`
	WrittenAt  string                  `json:"written_at"`
}

// ManifestFile is one file the manifest names.
type ManifestFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

var (
	outboxNameRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
	sha256Re     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	outcomeRe    = regexp.MustCompile(`^[a-z_]{1,32}$`)
)

// errManifest: the manifest is missing, unreadable or doesn't describe this job.
var errManifest = errors.New("publish: the outbox manifest is missing or invalid")

// ReadManifest reads and checks manifest.json for this job, repository and ref.
func ReadManifest(dir, jobID, repo, ref string) (Manifest, error) {
	b, err := readSmall(filepath.Join(dir, manifestName), maxManifest)
	if err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", errManifest, err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", errManifest, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Manifest{}, fmt.Errorf("%w: trailing data", errManifest)
	}
	switch {
	case m.Version != 1, m.JobID != jobID, m.Repository != repo, m.Ref != ref,
		m.BaseSHA != "" && !contract.ValidGitSHA(m.BaseSHA),
		!outcomeRe.MatchString(m.Outcome), len(m.Files) > 8, len(m.Notes) > 32:
		return Manifest{}, fmt.Errorf("%w: it doesn't describe this job", errManifest)
	}
	for _, f := range m.Files {
		if !outboxNameRe.MatchString(f.Name) || f.Name == manifestName || f.Size < 0 || !sha256Re.MatchString(f.SHA256) {
			return Manifest{}, fmt.Errorf("%w: a file entry is invalid", errManifest)
		}
	}
	return m, nil
}

// errBundleFile: the bundle file isn't as the manifest says.
var errBundleFile = errors.New("publish: the bundle file doesn't match the manifest")

// ReadBundle reads the bundle the manifest names: a regular file (no symlink), its size as
// declared and at most the validator's compressed limit, its SHA-256 as declared.
func ReadBundle(dir string, f ManifestFile) ([]byte, error) {
	if f.Name != "bundle.tar.gz" || f.Size > bundle.MaxCompressed {
		return nil, errBundleFile
	}
	b, err := readSmall(filepath.Join(dir, f.Name), bundle.MaxCompressed)
	if err != nil || int64(len(b)) != f.Size {
		return nil, errBundleFile
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != f.SHA256 {
		return nil, errBundleFile
	}
	return b, nil
}
