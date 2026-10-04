// Package enroll is `kete-job-host enroll` (ADR 0023 rule 9; `docs/platform/job-host-v1.md`
// "Enrollment"): generate the host's keys, print their fingerprint for the admin to compare, and
// send the enrollment request signed with the new key (`keyid` = the fingerprint, proving
// possession). The single-use token comes from stdin, or for a dedicated host's R1 boot
// enrollment (ADR 0023 rule 8: the platform rebuilt the server with a fresh token in its user
// data) from a root-only token file that is removed once the platform has answered. It is never
// logged or stored anywhere else.
package enroll

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fsutil"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// Options configure one enrollment.
type Options struct {
	Config config.Config
	Client *client.Client
	// Facts other than generation (set here) come from the host (cmd: arch, KVM, versions).
	Facts contract.Facts
	// Token is the enrollment token's reader (stdin). Ignored when TokenFile is set.
	Token io.Reader
	// TokenFile is a root-owned 0600 file holding the token (R1 boot enrollment, written from the
	// provider's user data). It is removed on a definitive answer (accepted, or refused as
	// enrollment_token_invalid / key_in_use: the token is spent) or when malformed, and kept after a
	// transport error or a transient answer (429, 5xx, clock skew), for a retry.
	TokenFile string
	// Out receives the fingerprint for the operator.
	Out io.Writer
	Log *slog.Logger
	// Replace allows re-enrolling an enrolled host (new keys, new identity). Refused while the
	// state file holds a live machine.
	Replace bool
	Now     func() time.Time
	Rand    io.Reader
}

// ReadToken reads one token line (at most 256 bytes) and checks its shape.
func ReadToken(r io.Reader) ([]byte, error) {
	buf, err := io.ReadAll(io.LimitReader(r, 257))
	if err != nil {
		return nil, err
	}
	if len(buf) > 256 {
		clear(buf)
		return nil, errors.New("enroll: the token is too long")
	}
	tok := []byte(strings.TrimSpace(string(buf)))
	clear(buf)
	if !contract.ValidEnrollmentToken(string(tok)) {
		clear(tok)
		return nil, errors.New("enroll: expected one enrollment token (kete_jhe_…) on stdin or in the token file")
	}
	return tok, nil
}

// Run enrolls the host and returns the stored state.
func Run(ctx context.Context, o Options) (state.State, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Rand == nil {
		o.Rand = rand.Reader
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if err := fsutil.EnsurePrivateDir(o.Config.StateDir); err != nil {
		return state.State{}, err
	}
	path := state.Path(o.Config.StateDir)
	st, err := state.Load(path)
	if err != nil {
		return state.State{}, err
	}
	if st.Enrolled() && !o.Replace {
		return state.State{}, errors.New("enroll: this host is already enrolled (use --replace to re-enroll with new keys)")
	}
	// ADR 0023 rule 8: a dedicated host whose generation ran a job is compromised; only a verified
	// reset (a rebuilt disk, so no state file) gives it a new identity, never a re-enrollment.
	if st.GenerationSpentBy != "" {
		return state.State{}, fmt.Errorf("enroll: generation %s of this dedicated host ran a job (machine %s); the host must be reset by the platform (rebuilt), not re-enrolled", st.Generation, st.GenerationSpentBy)
	}
	for _, m := range st.Machines {
		if !contract.Terminal(m.State) {
			return state.State{}, errors.New("enroll: the host still holds machines; stop the agent's jobs before re-enrolling")
		}
	}
	var token []byte
	if o.TokenFile != "" {
		raw, err := fsutil.ReadPrivate(o.TokenFile, 256)
		if err != nil {
			return state.State{}, fmt.Errorf("enroll: token file: %w", err)
		}
		token, err = ReadToken(bytes.NewReader(raw))
		clear(raw)
		if err != nil {
			// A malformed token can never succeed: drop it rather than retry it forever.
			if rerr := os.Remove(o.TokenFile); rerr != nil && !errors.Is(rerr, os.ErrNotExist) {
				o.Log.Error("enroll_token_file_not_removed", "error", rerr.Error())
			}
			return state.State{}, err
		}
	} else if token, err = ReadToken(o.Token); err != nil {
		return state.State{}, err
	}
	defer clear(token)

	generation := o.Config.Generation
	if generation == "" {
		var b [4]byte
		if _, err := io.ReadFull(o.Rand, b[:]); err != nil {
			return state.State{}, err
		}
		generation = "g-" + o.Now().UTC().Format("20060102") + "-" + hex.EncodeToString(b[:])
	}
	k, err := keys.Generate(o.Rand)
	if err != nil {
		return state.State{}, err
	}
	// The new keys stay staged until the platform's 201 is validated: a failed --replace leaves
	// the old identity (keys and state) intact.
	kdir := keys.Dir(o.Config.StateDir)
	if err := keys.DiscardStaged(kdir); err != nil {
		return state.State{}, err
	}
	if err := keys.SaveStaged(kdir, k); err != nil {
		_ = keys.DiscardStaged(kdir)
		return state.State{}, err
	}
	committed := false
	defer func() {
		if !committed {
			if err := keys.DiscardStaged(kdir); err != nil {
				o.Log.Error("enroll_staged_keys_not_removed", "error", err.Error())
			}
		}
	}()
	fp := k.Fingerprint()
	fmt.Fprintf(o.Out, "Host key fingerprint (compare it with the admin page before approving):\n  %s\n", sig.GroupFingerprint(fp))

	facts := o.Facts
	facts.Generation = generation
	req := contract.EnrollRequest{
		EnrollmentToken: string(token), SigningKey: sig.EncodeKey(k.SigningPublic()), SealingKey: sig.EncodeKey(k.SealingPublic()), Facts: facts,
	}
	if err := req.Validate(); err != nil {
		return state.State{}, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return state.State{}, err
	}
	resp, err := o.Client.Post(ctx, contract.EnrollPath, fp, k.Signing, body, 201)
	clear(body)
	var ae *client.APIError
	if o.TokenFile != "" && (err == nil || (errors.As(err, &ae) && (ae.Reason == contract.ErrEnrollmentTokenInvalid || ae.Reason == contract.ErrKeyInUse))) {
		// A definitive answer: accepted, or the token refused (spent, unknown, expired) or spent on
		// a key already in use. Transient answers (429, 5xx, clock skew, a proxy's) keep it.
		if rerr := os.Remove(o.TokenFile); rerr != nil && !errors.Is(rerr, os.ErrNotExist) {
			o.Log.Error("enroll_token_file_not_removed", "error", rerr.Error())
		}
	}
	if err != nil {
		if errors.As(err, &ae) {
			o.Log.Error("enroll_refused", "status", ae.Status, "reason", ae.Reason, "request_id", ae.RequestID)
			switch ae.Reason {
			case contract.ErrEnrollmentTokenInvalid:
				return state.State{}, errors.New("enroll: the platform refused the token (unknown, used, expired or revoked); ask for a new one")
			case contract.ErrKeyInUse:
				return state.State{}, errors.New("enroll: this key is already enrolled for another host; run enroll again with a new token")
			}
		}
		return state.State{}, fmt.Errorf("enroll: %w", err)
	}
	var er contract.EnrollResponse
	if err := json.Unmarshal(resp.Body, &er); err != nil || er.Validate() != nil {
		return state.State{}, errors.New("enroll: the platform's response is not a valid enrollment response")
	}
	if er.Fingerprint != fp {
		return state.State{}, errors.New("enroll: the platform recorded another fingerprint than this host's keys")
	}
	if err := keys.CommitStaged(kdir); err != nil {
		return state.State{}, fmt.Errorf("enroll: installing the new keys: %w", err)
	}
	committed = true
	st = state.State{
		Version: state.Version, HostID: er.HostID, Fingerprint: fp, Generation: generation, EnrolledStatus: er.Status,
		Machines: []state.Machine{},
	}
	if err := state.Save(path, st); err != nil {
		// The keys are installed but the state isn't: the agent refuses the mismatch until the
		// host is enrolled again.
		return state.State{}, fmt.Errorf("enroll: the platform accepted the host (%s) but the state file couldn't be written: %w", er.HostID, err)
	}
	o.Log.Info("enrolled", "host_id", er.HostID, "status", er.Status, "fingerprint", fp, "request_id", resp.RequestID)
	if er.Status == "active" {
		// R1: the platform approved the re-enrollment of a server it rebuilt itself.
		fmt.Fprintf(o.Out, "Enrolled as host %s (active: approved by the platform). Start the agent.\n", er.HostID)
	} else {
		fmt.Fprintf(o.Out, "Enrolled as host %s (%s). Start the agent; it polls until an admin approves the host.\n", er.HostID, er.Status)
	}
	return st, nil
}
