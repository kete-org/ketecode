// Package orchestration is the entrypoint's half of orchestrations-v1 (`docs/platform/
// orchestrations-v1.md`; kete-code-platform `packages/shared/src/api/v1/orchestrations.ts`, ADR
// 0026; kete-code ADR 0012): the plan-file reader and the proposal a file stands for, a worker's
// prompt read, the plan and node branch names, the plan-bundle rule and a node's commit message.
// Every function is checked against the shared vectors (docs/platform/test-vectors/
// orchestrations-v1/), so this side and the platform's agree byte for byte.
package orchestration

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validUTF8(b []byte) bool { return utf8.Valid(b) }

// JobBranchPrefix is every job branch's prefix.
const JobBranchPrefix = "kete/job/"

// PlanPath is the plan file, the plan branch's one file (ORCHESTRATION_PLAN_PATH).
const PlanPath = ".kete-orchestration/plan.json"

// Dir is the directory no bundle but a plan bundle may touch (ORCHESTRATION_DIR).
const Dir = ".kete-orchestration"

// ShortID is orchestrationShortId: the first 8 hex digits of the id.
func ShortID(id string) string {
	if len(id) < 8 {
		return id
	}
	return id[:8]
}

// PlanBranch is orchestrationPlanBranch: `kete/job/<o8>-plan-<rev>`.
func PlanBranch(id string, rev int64) string {
	return JobBranchPrefix + ShortID(id) + "-plan-" + strconv.FormatInt(rev, 10)
}

// NodeBranch is orchestrationNodeBranch: `kete/job/<o8>-<key>`.
func NodeBranch(id, key string) string { return JobBranchPrefix + ShortID(id) + "-" + key }

// --- bundles ---

// BundleEntry is a manifest entry as the rule sees it, with the file's decompressed size.
type BundleEntry struct {
	Path    string
	Deleted bool
	Mode    string
	Size    int64
}

// BundleKind says which rule applies: a plan turn's bundle, or every other one.
type BundleKind string

const (
	BundlePlan  BundleKind = "plan"
	BundleOther BundleKind = "other"
)

// BundleRefusal is OrchestrationBundleRefusal.
type BundleRefusal string

const (
	RefusePlanBundleShape   BundleRefusal = "plan_bundle_shape"
	RefusePlanFileTooLarge  BundleRefusal = "plan_file_too_large"
	RefuseOrchestrationPath BundleRefusal = "orchestration_path"
)

// hfsIgnorable is what HFS+ ignores when comparing names (the bundle validator's fold).
func hfsIgnorable(r rune) bool {
	return r >= 0x200C && r <= 0x200F || r >= 0x202A && r <= 0x202E || r >= 0x206A && r <= 0x206F || r == 0xFEFF
}

// fullUpper holds the special-casing (full) uppercase mappings JavaScript's toUpperCase applies
// whose result is plain ASCII letters — the only ones that can fold a component to
// `.kete-orchestration`. Go's unicode.ToUpper is the simple mapping and leaves these alone.
var fullUpper = map[rune]string{
	'ß': "SS", 'ﬀ': "FF", 'ﬁ': "FI", 'ﬂ': "FL", 'ﬃ': "FFI", 'ﬄ': "FFL", 'ﬅ': "ST", 'ﬆ': "ST",
}

// FoldComponent is the bundle validator's fold of one path component: strip HFS-ignorables and
// NTFS trailing dots and spaces, then case-fold (upper, then lower, as the platform does).
func FoldComponent(c string) string {
	c = strings.Map(func(r rune) rune {
		if hfsIgnorable(r) {
			return -1
		}
		return r
	}, c)
	c = strings.TrimRight(c, ". ")
	var b strings.Builder
	for _, r := range c {
		if s, ok := fullUpper[r]; ok {
			b.WriteString(s)
		} else {
			b.WriteRune(unicode.ToUpper(r))
		}
	}
	return strings.ToLower(b.String())
}

// CheckBundle is checkOrchestrationBundle, applied after the bundle validator's own rules. A plan
// bundle is exactly the plan file (spelled so, mode 100644, ≤ 256 KiB); every other bundle refuses
// any entry with a component that folds to `.kete-orchestration`, deletions included. "" is
// acceptable.
func CheckBundle(entries []BundleEntry, kind BundleKind) BundleRefusal {
	if kind == BundlePlan {
		if len(entries) != 1 || entries[0].Deleted || entries[0].Path != PlanPath || entries[0].Mode != "100644" {
			return RefusePlanBundleShape
		}
		if entries[0].Size > PlanFileMaxBytes {
			return RefusePlanFileTooLarge
		}
		return ""
	}
	dir := FoldComponent(Dir)
	for _, e := range entries {
		for _, c := range strings.Split(e.Path, "/") {
			if FoldComponent(c) == dir {
				return RefuseOrchestrationPath
			}
		}
	}
	return ""
}

// --- the handoff note ---

// SummaryMaxBytes is JOB_SUMMARY_MAX_BYTES: a note is cut to it.
const SummaryMaxBytes = 4096

// NodeCommit is orchestrationNodeCommitMessage's input.
type NodeCommit struct {
	JobID           string
	CIEnabled       bool
	OrchestrationID string
	Key             string
	Attempt         int
	Note            string // the attempt's result text, already redacted by the caller
}

// NodeCommitMessage is orchestrationNodeCommitMessage: the job's first line, the handoff note
// (control characters but newline and tab removed, CR/CRLF → LF, trimmed, cut to 4 KB at a UTF-8
// character boundary; absent when empty) and the trailers as the last paragraph.
func NodeCommitMessage(c NodeCommit) string {
	note := strings.ReplaceAll(c.Note, "\r\n", "\n")
	note = strings.ReplaceAll(note, "\r", "\n")
	note = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7F {
			return -1
		}
		return r
	}, strings.ToValidUTF8(note, ""))
	note = strings.TrimFunc(note, jsSpace)
	if len(note) > SummaryMaxBytes {
		end := SummaryMaxBytes
		for end > 0 && note[end]&0xC0 == 0x80 {
			end--
		}
		note = strings.TrimFunc(note[:end], jsSpace)
	}
	jobShort := c.JobID
	if len(jobShort) > 8 {
		jobShort = jobShort[:8]
	}
	head := "Kete job " + jobShort
	if !c.CIEnabled {
		head += " [skip ci]"
	}
	trailers := "Job: " + c.JobID + "\nOrchestration: " + c.OrchestrationID + "\nNode: " + c.Key + "\nAttempt: " + strconv.Itoa(c.Attempt)
	if note == "" {
		return head + "\n\n" + trailers
	}
	return head + "\n\n" + note + "\n\n" + trailers
}
