package kube

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// Secret data keys and annotations.
const (
	stateKey       = "state.json"
	signingKey     = "signing.key"
	sealingKey     = "sealing.key"
	AnnFingerprint = "kete.dev/fingerprint"
	// AnnKeys is "staged" while an enrollment is in flight and "enrolled" once the platform
	// accepted the keys; staged keys are never used (the next start enrolls again).
	AnnKeys      = "kete.dev/keys"
	KeysStaged   = "staged"
	KeysEnrolled = "enrolled"
	LabelManaged = "app.kubernetes.io/managed-by"
	ManagedBy    = "kete-runner"
)

// SecretStore is the agent's state (internal/state) in a Secret of the controller's namespace,
// instead of `/var/lib/kete-job-host/state.json` (spec §4.1). The document is the same validated
// JSON as the file. Save never blocks on the API server — the agent calls it under its lock — it
// queues the latest state for a background writer and returns the writer's last error, so a
// failing API server blocks starts (the agent's saveFailed) until a write succeeds again. Writes
// are conditional on the resourceVersion this store last saw: a conflict means another replica
// wrote, which the Lease should make impossible, and is reported as an error.
type SecretStore struct {
	Client    *Client
	Namespace string
	Name      string
	Log       *slog.Logger

	mu      sync.Mutex
	rv      string // "" until the Secret exists
	exists  bool
	pending []byte
	writing bool
	lastErr error
	wake    chan struct{}
	idle    *sync.Cond
	runOnce sync.Once
}

func (s *SecretStore) init() {
	s.runOnce.Do(func() {
		s.wake = make(chan struct{}, 1)
		s.idle = sync.NewCond(&s.mu)
		if s.Log == nil {
			s.Log = slog.New(slog.DiscardHandler)
		}
	})
}

// LoadContext reads the state Secret; a missing Secret is an empty, unenrolled state.
func (s *SecretStore) LoadContext(ctx context.Context) (state.State, error) {
	s.init()
	sec, err := s.Client.GetSecret(ctx, s.Namespace, s.Name)
	if IsNotFound(err) {
		s.mu.Lock()
		s.exists, s.rv = false, ""
		s.mu.Unlock()
		return state.State{Version: state.Version, Machines: []state.Machine{}}, nil
	}
	if err != nil {
		return state.State{}, err
	}
	st, err := state.Decode(sec.Data[stateKey])
	if err != nil {
		return state.State{}, fmt.Errorf("state Secret %s/%s: %w", s.Namespace, s.Name, err)
	}
	s.mu.Lock()
	s.exists, s.rv = true, sec.Metadata.ResourceVersion
	s.mu.Unlock()
	return st, nil
}

// Load implements state.Store (the agent calls it once, at start).
func (s *SecretStore) Load() (state.State, error) {
	ctx, cancel := context.WithTimeout(context.Background(), RequestTimeout)
	defer cancel()
	return s.LoadContext(ctx)
}

// Save implements state.Store: it validates and queues st and returns the background writer's
// last error.
func (s *SecretStore) Save(st state.State) error {
	s.init()
	data, err := state.Encode(st)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.pending = data
	err = s.lastErr
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return err
}

// Run writes queued states until ctx ends, then writes what is still queued once more.
func (s *SecretStore) Run(ctx context.Context) {
	s.init()
	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), RequestTimeout)
			s.writeOnce(fctx)
			cancel()
			return
		case <-s.wake:
		}
		for s.writeOnce(ctx) {
			// A failed write is retried after a pause while something is queued.
			if sleepCtx(ctx, 2*time.Second) != nil {
				break
			}
		}
	}
}

// Flush blocks until everything queued so far is written (or ctx ends), and returns the last
// write's error.
func (s *SecretStore) Flush(ctx context.Context) error {
	s.init()
	stop := context.AfterFunc(ctx, func() {
		s.mu.Lock()
		s.idle.Broadcast()
		s.mu.Unlock()
	})
	defer stop()
	s.mu.Lock()
	defer s.mu.Unlock()
	for (s.pending != nil || s.writing) && ctx.Err() == nil {
		select {
		case s.wake <- struct{}{}:
		default:
		}
		s.idle.Wait()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return s.lastErr
}

// writeOnce writes the queued state, if any, and reports whether a retry is due (a write failed
// and something is still queued).
func (s *SecretStore) writeOnce(ctx context.Context) bool {
	s.mu.Lock()
	data := s.pending
	if data == nil {
		s.mu.Unlock()
		return false
	}
	s.pending, s.writing = nil, true
	exists, rv := s.exists, s.rv
	s.mu.Unlock()

	var out Secret
	var err error
	sec := NewSecret(s.Namespace, s.Name, map[string][]byte{stateKey: data})
	sec.Metadata.Labels = map[string]string{LabelManaged: ManagedBy}
	if exists {
		sec.Metadata.ResourceVersion = rv
		out, err = s.Client.UpdateSecret(ctx, sec)
	} else {
		out, err = s.Client.CreateSecret(ctx, sec)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writing = false
	if err != nil {
		if IsConflict(err) {
			err = fmt.Errorf("state Secret %s/%s changed under this controller (another replica?): %w", s.Namespace, s.Name, err)
		}
		if s.lastErr == nil {
			s.Log.Error("state_save_failed", "secret", s.Name, "error", err.Error())
		}
		s.lastErr = err
		if s.pending == nil {
			s.pending = data // keep the newest state queued for the retry
		}
		s.idle.Broadcast()
		return true
	}
	s.exists, s.rv, s.lastErr = true, out.Metadata.ResourceVersion, nil
	s.idle.Broadcast()
	return false
}

// ---------------------------------------------------------------- keys

// KeySecret holds the host keys in a Secret of the controller's namespace (spec §4.1, §9.1): the
// raw 32-byte Ed25519 seed and X25519 private key, the fingerprint as an annotation, and AnnKeys.
type KeySecret struct {
	Client    *Client
	Namespace string
	Name      string
}

// ErrNoKeys means there is no Secret, or only staged keys from an unfinished enrollment.
var ErrNoKeys = errors.New("kube: no enrolled host keys")

// Load returns the enrolled keys, ErrNoKeys, or an error for a Secret that is malformed.
func (k KeySecret) Load(ctx context.Context) (keys.Keys, error) {
	sec, err := k.Client.GetSecret(ctx, k.Namespace, k.Name)
	if IsNotFound(err) {
		return keys.Keys{}, ErrNoKeys
	}
	if err != nil {
		return keys.Keys{}, err
	}
	if sec.Metadata.Annotations[AnnKeys] != KeysEnrolled {
		return keys.Keys{}, ErrNoKeys
	}
	return decodeKeys(sec)
}

func decodeKeys(sec Secret) (keys.Keys, error) {
	seed, raw := sec.Data[signingKey], sec.Data[sealingKey]
	if len(seed) != ed25519.SeedSize || len(raw) != 32 {
		return keys.Keys{}, errors.New("kube: the keys Secret's keys are not 32 bytes each")
	}
	signing := ed25519.NewKeyFromSeed(seed)
	if !sig.AcceptablePublicKey(signing.Public().(ed25519.PublicKey)) {
		return keys.Keys{}, errors.New("kube: the signing key's public half is non-canonical or of small order")
	}
	x, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return keys.Keys{}, fmt.Errorf("kube: sealing key: %w", err)
	}
	k := keys.Keys{Signing: signing, Sealing: x}
	if fp := sec.Metadata.Annotations[AnnFingerprint]; fp != "" && fp != k.Fingerprint() {
		return keys.Keys{}, errors.New("kube: the keys Secret's fingerprint annotation doesn't match its keys")
	}
	return k, nil
}

// Stage writes new keys marked staged (creating or replacing the Secret).
func (k KeySecret) Stage(ctx context.Context, ks keys.Keys) error {
	return k.write(ctx, ks, KeysStaged)
}

// Commit marks the staged keys enrolled; it refuses if the Secret no longer holds exactly ks.
func (k KeySecret) Commit(ctx context.Context, ks keys.Keys) error {
	return k.write(ctx, ks, KeysEnrolled)
}

func (k KeySecret) write(ctx context.Context, ks keys.Keys, status string) error {
	seed := ks.Signing.Seed()
	defer clear(seed)
	priv := ks.SealingPrivate()
	defer clear(priv)
	sec := NewSecret(k.Namespace, k.Name, map[string][]byte{signingKey: seed, sealingKey: priv})
	sec.Metadata.Labels = map[string]string{LabelManaged: ManagedBy}
	sec.Metadata.Annotations = map[string]string{AnnFingerprint: ks.Fingerprint(), AnnKeys: status}
	cur, err := k.Client.GetSecret(ctx, k.Namespace, k.Name)
	switch {
	case IsNotFound(err):
		if status == KeysEnrolled {
			return errors.New("kube: the staged keys Secret disappeared")
		}
		_, err = k.Client.CreateSecret(ctx, sec)
		return err
	case err != nil:
		return err
	}
	if status == KeysEnrolled && cur.Metadata.Annotations[AnnFingerprint] != ks.Fingerprint() {
		return errors.New("kube: the keys Secret no longer holds the staged keys")
	}
	sec.Metadata.ResourceVersion = cur.Metadata.ResourceVersion
	_, err = k.Client.UpdateSecret(ctx, sec)
	return err
}
