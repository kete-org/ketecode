// Package fakeplatform is an in-process platform implementing job-host-v1 (P2.0) for the agent's
// tests: both routes with the contract's verification order (body cap, signature, nonce store,
// host state, strict body, generation), single-use enrollment tokens, and a desired state per host
// that behaves like the platform's (`docs/platform/job-host-v1.md` "Acknowledgements"): a
// machine's sealed config is sent until the host reports it running or terminal, a withdrawn
// machine stays in `destroy` until the host reports it terminal, and `revision` increases on every
// change. Hooks let tests tamper with responses. Tests only.
package fakeplatform

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
)

// Machine is the platform's row for one machine.
type Machine struct {
	Run            contract.RunMachine
	DesiredRunning bool
	Config         *contract.SealedConfig // deleted once reported running or terminal
	Observed       string
	ObservedReason string
	Terminal       bool // recorded destroyed or failed
	PhaseLines     []contract.PhaseLine
	Dropped        int64
}

// Host is one host.
type Host struct {
	ID         string
	SigningKey string
	SealingKey string
	Generation string
	Status     string
	Facts      contract.Facts
	Revision   int64
	lastKey    string
	Machines   map[string]*Machine
	Unknown    map[string]contract.ObservedMachine
	Reports    []contract.Report
}

// Recorded is one request as received.
type Recorded struct {
	Path   string
	Body   []byte
	Status int
	Reason string
}

// Platform is the fake.
type Platform struct {
	Authority string
	Now       func() time.Time

	mu       sync.Mutex
	tokens   map[string]bool
	rebuilds map[string]string // R1 rebuild tokens -> the generation the rebuild was started for
	hosts    map[string]*Host
	byKey    map[string]string
	nonces   map[string]int64
	requests []Recorded
	seq      int
	skew     time.Duration

	// Unreachable makes every request fail at the transport (the host sees a network error).
	Unreachable bool
	// TamperPoll edits a successful poll response before it is sent.
	TamperPoll func(*contract.PollResponse)
	// ForceError answers every poll with this reason (and its status) while set.
	ForceError string
}

// New returns a platform whose public host is authority.
func New(authority string, now func() time.Time) *Platform {
	return &Platform{
		Authority: authority, Now: now, tokens: map[string]bool{}, rebuilds: map[string]string{}, hosts: map[string]*Host{},
		byKey: map[string]string{}, nonces: map[string]int64{},
	}
}

// AddToken registers a new enrollment token.
func (p *Platform) AddToken(token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens[token] = true
}

// AddRebuildToken registers the fresh enrollment token of an R1 provider rebuild the platform
// started for generation (ADR 0023 rule 8). An enrollment with it is approved automatically
// (`active`) when it declares a dedicated `provider_rebuild` host of exactly that generation;
// anything else stays `pending` (an admin would have to look). This mirrors what the platform
// must do in P5; it is the fake's model, not the platform's code.
func (p *Platform) AddRebuildToken(token, generation string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens[token] = true
	p.rebuilds[token] = generation
}

// SetStatus sets a host's status (`active` approves it).
func (p *Platform) SetStatus(hostID, status string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hosts[hostID].Status = status
}

// Assign adds a machine with a configuration sealed to the host for its binding.
func (p *Platform) Assign(hostID string, run contract.RunMachine, cfg seal.MachineConfig) error {
	js, err := cfg.Canonical()
	if err != nil {
		return err
	}
	return p.AssignPlaintext(hostID, run, js)
}

// AssignPlaintext seals arbitrary plaintext (tests of invalid configurations).
func (p *Platform) AssignPlaintext(hostID string, run contract.RunMachine, plaintext []byte) error {
	p.mu.Lock()
	h := p.hosts[hostID]
	p.mu.Unlock()
	pub, ok := sig.DecodeKey(h.SealingKey)
	if !ok {
		return errors.New("fakeplatform: bad sealing key")
	}
	sc, err := seal.Seal(pub, seal.Binding{HostID: hostID, MachineID: run.MachineID, JobID: run.JobID, Generation: h.Generation}, plaintext)
	if err != nil {
		return err
	}
	run.Config = &sc
	return p.AssignRaw(hostID, run)
}

// AssignRaw adds a machine exactly as given (config included or not).
func (p *Platform) AssignRaw(hostID string, run contract.RunMachine) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.hosts[hostID]
	if h.Status != "active" {
		return fmt.Errorf("fakeplatform: host is %s", h.Status)
	}
	h.Machines[run.MachineID] = &Machine{Run: run, DesiredRunning: true, Config: run.Config}
	return nil
}

// SetGeneration changes the host's recorded generation (generation_mismatch tests).
func (p *Platform) SetGeneration(hostID, generation string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hosts[hostID].Generation = generation
}

// SetSigningKey replaces the host's stored signing key (signature_invalid tests).
func (p *Platform) SetSigningKey(hostID, key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hosts[hostID].SigningKey = key
}

// SetSkew offsets the platform's clock from the host's (clock_skew tests).
func (p *Platform) SetSkew(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.skew = d
}

// SetUnreachable makes every request fail at the transport while on.
func (p *Platform) SetUnreachable(on bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Unreachable = on
}

// SetForceError answers every poll with reason while set ("" clears it).
func (p *Platform) SetForceError(reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ForceError = reason
}

// SetTamper installs a poll-response hook (nil clears it).
func (p *Platform) SetTamper(f func(*contract.PollResponse)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.TamperPoll = f
}

// Withdraw sets a machine's desired state to destroyed.
func (p *Platform) Withdraw(hostID, machineID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if m := p.hosts[hostID].Machines[machineID]; m != nil {
		m.DesiredRunning = false
	}
}

// HostSnapshot returns a deep-enough copy of a host.
func (p *Platform) HostSnapshot(hostID string) Host {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := *p.hosts[hostID]
	h.Machines = map[string]*Machine{}
	for id, m := range p.hosts[hostID].Machines {
		c := *m
		h.Machines[id] = &c
	}
	h.Reports = append([]contract.Report(nil), p.hosts[hostID].Reports...)
	return h
}

// OnlyHost returns the single enrolled host's id.
func (p *Platform) OnlyHost() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id := range p.hosts {
		return id
	}
	return ""
}

// Requests returns every request received.
func (p *Platform) Requests() []Recorded {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Recorded(nil), p.requests...)
}

var statusFor = map[string]int{
	contract.ErrMalformedRequest: 400, contract.ErrBodyTooLarge: 400, contract.ErrDigestMismatch: 400, contract.ErrSignatureMalformed: 400,
	contract.ErrSignatureInvalid: 401, contract.ErrClockSkew: 401, contract.ErrNonceReplayed: 401, contract.ErrEnrollmentTokenInvalid: 401,
	contract.ErrHostPending: 403, contract.ErrHostDisabled: 403, contract.ErrHostRevoked: 403, contract.ErrGenerationMismatch: 403,
	contract.ErrKeyInUse: 409, contract.ErrRateLimited: 429, contract.ErrUnavailable: 503, contract.ErrInternal: 500,
}

var codeFor = map[int]string{400: "invalid_request", 401: "invalid_key", 403: "forbidden", 409: "conflict", 429: "rate_limited", 503: "unavailable", 500: "internal"}

func (p *Platform) fail(w http.ResponseWriter, path string, body []byte, reason string) {
	st := statusFor[reason]
	p.requests = append(p.requests, Recorded{Path: path, Body: body, Status: st, Reason: reason})
	p.seq++
	rid := fmt.Sprintf("req_%d", p.seq)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("x-kete-request-id", rid)
	if reason == contract.ErrRateLimited {
		w.Header().Set("Retry-After", "1")
	}
	w.WriteHeader(st)
	_ = json.NewEncoder(w).Encode(contract.ErrorResponse{Error: contract.ErrorBody{Code: codeFor[st], Message: "refused: " + reason, RequestID: rid, Reason: reason}})
}

func (p *Platform) ok(w http.ResponseWriter, path string, body []byte, status int, v any) {
	p.requests = append(p.requests, Recorded{Path: path, Body: body, Status: status})
	p.seq++
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("x-kete-request-id", fmt.Sprintf("req_%d", p.seq))
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ServeHTTP implements both routes.
func (p *Platform) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.Unreachable {
		if hj, ok := w.(http.Hijacker); ok {
			if c, _, err := hj.Hijack(); err == nil {
				_ = c.Close()
				return
			}
		}
		panic(http.ErrAbortHandler)
	}
	limit := contract.PollMaxBytes
	if r.URL.Path == contract.EnrollPath {
		limit = contract.EnrollMaxBytes
	} else if r.URL.Path != contract.PollPath || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	if err != nil {
		p.fail(w, r.URL.Path, nil, contract.ErrMalformedRequest)
		return
	}
	if len(body) > limit {
		p.fail(w, r.URL.Path, nil, contract.ErrBodyTooLarge)
		return
	}
	for _, h := range []string{"Content-Type", "Content-Digest", "Signature-Input", "Signature"} {
		if len(r.Header.Values(h)) > 1 {
			p.fail(w, r.URL.Path, body, contract.ErrSignatureMalformed)
			return
		}
	}
	req := sig.Request{
		Method: r.Method, Authority: p.Authority, Path: r.URL.Path, Body: body, Now: p.Now().Add(p.skew).Unix(),
		Headers: sig.Headers{
			ContentType: r.Header.Get("Content-Type"), ContentDigest: r.Header.Get("Content-Digest"),
			SignatureInput: r.Header.Get("Signature-Input"), Signature: r.Header.Get("Signature"),
		},
	}
	if r.URL.Path == contract.EnrollPath {
		p.enroll(w, req)
		return
	}
	p.poll(w, req)
}

func (p *Platform) checkNonce(params sig.Params, now int64) bool {
	for k, exp := range p.nonces {
		if exp < now {
			delete(p.nonces, k)
		}
	}
	k := params.KeyID + "/" + params.Nonce
	if _, seen := p.nonces[k]; seen {
		return false
	}
	p.nonces[k] = params.Created + 2*contract.SignatureWindow
	return true
}

func strictDecode(body []byte, v any) bool {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if dec.Decode(v) != nil {
		return false
	}
	_, err := dec.Token()
	return errors.Is(err, io.EOF)
}

func (p *Platform) enroll(w http.ResponseWriter, r sig.Request) {
	params, fp, err := sig.VerifyEnrollment(r)
	if err != nil {
		p.fail(w, r.Path, r.Body, err.Error())
		return
	}
	if !p.checkNonce(params, r.Now) {
		p.fail(w, r.Path, r.Body, contract.ErrNonceReplayed)
		return
	}
	var req contract.EnrollRequest
	if !strictDecode(r.Body, &req) || req.Validate() != nil {
		p.fail(w, r.Path, r.Body, contract.ErrMalformedRequest)
		return
	}
	valid := p.tokens[req.EnrollmentToken]
	rebuildGen, rebuild := p.rebuilds[req.EnrollmentToken]
	delete(p.tokens, req.EnrollmentToken) // spent by any signed attempt
	delete(p.rebuilds, req.EnrollmentToken)
	if !valid {
		p.fail(w, r.Path, r.Body, contract.ErrEnrollmentTokenInvalid)
		return
	}
	if _, used := p.byKey[req.SigningKey]; used {
		p.fail(w, r.Path, r.Body, contract.ErrKeyInUse)
		return
	}
	status := "pending"
	if rebuild && req.Facts.Driver == contract.DriverDedicated && req.Facts.Reset == contract.ResetProviderRebuild && req.Facts.Generation == rebuildGen {
		status = "active"
	}
	id := fmt.Sprintf("7d0f3c2e-5b1a-4c8e-9f60-%012x", len(p.hosts)+1)
	p.hosts[id] = &Host{
		ID: id, SigningKey: req.SigningKey, SealingKey: req.SealingKey, Generation: req.Facts.Generation,
		Status: status, Facts: req.Facts, Machines: map[string]*Machine{}, Unknown: map[string]contract.ObservedMachine{},
	}
	p.byKey[req.SigningKey] = id
	p.ok(w, r.Path, r.Body, 201, contract.EnrollResponse{HostID: id, Status: status, Fingerprint: fp, NextPollAfter: 30})
}

func (p *Platform) poll(w http.ResponseWriter, r sig.Request) {
	params, err := sig.Verify(r, func(keyid string) string {
		if h := p.hosts[keyid]; h != nil {
			return h.SigningKey
		}
		return ""
	})
	if err != nil {
		p.fail(w, r.Path, r.Body, err.Error())
		return
	}
	if !p.checkNonce(params, r.Now) {
		p.fail(w, r.Path, r.Body, contract.ErrNonceReplayed)
		return
	}
	h := p.hosts[params.KeyID]
	switch h.Status {
	case "pending":
		p.fail(w, r.Path, r.Body, contract.ErrHostPending)
		return
	case "disabled":
		p.fail(w, r.Path, r.Body, contract.ErrHostDisabled)
		return
	case "revoked":
		p.fail(w, r.Path, r.Body, contract.ErrHostRevoked)
		return
	}
	var rep contract.Report
	if !strictDecode(r.Body, &rep) || rep.Validate() != nil {
		p.fail(w, r.Path, r.Body, contract.ErrMalformedRequest)
		return
	}
	if rep.Generation != h.Generation {
		p.fail(w, r.Path, r.Body, contract.ErrGenerationMismatch)
		return
	}
	if p.ForceError != "" {
		p.fail(w, r.Path, r.Body, p.ForceError)
		return
	}
	h.Reports = append(h.Reports, rep)
	for _, om := range rep.Machines {
		m := h.Machines[om.MachineID]
		if m == nil {
			h.Unknown[om.MachineID] = om
			continue
		}
		m.Observed, m.ObservedReason = om.State, om.Reason
		m.PhaseLines = append(m.PhaseLines, om.PhaseLines...)
		m.Dropped += om.PhaseLinesDropped
		if om.State == contract.StateRunning || contract.Terminal(om.State) {
			m.Config = nil // ADR 0023 rule 13: the ciphertext is deleted once delivered
		}
		if contract.Terminal(om.State) {
			m.Terminal = true
		}
	}
	run, destroy := []contract.RunMachine{}, []string{}
	ids := make([]string, 0, len(h.Machines))
	for id := range h.Machines {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var key strings.Builder
	for _, id := range ids {
		m := h.Machines[id]
		switch {
		case m.Terminal:
		case m.DesiredRunning:
			rm := m.Run
			rm.Config = m.Config
			run = append(run, rm)
			fmt.Fprintf(&key, "r%s%v;", id, m.Config != nil)
		default:
			destroy = append(destroy, id)
			fmt.Fprintf(&key, "d%s;", id)
		}
	}
	if key.String() != h.lastKey {
		h.Revision++
		h.lastKey = key.String()
	}
	rev := h.Revision
	status := "active"
	if h.Status == "draining" {
		status = "draining"
	}
	resp := contract.PollResponse{
		InReplyTo: params.Nonce, HostID: h.ID, Status: status, NextPollAfter: 10,
		Desired: contract.DesiredState{Revision: &rev, Run: &run, Destroy: &destroy},
	}
	if p.TamperPoll != nil {
		p.TamperPoll(&resp)
	}
	p.ok(w, r.Path, r.Body, 200, resp)
}
