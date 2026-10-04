package phase

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	good := []string{
		`{"ts":"2026-10-03T01:59:40.125Z","step":"claim","event":"ok"}`,
		`{"ts":"2026-10-03T01:59:40+02:00","step":"isolation","event":"failed","code":"metadata","class":"errno","errno":111}`,
		`{"ts":"2026-10-03T01:58:01.5Z","step":"job","event":"exit","exit_code":0}`,
	}
	for _, s := range good {
		if _, ok := Parse([]byte(s)); !ok {
			t.Errorf("refused %s", s)
		}
	}
	bad := []string{
		`not json`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"ok","message":"x"}`,
		`{"ts":"2026-10-03 01:59:40","step":"claim","event":"ok"}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"Claim","event":"ok"}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"done"}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"ok","errno":5000}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"ok","exit_code":256}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"ok"} {}`,
		`{"ts":"2026-10-03T01:59:40Z","step":"claim","event":"ok","code":"` + strings.Repeat("a", 500) + `"}`,
	}
	for _, s := range bad {
		if _, ok := Parse([]byte(s)); ok {
			t.Errorf("accepted %.60s", s)
		}
	}
}

func TestBuffer(t *testing.T) {
	var b Buffer
	line := []byte(`{"ts":"2026-10-03T01:59:40.125Z","step":"claim","event":"ok"}`)
	b.Add(line)
	b.Add([]byte("junk"))
	l, d := b.Take()
	if len(l) != 1 || d != 1 {
		t.Fatalf("%d %d", len(l), d)
	}
	b.Add(line) // arrives while the report is in flight
	b.Nack()
	l, d = b.Take()
	if len(l) != 2 || d != 1 {
		t.Fatalf("after nack %d %d", len(l), d)
	}
	b.Add([]byte("junk"))
	b.Ack()
	l, d = b.Take()
	if len(l) != 0 || d != 1 {
		t.Fatalf("after ack %d %d", len(l), d)
	}
	b.Ack()
	for range 205 {
		b.Add(line)
	}
	l, d = b.Take()
	if len(l) != 200 || d != 5 {
		t.Fatalf("cap %d %d", len(l), d)
	}
}
