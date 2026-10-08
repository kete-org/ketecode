// Package state is the agent's durable state file (`<state_dir>/state.json`, root `0600`,
// written atomically): the host's enrollment, the last applied desired-state revision, a durable
// halt, and every machine it holds or still reports. It never holds a machine configuration, a
// claim token, a key or a ciphertext (ADR 0023 rule 13): after a restart the agent re-adopts
// machines from this file and the driver, and a machine that never started is simply delivered
// again by the platform.
package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fsutil"
)

// Version is the state file schema version.
const Version = 1

const maxFile = 1 << 20

// Durable halts: polling stops until the host is re-enrolled.
const (
	HaltRevoked            = "host_revoked"
	HaltGenerationMismatch = "generation_mismatch"
	// HaltContractMismatch (job-host-v2): the platform holds this host under another contract
	// version; it must be enrolled again under v2.
	HaltContractMismatch = "contract_mismatch"
)

// Machine is one machine record.
type Machine struct {
	MachineID string `json:"machine_id"`
	// JobID is empty for a machine the agent can't attribute (found by reconcile).
	JobID      string    `json:"job_id,omitempty"`
	Image      string    `json:"image,omitempty"`
	Deadline   time.Time `json:"deadline"`
	AcceptedAt time.Time `json:"accepted_at"`
	State      string    `json:"state"`
	Since      time.Time `json:"since"`
	Reason     string    `json:"reason,omitempty"`
	// StopReason is the destroyed reason a `stopping` machine will get.
	StopReason string `json:"stop_reason,omitempty"`
}

// State is the file.
type State struct {
	Version         int    `json:"version"`
	HostID          string `json:"host_id,omitempty"`
	Fingerprint     string `json:"fingerprint,omitempty"`
	Generation      string `json:"generation,omitempty"`
	EnrolledStatus  string `json:"enrolled_status,omitempty"`
	AppliedRevision *int64 `json:"applied_revision"`
	Halted          string `json:"halted,omitempty"`
	// GenerationSpentBy is the machine whose start spent this dedicated host's generation (ADR
	// 0023 rule 8: one job per generation). Once set, no other machine starts until the host is
	// reset and enrolled again with a new generation (a fresh state file).
	GenerationSpentBy string    `json:"generation_spent_by,omitempty"`
	Machines          []Machine `json:"machines"`
}

// Path is the state file under a state directory.
func Path(stateDir string) string { return filepath.Join(stateDir, "state.json") }

// Enrolled reports a stored host id.
func (s State) Enrolled() bool { return s.HostID != "" }

// Validate checks the file's invariants.
func (s State) Validate() error {
	if s.Version != Version {
		return fmt.Errorf("state: version %d, want %d", s.Version, Version)
	}
	if s.HostID != "" && (!contract.ValidUUID(s.HostID) || !contract.ValidGeneration(s.Generation) || !contract.ValidFingerprint(s.Fingerprint)) {
		return errors.New("state: invalid enrollment")
	}
	if s.GenerationSpentBy != "" && (!s.Enrolled() || !contract.ValidUUID(s.GenerationSpentBy)) {
		return errors.New("state: invalid generation_spent_by")
	}
	if s.Halted != "" && s.Halted != HaltRevoked && s.Halted != HaltGenerationMismatch && s.Halted != HaltContractMismatch {
		return errors.New("state: unknown halt")
	}
	seen := map[string]bool{}
	for _, m := range s.Machines {
		if !contract.ValidUUID(m.MachineID) || (m.JobID != "" && !contract.ValidUUID(m.JobID)) || seen[m.MachineID] {
			return fmt.Errorf("state: invalid machine %q", m.MachineID)
		}
		seen[m.MachineID] = true
		terminal := contract.Terminal(m.State)
		switch {
		// v2's failed reasons are a superset of v1's; the report's own validation keeps a v1 host
		// to v1's (the v1 agent never produces the others).
		case terminal && m.State == contract.StateFailed && !contract.FailedReasonV2(m.Reason),
			terminal && m.State == contract.StateDestroyed && !contract.DestroyedReason(m.Reason),
			!terminal && m.Reason != "",
			m.State == contract.StateStopping && !contract.DestroyedReason(m.StopReason):
			return fmt.Errorf("state: machine %s has an inconsistent state", m.MachineID)
		case !terminal && m.State != contract.StatePreparing && m.State != contract.StateStarting && m.State != contract.StateRunning && m.State != contract.StateStopping:
			return fmt.Errorf("state: machine %s has an unknown state", m.MachineID)
		}
	}
	return nil
}

// Store persists the state: the root-only file on a VM host (FileStore), a Secret for the
// Kubernetes runner (internal/kube). Save is called with the agent's lock held, so it must not
// block on the network (the Kubernetes store writes behind and reports its last failure).
type Store interface {
	Load() (State, error)
	Save(State) error
}

// FileStore is the state file at Path.
type FileStore struct{ Path string }

// Load implements Store.
func (f FileStore) Load() (State, error) { return Load(f.Path) }

// Save implements Store.
func (f FileStore) Save(s State) error { return Save(f.Path, s) }

// Load reads the state file; a missing file is an empty, unenrolled state.
func Load(path string) (State, error) {
	data, err := fsutil.ReadPrivate(path, maxFile)
	if errors.Is(err, os.ErrNotExist) {
		return State{Version: Version, Machines: []Machine{}}, nil
	}
	if err != nil {
		return State{}, err
	}
	return Decode(data)
}

// MaxBytes bounds a stored state document.
const MaxBytes = maxFile

// Decode parses and validates a state document (strict, no trailing data).
func Decode(data []byte) (State, error) {
	if len(data) > maxFile {
		return State{}, errors.New("state: too large")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var s State
	if err := dec.Decode(&s); err != nil {
		return State{}, fmt.Errorf("state: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return State{}, errors.New("state: trailing data")
	}
	if s.Machines == nil {
		s.Machines = []Machine{}
	}
	if err := s.Validate(); err != nil {
		return State{}, err
	}
	return s, nil
}

// Save writes the state file atomically (0600) after validating it.
func Save(path string, s State) error {
	data, err := Encode(s)
	if err != nil {
		return err
	}
	return fsutil.WritePrivate(path, data)
}

// Encode validates s and returns its stored form.
func Encode(s State) ([]byte, error) {
	if s.Machines == nil {
		s.Machines = []Machine{}
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(data) >= maxFile {
		return nil, errors.New("state: too large")
	}
	return append(data, '\n'), nil
}
