package phase

import "testing"

func TestTransitions(t *testing.T) {
	s := NewState()
	if s.Get() != None {
		t.Fatalf("start = %q", s.Get())
	}
	for _, p := range []Phase{Clone, Agent, Report, Closed} {
		if err := s.Set(p); err != nil {
			t.Fatalf("Set(%q): %v", p, err)
		}
		if s.Get() != p {
			t.Fatalf("Get = %q, want %q", s.Get(), p)
		}
	}
	for _, p := range []Phase{Clone, Agent, Report, Closed, None} {
		if err := s.Set(p); err == nil {
			t.Errorf("Set(%q) after closed accepted", p)
		}
	}
}

func TestSkipAndBackward(t *testing.T) {
	s := NewState()
	if err := s.Set(Agent); err != nil {
		t.Fatalf("none → agent: %v", err)
	}
	if err := s.Set(Clone); err == nil {
		t.Error("agent → clone accepted")
	}
	if err := s.Set(Agent); err == nil {
		t.Error("agent → agent accepted")
	}
	if s.Get() != Agent {
		t.Errorf("a refused Set changed the phase to %q", s.Get())
	}
	if err := s.Set(Closed); err != nil {
		t.Errorf("agent → closed: %v", err)
	}
	if err := s.Set("bogus"); err == nil {
		t.Error("unknown phase accepted")
	}
}

func TestParse(t *testing.T) {
	for _, ok := range []string{"clone", "agent", "report", "closed"} {
		if _, err := Parse(ok); err != nil {
			t.Errorf("Parse(%q): %v", ok, err)
		}
	}
	for _, bad := range []string{"none", "", "Agent", "x"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) accepted", bad)
		}
	}
}
