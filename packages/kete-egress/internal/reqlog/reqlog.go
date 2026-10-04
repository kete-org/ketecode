// Package reqlog is the proxy's request log (module README "Log format v1"): one JSON line per
// request or refusal — never headers, bodies or query strings — written to a root-owned,
// append-only file the proxy only holds an fd for, and capped so the file can never exceed the
// configured size, even with requests in flight.
//
// It fails closed. A request is forwarded only after Reserve has set aside room for its line
// (MaxLine) while always keeping room for the one final log_full marker (MarkerLen). When a
// reservation doesn't fit, the log is marked full, every later Reserve fails (the proxy answers
// 503), and the marker is written once the last in-flight line is. A write error is fatal: the
// proxy exits and the entrypoint sees proxy_failed.
//
// Two defences keep a job user from exhausting the log and so blocking root (whose requests
// report the job's result): the last RootShare of the cap is usable by root's port only, and
// refusal lines are rate-limited per port (a token bucket; suppressed lines are counted in the next
// refusal line written for that port).
package reqlog

import (
	"encoding/json"
	"errors"
	"io"
	"sort"
	"sync"
	"time"
)

const (
	// MaxLine bounds one encoded line: fixed fields (~270 bytes), a host of at most 253
	// bytes that never needs escaping, and a path cut to 256 bytes that JSON may expand at most
	// sixfold.
	MaxLine = 2560
	// MarkerLen is always kept free for the log_full marker.
	MarkerLen = 128
	// MaxPath is how much of a request path is logged.
	MaxPath = 256
	// maxHost is how much of a (possibly invalid) host is logged.
	maxHost = 253
	// maxMethod is how much of a method is logged.
	maxMethod = 16

	// MaxRootShare caps the part of the log reserved for root's port (1 MB of the default 10 MB).
	MaxRootShare = 1_000_000

	// Refusal lines per port: refill rate (lines per second) and burst.
	RefusalRate  = 10.0
	RefusalBurst = 50.0

	// MaxFirstSeen bounds the (port, reason, host) combinations whose first refusal line
	// bypasses the rate limit.
	MaxFirstSeen = 256

	// ReasonSuppressedSummary marks the shutdown line reporting a port's remaining suppressed
	// refusal count.
	ReasonSuppressedSummary = "suppressed_summary"
)

// RootShare is the part of a limit-byte log only root's port may use: a tenth, at most 1 MB.
func RootShare(limit int64) int64 {
	return min(limit/10, MaxRootShare)
}

// Entry is one request or refusal.
type Entry struct {
	Phase     string
	User      string
	Port      uint16
	Method    string
	Host      string
	Path      string
	Status    int
	ReqBytes  int64
	RespBytes int64
	Reason    string
	// Suppressed is how many earlier refusal lines for this port were rate-limited away.
	Suppressed int64
}

type line struct {
	V         int    `json:"v"`
	TS        string `json:"ts"`
	Phase     string `json:"phase"`
	User      string `json:"user"`
	Port      uint16 `json:"port"`
	Method    string `json:"method"`
	Host      string `json:"host"`
	Path      string `json:"path"`
	Status    int    `json:"status"`
	ReqBytes  int64  `json:"req_bytes"`
	RespBytes int64  `json:"resp_bytes"`
	Reason    string `json:"reason,omitempty"`
	Suppr     int64  `json:"suppressed,omitempty"`
}

type jobMarker struct {
	V          int    `json:"v"`
	TS         string `json:"ts"`
	JobLogFull bool   `json:"job_log_full"`
}

type marker struct {
	V       int    `json:"v"`
	TS      string `json:"ts"`
	LogFull bool   `json:"log_full"`
}

// ErrFull is returned by Reserve once the log is full (or has failed).
var ErrFull = errors.New("request log is full")

// Log is safe for concurrent use.
type Log struct {
	mu            sync.Mutex
	w             io.Writer
	limit         int64
	rootShare     int64
	jobFull       bool  // the non-root part is exhausted
	jobMarker     bool  // the one-time job_log_full marker has been written
	written       int64 // bytes in the file, including what was there at start
	reserved      int64
	outstanding   int
	full          bool
	markerWritten bool
	failed        bool
	fatal         func(error)
	now           func() time.Time
	buckets       map[int]*bucket
	firstSeen     map[firstKey]bool
}

type bucket struct {
	tokens     float64
	last       time.Time
	suppressed int64
	user       string // for the shutdown summary line
	port       uint16
	phase      string
}

type firstKey struct {
	port   int
	reason string
	host   string
}

// New wraps w (the fd-6 file, opened O_APPEND by root). start is the file's size at start-up;
// limit is the cap in bytes; fatal is called once, outside the lock, on the first write error.
func New(w io.Writer, start, limit int64, fatal func(error)) *Log {
	return &Log{w: w, limit: limit, rootShare: RootShare(limit), written: start, fatal: fatal, now: time.Now, buckets: map[int]*bucket{}, firstSeen: map[firstKey]bool{}}
}

// Reservation is room for one line. Exactly one of Write or Release must be called.
type Reservation struct {
	l    *Log
	done bool
}

// Reserve sets aside room for one line, or returns ErrFull. root is true only for root's port,
// which alone may use the last RootShare bytes.
func (l *Log) Reserve(root bool) (*Reservation, error) {
	l.mu.Lock()
	if l.full || l.failed || (!root && l.jobFull) {
		l.mu.Unlock()
		return nil, ErrFull
	}
	need := l.written + l.reserved + MaxLine + MarkerLen
	if !root && need+l.rootShare > l.limit {
		l.jobFull = true
		err := l.jobMarkerLocked()
		l.mu.Unlock()
		l.report(err)
		return nil, ErrFull
	}
	if need > l.limit {
		l.full, l.jobFull = true, true
		err := l.maybeMarkerLocked()
		l.mu.Unlock()
		l.report(err)
		return nil, ErrFull
	}
	l.reserved += MaxLine
	l.outstanding++
	l.mu.Unlock()
	return &Reservation{l: l}, nil
}

// Write writes the entry into the reserved room.
func (r *Reservation) Write(e Entry) {
	if r == nil || r.done {
		return
	}
	r.done = true
	b := encode(e, r.l.now())
	l := r.l
	l.mu.Lock()
	var err error
	if !l.failed {
		err = l.writeLocked(b)
	}
	l.reserved -= MaxLine
	l.outstanding--
	if err == nil {
		err = l.maybeMarkerLocked()
	}
	l.mu.Unlock()
	l.report(err)
}

// Release gives the room back without writing anything.
func (r *Reservation) Release() {
	if r == nil || r.done {
		return
	}
	r.done = true
	l := r.l
	l.mu.Lock()
	l.reserved -= MaxLine
	l.outstanding--
	err := l.maybeMarkerLocked()
	l.mu.Unlock()
	l.report(err)
}

// Refusal writes a refusal line for port key, subject to the per-port rate limit: when the port's
// bucket is empty the line is only counted, and the count goes into the next line written for that
// port. The first refusal of each (port, reason, host) — up to MaxFirstSeen of them — bypasses the
// bucket, so a probe of a new host can't hide behind a burst of noise. It returns ErrFull if there's
// no room.
func (l *Log) Refusal(key int, root bool, e Entry) error {
	l.mu.Lock()
	b := l.buckets[key]
	now := l.now()
	if b == nil {
		b = &bucket{tokens: RefusalBurst, last: now}
		l.buckets[key] = b
	}
	b.user, b.port, b.phase = e.User, e.Port, e.Phase
	b.tokens = min(RefusalBurst, b.tokens+now.Sub(b.last).Seconds()*RefusalRate)
	b.last = now
	fk := firstKey{port: key, reason: e.Reason, host: e.Host}
	switch {
	case !l.firstSeen[fk] && len(l.firstSeen) < MaxFirstSeen:
		l.firstSeen[fk] = true
	case b.tokens >= 1:
		b.tokens--
	default:
		b.suppressed++
		l.mu.Unlock()
		return nil
	}
	suppressed := b.suppressed
	b.suppressed = 0
	l.mu.Unlock()
	r, err := l.Reserve(root)
	if err != nil {
		// No room (e.g. the job users' share is full): keep the count, this line included, for a
		// later line or the shutdown summary.
		l.mu.Lock()
		b.suppressed += suppressed + 1
		l.mu.Unlock()
		return err
	}
	e.Suppressed = suppressed
	r.Write(e)
	return nil
}

// FlushSuppressed writes, from root's share, one summary line per port that still has suppressed
// refusal lines not reported by a later line. The proxy calls it at shutdown.
func (l *Log) FlushSuppressed() {
	l.mu.Lock()
	keys := make([]int, 0, len(l.buckets))
	for k, b := range l.buckets {
		if b.suppressed > 0 {
			keys = append(keys, k)
		}
	}
	sort.Ints(keys)
	var todo []Entry
	for _, k := range keys {
		b := l.buckets[k]
		todo = append(todo, Entry{Phase: b.phase, User: b.user, Port: b.port, Method: "CONNECT", Reason: ReasonSuppressedSummary, Suppressed: b.suppressed})
		b.suppressed = 0
	}
	l.mu.Unlock()
	for _, e := range todo {
		r, err := l.Reserve(true)
		if err != nil {
			return
		}
		r.Write(e)
	}
}

// JobFull reports whether the job users' part of the log is exhausted.
func (l *Log) JobFull() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.jobFull
}

// Full reports whether the whole log is full (or failed).
func (l *Log) Full() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.full || l.failed
}

// FullFor reports whether requests on root's port (root) or a job user's port must be refused.
func (l *Log) FullFor(root bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.full || l.failed || (!root && l.jobFull)
}

// Written is the log file's size as the proxy knows it.
func (l *Log) Written() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.written
}

// jobMarkerLocked writes the one-time job_log_full marker from root's share, keeping MarkerLen
// free for the final marker.
func (l *Log) jobMarkerLocked() error {
	if l.jobMarker || l.failed || l.full {
		return nil
	}
	l.jobMarker = true
	b, _ := json.Marshal(jobMarker{V: 1, TS: ts(l.now()), JobLogFull: true})
	b = append(b, '\n')
	if l.written+l.reserved+int64(len(b))+MarkerLen > l.limit {
		return nil
	}
	return l.writeLocked(b)
}

func (l *Log) maybeMarkerLocked() error {
	if !l.full || l.markerWritten || l.outstanding > 0 || l.failed {
		return nil
	}
	l.markerWritten = true
	b, _ := json.Marshal(marker{V: 1, TS: ts(l.now()), LogFull: true})
	b = append(b, '\n')
	if l.written+int64(len(b)) > l.limit {
		// Only possible when the file already started over the cap; write nothing.
		return nil
	}
	return l.writeLocked(b)
}

func (l *Log) writeLocked(b []byte) error {
	n, err := l.w.Write(b)
	l.written += int64(n)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err != nil {
		l.failed = true
		return err
	}
	return nil
}

func (l *Log) report(err error) {
	if err != nil && l.fatal != nil {
		l.fatal(err)
	}
}

func ts(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func encode(e Entry, now time.Time) []byte {
	ln := line{
		V:         1,
		TS:        ts(now),
		Phase:     e.Phase,
		User:      e.User,
		Port:      e.Port,
		Method:    cleanMethod(e.Method),
		Host:      cleanHost(e.Host),
		Path:      cut(e.Path, MaxPath),
		Status:    e.Status,
		ReqBytes:  e.ReqBytes,
		RespBytes: e.RespBytes,
		Reason:    cut(e.Reason, 32),
		Suppr:     e.Suppressed,
	}
	b, _ := json.Marshal(ln)
	if len(b)+1 > MaxLine {
		// Can't happen with the bounds above; stay inside the reservation regardless.
		ln.Path = ""
		b, _ = json.Marshal(ln)
	}
	return append(b, '\n')
}

func cut(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// cleanMethod keeps a method token of A-Z only, else "INVALID".
func cleanMethod(m string) string {
	if m == "" || len(m) > maxMethod {
		return "INVALID"
	}
	for i := 0; i < len(m); i++ {
		if m[i] < 'A' || m[i] > 'Z' {
			return "INVALID"
		}
	}
	return m
}

// cleanHost replaces every byte outside a DNS/IP-literal alphabet with '_' so a hostile CONNECT
// target can neither need JSON escaping nor inflate the line.
func cleanHost(h string) string {
	h = cut(h, maxHost)
	b := []byte(h)
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '-', c == ':', c == '[', c == ']':
		default:
			b[i] = '_'
		}
	}
	return string(b)
}
