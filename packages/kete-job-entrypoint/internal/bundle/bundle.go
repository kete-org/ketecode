// Package bundle builds the change bundle with the safe reader (ADR 0021 rules 5-6; module README
// "Bundle"): git lists paths against the pristine git-dir only, root opens every path one
// component at a time with O_NOFOLLOW from an anchored fd, reads only regular files, and writes a
// deterministic gzip tar of `manifest.json` (a JSON array) and `files/<path>`. It runs only after
// every job process is gone, and is still written as if something could race it.
package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

// Result is a built bundle.
type Result struct {
	Path     string // the .tar.gz
	Size     int64
	Manifest []ManifestEntry
	Notes    []string // fixed messages for an events call (never a path)
	dir      string
}

// Cleanup removes the temporary directory.
func (r *Result) Cleanup() {
	if r != nil && r.dir != "" {
		_ = os.RemoveAll(r.dir)
	}
}

// Refusal is a finish push_error.
type Refusal string

const (
	RefuseSymlink    Refusal = "symlink"
	RefuseUnreadable Refusal = "unreadable"
)

// Limits mirror ADR 0021 rule 6, so a bundle the platform must refuse is never built.
type Limits struct {
	MaxFile       int64
	MaxBinaryFile int64
	MaxBinaries   int
	MaxEntries    int
	MaxTar        int64
	MaxGzip       int64
	MaxUntracked  int
}

// ManifestEntry is one manifest item.
type ManifestEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

// entry is a manifest item plus its content.
type entry struct {
	ManifestEntry
	data   []byte
	binary bool
}

// refusal is an error carrying a Refusal and a fixed note (never a path or content).
type refusal struct {
	kind Refusal
	note string
}

func (r *refusal) Error() string { return string(r.kind) + ": " + r.note }

func refuse(kind Refusal, note string) error { return &refusal{kind: kind, note: note} }

// Refuse builds a refusal (for callers' tests).
func Refuse(kind Refusal, note string) error { return refuse(kind, note) }

// AsRefusal unwraps a refusal.
func AsRefusal(err error) (Refusal, string, bool) {
	var r *refusal
	if errors.As(err, &r) {
		return r.kind, r.note, true
	}
	return "", "", false
}

// BlobSHA is git's SHA-1 of a blob.
func BlobSHA(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// IsBinary is git's heuristic: a NUL in the first 8,000 bytes.
func IsBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	return bytes.IndexByte(data[:n], 0) >= 0
}

// CheckPath is path hygiene before any open: valid UTF-8, no NUL, relative, no empty, "." or ".."
// component, ≤ 4,096 bytes with components ≤ 255.
func CheckPath(p string) error {
	if p == "" || len(p) > 4096 || !utf8.ValidString(p) || strings.ContainsRune(p, 0) || strings.HasPrefix(p, "/") {
		return refuse(RefuseUnreadable, "a path can't be represented")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || r == '\\' {
			return refuse(RefuseUnreadable, "a path can't be represented")
		}
	}
	for _, c := range strings.Split(p, "/") {
		if c == "" || c == "." || c == ".." || len(c) > 255 {
			return refuse(RefuseUnreadable, "a path can't be represented")
		}
	}
	return nil
}

func modeOf(exec bool) string {
	if exec {
		return "100755"
	}
	return "100644"
}

// ctxReader fails every Read once ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// countingWriter counts bytes and fails past a limit.
type countingWriter struct {
	w     io.Writer
	n     int64
	limit int64
	note  string
}

func (c *countingWriter) Write(p []byte) (int, error) {
	if c.n+int64(len(p)) > c.limit {
		return 0, refuse(RefuseUnreadable, c.note)
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

var epoch = time.Unix(0, 0)

// header is the fixed tar header of a regular file: mode 0644, uid/gid 0, no names, mtime 0.
// USTAR when the name fits, else PAX with only a path record (archive/tar picks that).
func header(name string, size int64) *tar.Header {
	return &tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: 0o644, Size: size, ModTime: epoch}
}

// limitChecks applies the per-entry and count limits.
func limitChecks(entries []entry, lim Limits) error {
	if len(entries) > lim.MaxEntries {
		return refuse(RefuseUnreadable, "too many changed files")
	}
	binaries := 0
	var total int64
	for _, e := range entries {
		if e.binary {
			binaries++
		}
		total += int64(len(e.data))
	}
	if binaries > lim.MaxBinaries {
		return refuse(RefuseUnreadable, "too many binary files")
	}
	if total > lim.MaxTar {
		return refuse(RefuseUnreadable, "bundle too large")
	}
	return nil
}

// checkContent applies the per-file size limits.
func checkContent(data []byte, lim Limits) (binary bool, err error) {
	if int64(len(data)) > lim.MaxFile {
		return false, refuse(RefuseUnreadable, "a changed file is too large")
	}
	binary = IsBinary(data)
	if binary && int64(len(data)) > lim.MaxBinaryFile {
		return true, refuse(RefuseUnreadable, "a changed binary file is too large")
	}
	return binary, nil
}

// WriteTar writes the gzip tar of entries (sorted here by path bytes) to w, enforcing the tar and
// gzip size limits exactly.
func writeTar(w io.Writer, entries []entry, lim Limits) ([]ManifestEntry, error) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	manifest := make([]ManifestEntry, 0, len(entries))
	for _, e := range entries {
		manifest = append(manifest, e.ManifestEntry)
	}
	mj, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	gzOut := &countingWriter{w: w, limit: lim.MaxGzip, note: "bundle too large (compressed)"}
	gz, err := gzip.NewWriterLevel(gzOut, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	tarOut := &countingWriter{w: gz, limit: lim.MaxTar, note: "bundle too large"}
	tw := tar.NewWriter(tarOut)
	add := func(name string, data []byte) error {
		if err := tw.WriteHeader(header(name, int64(len(data)))); err != nil {
			return err
		}
		_, err := tw.Write(data)
		return err
	}
	if err := add("manifest.json", mj); err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.Deleted {
			continue
		}
		if err := add("files/"+e.Path, e.data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return manifest, nil
}

// Kind is the orchestrations-v1 bundle rule a build applies (checkOrchestrationBundle).
type Kind int

const (
	// KindOther is every bundle but a coordinator turn's: any path component that folds to
	// `.kete-orchestration` is refused, deletions included.
	KindOther Kind = iota
	// KindPlan is a coordinator turn that has a standing proposal (the runtime recorded it in
	// state the job's tools can't write, and no decision followed): the bundle is exactly the plan
	// file, whose SHA-256 must be the proposal's plan_digest; anything else is left out.
	KindPlan
	// KindCoordinator is a coordinator turn without a standing proposal (it decided, or never
	// planned): a `.kete-orchestration` path is left out (a plan file nobody proposed, written
	// by hand) and the rest — the integration — is published under KindOther's rule.
	KindCoordinator
)

// Rule is a build's orchestration rule: its Kind and, for KindPlan, the proposal's plan_digest.
type Rule struct {
	Kind       Kind
	PlanDigest string
}

// isOrchestrationPath reports a path with a component that folds to `.kete-orchestration`.
func isOrchestrationPath(e entry) bool {
	return orchestration.CheckBundle([]orchestration.BundleEntry{{Path: e.Path, Deleted: e.Deleted, Mode: e.Mode}}, orchestration.BundleOther) != ""
}

// applyOrchestration applies the orchestration rule to the listed changes: it returns the entries
// to bundle and fixed notes; a refusal is an unreadable refusal with a fixed note. This rule, not
// the runtime's edit-permission deny (which a shell command can bypass), is what keeps code off a
// plan branch: a plan bundle is exactly the proposed plan file.
func applyOrchestration(entries []entry, rule Rule) ([]entry, []string, error) {
	switch rule.Kind {
	case KindPlan:
		for _, e := range entries {
			if e.Path != orchestration.PlanPath || e.Deleted {
				continue
			}
			view := []orchestration.BundleEntry{{Path: e.Path, Mode: e.Mode, Size: int64(len(e.data))}}
			if r := orchestration.CheckBundle(view, orchestration.BundlePlan); r != "" {
				return nil, nil, refuse(RefuseUnreadable, "the plan bundle was refused ("+string(r)+")")
			}
			if orchestration.SHA256Hex(e.data) != rule.PlanDigest {
				return nil, nil, refuse(RefuseUnreadable, "the plan file is not the one the platform accepted")
			}
			var notes []string
			if n := len(entries) - 1; n > 0 {
				notes = append(notes, fmt.Sprintf("plan turn: only the plan file is published; %d other change(s) left out", n))
			}
			return []entry{e}, notes, nil
		}
		return nil, nil, refuse(RefuseUnreadable, "a plan turn without its plan file")
	case KindCoordinator:
		kept := make([]entry, 0, len(entries))
		for _, e := range entries {
			if !isOrchestrationPath(e) {
				kept = append(kept, e)
			}
		}
		var notes []string
		if n := len(entries) - len(kept); n > 0 {
			notes = append(notes, fmt.Sprintf("coordinator turn without a standing plan proposal: %d .kete-orchestration change(s) left out", n))
		}
		return kept, notes, nil
	}
	for _, e := range entries {
		if isOrchestrationPath(e) {
			return nil, nil, refuse(RefuseUnreadable, "a change touches .kete-orchestration (orchestration_path)")
		}
	}
	return entries, nil, nil
}
