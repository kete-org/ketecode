package phaselog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
)

func TestLines(t *testing.T) {
	var b bytes.Buffer
	l := New(&b)
	l.Start(StepClaim)
	l.Fail(StepClaim, CodeGone)
	l.Exit(1)
	lines := strings.Split(strings.TrimSpace(b.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %q", lines)
	}
	for _, line := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil || m["ts"] == "" {
			t.Errorf("line %q: %v", line, err)
		}
		for k := range m {
			if k != "ts" && k != "step" && k != "event" && k != "code" && k != "class" && k != "errno" && k != "exit_code" {
				t.Errorf("unexpected field %q", k)
			}
		}
	}
	if !strings.Contains(lines[1], `"code":"gone"`) || !strings.Contains(lines[2], `"exit_code":1`) {
		t.Errorf("lines = %q", lines)
	}
}

type classed struct{}

func (classed) Error() string             { return "secret text" }
func (classed) ErrorClass() (string, int) { return "http", 503 }

func TestFailErr(t *testing.T) {
	var b bytes.Buffer
	l := New(&b)
	l.FailErr(StepNft, CodeFailed, fmt.Errorf("open /x secret-token: %w", syscall.ENOENT))
	l.FailErr(StepClaim, CodeFailed, fmt.Errorf("wrapped secret: %w", classed{}))
	l.FailErr(StepClone, CodeFailed, errors.New("token abc in text"))
	out := b.String()
	if strings.Contains(out, "secret") || strings.Contains(out, "token") || strings.Contains(out, "/x") {
		t.Errorf("error text leaked: %s", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if !strings.Contains(lines[0], `"class":"errno","errno":2`) || !strings.Contains(lines[1], `"class":"http","errno":503`) || !strings.Contains(lines[2], `"class":"other"`) {
		t.Errorf("lines = %q", lines)
	}
	if c, _ := Classify(context.DeadlineExceeded); c != "timeout" {
		t.Error("timeout class")
	}
}
