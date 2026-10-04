package reqlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// buf is a concurrency-safe fake fd 6.
type buf struct {
	mu  sync.Mutex
	b   bytes.Buffer
	err error
}

func (w *buf) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return 0, w.err
	}
	return w.b.Write(p)
}

func (w *buf) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.String()
}

func entry() Entry {
	return Entry{Phase: "agent", User: "tool", Port: 82, Method: "GET", Host: "registry.npmjs.org", Path: "/left-pad", Status: 200, RespBytes: 1234}
}

func TestLineFormat(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 1_000_000, nil)
	if err := writeNow(l, entry()); err != nil {
		t.Fatal(err)
	}
	out := w.String()
	if !strings.HasSuffix(out, "\n") || strings.Count(out, "\n") != 1 {
		t.Fatalf("not one line: %q", out)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]any{"v": 1.0, "phase": "agent", "user": "tool", "port": 82.0, "method": "GET", "host": "registry.npmjs.org", "path": "/left-pad", "status": 200.0, "req_bytes": 0.0, "resp_bytes": 1234.0} {
		if m[k] != want {
			t.Errorf("%s = %v, want %v", k, m[k], want)
		}
	}
	if _, ok := m["reason"]; ok {
		t.Error("reason present on a success line")
	}
	if ts, _ := m["ts"].(string); len(ts) != len("2026-09-30T12:34:56.789Z") || !strings.HasSuffix(ts, "Z") {
		t.Errorf("ts = %q", ts)
	}
	if l.Written() != int64(len(out)) {
		t.Errorf("Written = %d, file = %d", l.Written(), len(out))
	}
}

func TestPathCutAndWorstCaseFits(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 1_000_000, nil)
	e := entry()
	e.Path = "/" + strings.Repeat("<", 5000) // each '<' escapes to <
	e.Host = strings.Repeat("\"\\\x00", 200) // hostile, never escaped
	e.Method = strings.Repeat("M", 100)      // too long
	e.Reason = "unsupported_method"
	e.ReqBytes, e.RespBytes, e.Status = 1<<62, 1<<62, 999
	if err := writeNow(l, e); err != nil {
		t.Fatal(err)
	}
	out := w.String()
	if len(out) > MaxLine {
		t.Fatalf("line is %d bytes > MaxLine %d", len(out), MaxLine)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	if p := m["path"].(string); len(p) != MaxPath {
		t.Errorf("path is %d bytes, want %d", len(p), MaxPath)
	}
	if h := m["host"].(string); strings.ContainsAny(h, "\"\\\x00") || len(h) > 253 {
		t.Errorf("host not cleaned: %q", h)
	}
	if m["method"] != "INVALID" {
		t.Errorf("method = %v", m["method"])
	}
}

func TestCapNeverExceededConcurrently(t *testing.T) {
	const limit = 64 * 1024
	w := &buf{}
	var fatal atomic.Int32
	l := New(w, 0, limit, func(error) { fatal.Add(1) })
	var ok, refused atomic.Int64
	var wg sync.WaitGroup
	for g := 0; g < 32; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				r, err := l.Reserve(true)
				if err != nil {
					refused.Add(1)
					continue
				}
				ok.Add(1)
				e := entry()
				e.Path = "/" + strings.Repeat("x", i%300)
				if i%7 == 0 {
					r.Release()
				} else {
					r.Write(e)
				}
			}
		}()
	}
	wg.Wait()
	out := w.String()
	if len(out) > limit {
		t.Fatalf("file is %d bytes > cap %d", len(out), limit)
	}
	if !l.Full() || refused.Load() == 0 {
		t.Fatalf("log never filled (ok=%d refused=%d)", ok.Load(), refused.Load())
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	last := lines[len(lines)-1]
	if !strings.Contains(last, `"log_full":true`) {
		t.Errorf("last line isn't the marker: %q", last)
	}
	if strings.Count(out, "log_full") != 1 {
		t.Errorf("marker written %d times", strings.Count(out, "log_full"))
	}
	for _, ln := range lines {
		if !json.Valid([]byte(ln)) {
			t.Fatalf("invalid line %q", ln)
		}
	}
	if fatal.Load() != 0 {
		t.Error("fatal called")
	}
	if _, err := l.Reserve(true); !errors.Is(err, ErrFull) {
		t.Error("Reserve after full succeeded")
	}
	if err := writeNow(l, entry()); !errors.Is(err, ErrFull) {
		t.Error("WriteNow after full succeeded")
	}
	if len(w.String()) != len(out) {
		t.Error("something was written after the marker")
	}
}

func TestMarkerWaitsForInFlight(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 2*MaxLine+MarkerLen, nil)
	r1, err := l.Reserve(true)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := l.Reserve(true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve(true); err == nil {
		t.Fatal("third reservation fit")
	}
	if w.String() != "" {
		t.Fatal("marker written while lines are in flight")
	}
	r1.Write(entry())
	if strings.Contains(w.String(), "log_full") {
		t.Fatal("marker written before the last in-flight line")
	}
	r2.Write(entry())
	out := w.String()
	if strings.Count(out, "\n") != 3 || !strings.HasSuffix(strings.TrimSuffix(out, "\n"), `"log_full":true}`) {
		t.Errorf("file = %q", out)
	}
	// Double completion is harmless.
	r2.Write(entry())
	r1.Release()
	if w.String() != out {
		t.Error("second completion wrote again")
	}
}

func TestStartOffsetCounts(t *testing.T) {
	w := &buf{}
	l := New(w, 5000, 5000+MaxLine+MarkerLen, nil)
	if err := writeNow(l, entry()); err != nil {
		t.Fatalf("one line should fit: %v", err)
	}
	if _, err := l.Reserve(true); err == nil {
		t.Fatal("second line fit past the cap")
	}
	if int64(len(w.String()))+5000 > 5000+MaxLine+MarkerLen {
		t.Fatal("cap exceeded")
	}
	// A file that already starts at the cap is full at once and gets no marker.
	w2 := &buf{}
	l2 := New(w2, 10_000, 10_000, nil)
	if _, err := l2.Reserve(true); err == nil {
		t.Fatal("reserve on a full file")
	}
	if w2.String() != "" {
		t.Fatalf("wrote %q past the cap", w2.String())
	}
}

func TestWriteErrorIsFatal(t *testing.T) {
	w := &buf{err: errors.New("ENOSPC")}
	var got error
	l := New(w, 0, 1_000_000, func(err error) { got = err })
	r, err := l.Reserve(true)
	if err != nil {
		t.Fatal(err)
	}
	r.Write(entry())
	if got == nil {
		t.Fatal("fatal not called on a write error")
	}
	if _, err := l.Reserve(true); err == nil {
		t.Error("Reserve after a write error succeeded")
	}
	if !l.Full() {
		t.Error("a failed log isn't refusing")
	}
}

func writeNow(l *Log, e Entry) error {
	r, err := l.Reserve(true)
	if err != nil {
		return err
	}
	r.Write(e)
	return nil
}

// A job user can't use the last RootShare of the cap: root keeps logging (and so working) after
// the job users' part is exhausted.
func TestRootShare(t *testing.T) {
	const limit = 100_000
	if RootShare(limit) != 10_000 || RootShare(10_000_000) != 1_000_000 || RootShare(100_000_000) != MaxRootShare {
		t.Fatal("RootShare")
	}
	w := &buf{}
	l := New(w, 0, limit, nil)
	job := 0
	for {
		r, err := l.Reserve(false)
		if err != nil {
			break
		}
		r.Write(entry())
		job++
	}
	if strings.Count(w.String(), `"job_log_full":true`) != 1 || !l.JobFull() {
		t.Fatalf("job_log_full marker missing when the job share filled: %q", w.String())
	}
	if _, err := l.Reserve(false); err == nil || strings.Count(w.String(), "job_log_full") != 1 {
		t.Fatal("job marker written twice")
	}
	if job == 0 || !l.FullFor(false) || l.FullFor(true) || l.Full() {
		t.Fatalf("after the job share: job=%d FullFor(false)=%v FullFor(true)=%v Full=%v", job, l.FullFor(false), l.FullFor(true), l.Full())
	}
	if l.Written()+MaxLine+MarkerLen+RootShare(limit) <= limit {
		t.Fatalf("job users stopped early at %d", l.Written())
	}
	root := 0
	for {
		r, err := l.Reserve(true)
		if err != nil {
			break
		}
		r.Write(entry())
		root++
	}
	if root == 0 {
		t.Fatal("root got no room after the job users filled their share")
	}
	if !l.Full() || len(w.String()) > limit || !strings.HasSuffix(strings.TrimSpace(w.String()), `"log_full":true}`) {
		t.Errorf("full=%v size=%d", l.Full(), len(w.String()))
	}
	if _, err := l.Reserve(false); err == nil {
		t.Error("job reservation after full")
	}
}

// A refusal flood on one port is rate-limited and can't use root's share or other ports' budget.
func TestRefusalRateLimit(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 1_000_000, nil)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	const toolPort, rootPort = 82, 83
	for i := 0; i < 10_000; i++ {
		if err := l.Refusal(toolPort, false, entry()); err != nil {
			t.Fatal(err)
		}
	}
	lines := strings.Count(w.String(), "\n")
	// The first (port, reason, host) line bypasses the bucket; then the burst.
	if lines != int(RefusalBurst)+1 {
		t.Fatalf("%d refusal lines from a flood, want the burst %d + 1", lines, int(RefusalBurst))
	}
	// Other ports keep their own budget.
	if err := l.Refusal(rootPort, true, entry()); err != nil || strings.Count(w.String(), "\n") != lines+1 {
		t.Fatal("root's refusal line was suppressed by the tool port's flood")
	}
	// After a refill, the next tool line carries the suppressed count.
	now = now.Add(time.Second)
	if err := l.Refusal(toolPort, false, entry()); err != nil {
		t.Fatal(err)
	}
	all := strings.Split(strings.TrimSpace(w.String()), "\n")
	var m map[string]any
	_ = json.Unmarshal([]byte(all[len(all)-1]), &m)
	if m["suppressed"] != float64(10_000-RefusalBurst-1) {
		t.Errorf("suppressed = %v", m["suppressed"])
	}
	// Root can still reserve for real requests.
	if _, err := l.Reserve(true); err != nil {
		t.Error("root refused after a tool flood")
	}
}

func lastLine(t *testing.T, w *buf) map[string]any {
	t.Helper()
	all := strings.Split(strings.TrimSpace(w.String()), "\n")
	var m map[string]any
	if err := json.Unmarshal([]byte(all[len(all)-1]), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// A new host probed behind a burst of noise still gets its first refusal line.
func TestFirstRefusalPerHostBypassesBucket(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 10_000_000, nil)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	noise := entry()
	noise.Host, noise.Reason = "noise.example", "host_not_allowed"
	for i := 0; i < 1000; i++ {
		_ = l.Refusal(82, false, noise)
	}
	before := strings.Count(w.String(), "\n")
	probe := entry()
	probe.Host, probe.Reason = "internal.example", "host_not_allowed"
	_ = l.Refusal(82, false, probe)
	if strings.Count(w.String(), "\n") != before+1 || lastLine(t, w)["host"] != "internal.example" {
		t.Fatal("the probe's first refusal was rate-limited away")
	}
	_ = l.Refusal(82, false, probe) // its second one is not
	if strings.Count(w.String(), "\n") != before+1 {
		t.Fatal("a repeated refusal bypassed the bucket")
	}
	// The bypass is bounded: at most MaxFirstSeen distinct combinations in all.
	for i := 0; i < 2*MaxFirstSeen; i++ {
		e := entry()
		e.Host, e.Reason = fmt.Sprintf("h%d.example", i), "host_not_allowed"
		_ = l.Refusal(82, false, e)
	}
	lines := strings.Count(w.String(), "\n")
	if want := int(RefusalBurst) + MaxFirstSeen; lines != want {
		t.Errorf("%d lines, want %d (burst + %d first-seen)", lines, want, MaxFirstSeen)
	}
}

func TestFlushSuppressed(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 10_000_000, nil)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 500; i++ {
		e := entry()
		e.Port, e.User = 82, "tool"
		_ = l.Refusal(82, false, e)
	}
	for i := 0; i < 70; i++ {
		e := entry()
		e.Port, e.User = 81, "kete"
		_ = l.Refusal(81, false, e)
	}
	l.FlushSuppressed()
	var summaries []map[string]any
	for _, ln := range strings.Split(strings.TrimSpace(w.String()), "\n") {
		var m map[string]any
		_ = json.Unmarshal([]byte(ln), &m)
		if m["reason"] == ReasonSuppressedSummary {
			summaries = append(summaries, m)
		}
	}
	if len(summaries) != 2 {
		t.Fatalf("%d summary lines, want 2", len(summaries))
	}
	want := map[float64]float64{81: 70 - RefusalBurst - 1, 82: 500 - RefusalBurst - 1}
	for _, m := range summaries {
		if m["suppressed"] != want[m["port"].(float64)] {
			t.Errorf("summary %v", m)
		}
	}
	size := len(w.String())
	l.FlushSuppressed()
	if len(w.String()) != size {
		t.Error("second flush wrote again")
	}
}

// The summary uses root's share: it's written even when the job users' part is full.
func TestFlushSuppressedUsesRootShare(t *testing.T) {
	w := &buf{}
	l := New(w, 0, 100_000, nil)
	now := time.Unix(1_700_000_000, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 200; i++ {
		_ = l.Refusal(82, false, entry())
	}
	for {
		r, err := l.Reserve(false)
		if err != nil {
			break
		}
		r.Write(entry())
	}
	// Refusals while the job share is full can't be written; they're counted instead.
	for i := 0; i < 5; i++ {
		e := entry()
		e.Host = fmt.Sprintf("new%d.example", i) // first-seen: would bypass the bucket
		if err := l.Refusal(82, false, e); err == nil {
			t.Fatal("refusal line written into a full job share")
		}
	}
	l.FlushSuppressed()
	m := lastLine(t, w)
	if m["reason"] != ReasonSuppressedSummary || m["suppressed"] != float64(200-RefusalBurst-1+5) {
		t.Errorf("last line %v", m)
	}
}
