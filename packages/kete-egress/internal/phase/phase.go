// Package phase holds the proxy's current job phase (module README "Control protocol v1"). Phases
// only move forward — none → clone → agent → report → closed, skipping allowed — and change only
// on an instruction from root over the control socket. In none and closed nothing is allowed.
package phase

import (
	"fmt"
	"sync"
)

// Phase is one step of a job's life.
type Phase string

const (
	None   Phase = "none"
	Clone  Phase = "clone"
	Agent  Phase = "agent"
	Report Phase = "report"
	Closed Phase = "closed"
)

var order = map[Phase]int{None: 0, Clone: 1, Agent: 2, Report: 3, Closed: 4}

// Parse accepts the four phases root may set ("none" is only ever the starting phase).
func Parse(s string) (Phase, error) {
	switch p := Phase(s); p {
	case Clone, Agent, Report, Closed:
		return p, nil
	}
	return "", fmt.Errorf("unknown phase %q", s)
}

// State is the current phase behind a mutex.
type State struct {
	mu  sync.Mutex
	cur Phase
}

// NewState starts in None.
func NewState() *State { return &State{cur: None} }

// Get returns the current phase.
func (s *State) Get() Phase {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Set moves to next if it is strictly later than the current phase.
func (s *State) Set(next Phase) error {
	n, ok := order[next]
	if !ok || next == None {
		return fmt.Errorf("unknown phase %q", next)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= order[s.cur] {
		return fmt.Errorf("phase %q can't follow %q (phases only move forward)", next, s.cur)
	}
	s.cur = next
	return nil
}
