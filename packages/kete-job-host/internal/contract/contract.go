// Package contract is the job-host-v1 wire contract (kete-code-platform
// `packages/shared/src/api/v1/job-hosts.ts`; standalone copy `docs/platform/job-host-v1.md`):
// routes, limits, the request and response bodies, and their validation. Request bodies the agent
// builds are validated before they are sent (the platform refuses unknown fields and anything out
// of range); response bodies are decoded tolerantly (unknown fields ignored, the platform may add
// fields within v1) and then validated field by field before anything in them is used.
package contract

import (
	"errors"
	"fmt"
	"regexp"
	"time"
)

// Routes and limits.
const (
	EnrollPath  = "/api/v1/job-hosts/enroll"
	PollPath    = "/api/v1/job-hosts/poll"
	ContentType = "application/json"

	EnrollMaxBytes   = 8_192
	PollMaxBytes     = 1_048_576
	ResponseMaxBytes = 1_048_576

	MaxSlots           = 32
	ReportMaxMachines  = 128
	PhaseLinesMax      = 200
	PhaseLineMaxBytes  = 512
	PollIntervalSecond = 10

	// DeadlineGrace and MachineMaxAge drive the agent's deadline killer (ADR 0023 rule 12).
	DeadlineGrace = 300 * time.Second
	MachineMaxAge = 8_100 * time.Second

	// SignatureWindow bounds |now − created| and expires − created.
	SignatureWindow = 60

	// HPKE suite and info label (RFC 9180 base mode).
	HPKEKemID     = 0x0020
	HPKEKdfID     = 0x0001
	HPKEAeadID    = 0x0001
	HPKEInfoLabel = "kete-job-host-v1 sealed-config"

	// MachineConfigMaxBytes is the machine configuration's largest JSON (kete-code bootenv.MaxConfig).
	MachineConfigMaxBytes = 4_096
	// Config disk (firecracker): header, JSON, NUL padding to exactly ConfigDiskBytes.
	ConfigDiskHeader = "kete-job-config v1\n"
	ConfigDiskBytes  = 8_192
)

var (
	uuidRe        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	base64Url32Re = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
	tokenRe       = regexp.MustCompile(`^kete_jhe_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
	fingerprintRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	generationRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	versionRe     = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+_~-]{0,63}$`)
	imageRefRe    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/[a-z0-9]+(?:(?:[._]|__|-+|/)[a-z0-9]+)*@sha256:[0-9a-f]{64}$`)
	nonceRe       = regexp.MustCompile(`^[0-9a-f]{32}$`)
	phaseNameRe   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	timestampRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
	ciphertextRe  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// ValidUUID reports a lowercase canonical UUID (host, machine and job ids).
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

// ValidBase64Url32 reports canonical unpadded base64url of 32 bytes.
func ValidBase64Url32(s string) bool { return base64Url32Re.MatchString(s) }

// ValidEnrollmentToken reports the `kete_jhe_` token shape.
func ValidEnrollmentToken(s string) bool { return tokenRe.MatchString(s) }

// ValidFingerprint reports 64 lowercase hex characters.
func ValidFingerprint(s string) bool { return fingerprintRe.MatchString(s) }

// ValidGeneration reports a host generation (kete-code hostprofile.ValidGeneration).
func ValidGeneration(s string) bool { return generationRe.MatchString(s) }

// ValidVersion reports a version string.
func ValidVersion(s string) bool { return versionRe.MatchString(s) }

// ValidImageRef reports `<registry>[:port]/<repository>@sha256:<64 hex>`, at most 300 bytes.
func ValidImageRef(s string) bool { return len(s) <= 300 && imageRefRe.MatchString(s) }

// ValidNonce reports 32 lowercase hex characters.
func ValidNonce(s string) bool { return nonceRe.MatchString(s) }

// ValidTimestamp reports an RFC 3339 time with an offset (Zod `iso.datetime({ offset: true })`).
func ValidTimestamp(s string) bool {
	if !timestampRe.MatchString(s) {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// FormatTime is how the agent writes times: UTC, millisecond precision.
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// ---------------------------------------------------------------- enums

// Machine states.
const (
	StatePreparing = "preparing"
	StateStarting  = "starting"
	StateRunning   = "running"
	StateStopping  = "stopping"
	StateDestroyed = "destroyed"
	StateFailed    = "failed"
)

// Terminal reports failed or destroyed.
func Terminal(state string) bool { return state == StateFailed || state == StateDestroyed }

// Machine reasons: failed (never ran) and destroyed.
const (
	ReasonImageNotAllowed       = "image_not_allowed"
	ReasonImageSignatureInvalid = "image_signature_invalid"
	ReasonImageUnavailable      = "image_unavailable"
	ReasonPlatformMismatch      = "platform_mismatch"
	ReasonConfigUndecryptable   = "config_undecryptable"
	ReasonConfigInvalid         = "config_invalid"
	ReasonGenerationMismatch    = "generation_mismatch"
	ReasonNoFreeSlot            = "no_free_slot"
	ReasonDeadlinePassed        = "deadline_passed"
	ReasonStartsBlocked         = "starts_blocked"
	ReasonDriverFailed          = "driver_failed"

	ReasonExited       = "exited"
	ReasonDesired      = "desired"
	ReasonDeadline     = "deadline"
	ReasonMaxAge       = "max_age"
	ReasonHostDisabled = "host_disabled"
	ReasonCrashed      = "crashed"
	// ReasonHostIsolationLost: the host's nftables table vanished or changed while the machine ran,
	// so the agent destroyed it (fail closed). Kete-code addition pending in the platform's
	// job-host-v1 contract (JobHostMachineReason) — see the P4 task handoff.
	ReasonHostIsolationLost = "host_isolation_lost"
)

var failedReasons = map[string]bool{
	ReasonImageNotAllowed: true, ReasonImageSignatureInvalid: true, ReasonImageUnavailable: true,
	ReasonPlatformMismatch: true, ReasonConfigUndecryptable: true, ReasonConfigInvalid: true,
	ReasonGenerationMismatch: true, ReasonNoFreeSlot: true, ReasonDeadlinePassed: true,
	ReasonStartsBlocked: true, ReasonDriverFailed: true,
}

var destroyedReasons = map[string]bool{
	ReasonExited: true, ReasonDesired: true, ReasonDeadline: true, ReasonMaxAge: true,
	ReasonHostDisabled: true, ReasonCrashed: true, ReasonHostIsolationLost: true,
}

// FailedReason reports a reason that goes with `failed`.
func FailedReason(r string) bool { return failedReasons[r] }

// DestroyedReason reports a reason that goes with `destroyed`.
func DestroyedReason(r string) bool { return destroyedReasons[r] }

var states = map[string]bool{StatePreparing: true, StateStarting: true, StateRunning: true, StateStopping: true, StateDestroyed: true, StateFailed: true}

// Starts-blocked reasons.
const (
	BlockedHostTable       = "host_table"
	BlockedDiskSpace       = "disk_space"
	BlockedDriverUnhealthy = "driver_unhealthy"
	BlockedOperator        = "operator"
	// BlockedGenerationSpent: a dedicated host's generation has run its one job (ADR 0023 rule 8);
	// nothing else starts until the host is reset and re-enrolled with a new generation. kete-code
	// added it in self-hosted P5; the platform's JobHostStartsBlocked must add it before a dedicated
	// host polls (see the P5 task handoff).
	BlockedGenerationSpent = "generation_spent"
)

var blocked = map[string]bool{
	BlockedHostTable: true, BlockedDiskSpace: true, BlockedDriverUnhealthy: true, BlockedOperator: true, BlockedGenerationSpent: true,
}

// ValidStartsBlocked reports a known starts-blocked reason.
func ValidStartsBlocked(s string) bool { return blocked[s] }

// Drivers, resets, arches.
const (
	DriverFirecracker = "firecracker"
	DriverDedicated   = "dedicated"

	ResetNone            = "none"
	ResetProviderRebuild = "provider_rebuild"
	ResetMeasuredBoot    = "measured_boot"
)

// Error reasons (`error.reason` of every non-2xx response).
const (
	ErrMalformedRequest       = "malformed_request"
	ErrBodyTooLarge           = "body_too_large"
	ErrDigestMismatch         = "digest_mismatch"
	ErrSignatureMalformed     = "signature_malformed"
	ErrSignatureInvalid       = "signature_invalid"
	ErrClockSkew              = "clock_skew"
	ErrNonceReplayed          = "nonce_replayed"
	ErrEnrollmentTokenInvalid = "enrollment_token_invalid"
	ErrHostPending            = "host_pending"
	ErrHostDisabled           = "host_disabled"
	ErrHostRevoked            = "host_revoked"
	ErrGenerationMismatch     = "generation_mismatch"
	ErrKeyInUse               = "key_in_use"
	ErrRateLimited            = "rate_limited"
	ErrUnavailable            = "unavailable"
	ErrInternal               = "internal"
)

var errorReasons = map[string]bool{
	ErrMalformedRequest: true, ErrBodyTooLarge: true, ErrDigestMismatch: true, ErrSignatureMalformed: true,
	ErrSignatureInvalid: true, ErrClockSkew: true, ErrNonceReplayed: true, ErrEnrollmentTokenInvalid: true,
	ErrHostPending: true, ErrHostDisabled: true, ErrHostRevoked: true, ErrGenerationMismatch: true,
	ErrKeyInUse: true, ErrRateLimited: true, ErrUnavailable: true, ErrInternal: true,
}

// ValidErrorReason reports a known error reason.
func ValidErrorReason(s string) bool { return errorReasons[s] }

// ---------------------------------------------------------------- enrollment

// Versions is what the agent reports about its software.
type Versions struct {
	Agent       string `json:"agent"`
	Firecracker string `json:"firecracker,omitempty"`
	GuestKernel string `json:"guest_kernel,omitempty"`
	HostKernel  string `json:"host_kernel"`
}

// Validate checks every present version.
func (v Versions) Validate() error {
	if !ValidVersion(v.Agent) || !ValidVersion(v.HostKernel) {
		return errors.New("versions: agent and host_kernel must be versions")
	}
	if (v.Firecracker != "" && !ValidVersion(v.Firecracker)) || (v.GuestKernel != "" && !ValidVersion(v.GuestKernel)) {
		return errors.New("versions: invalid firecracker or guest_kernel")
	}
	return nil
}

// Facts is what the agent declares at enrollment (ADR 0023 rule 9).
type Facts struct {
	Arch       string   `json:"arch"`
	Driver     string   `json:"driver"`
	Slots      int      `json:"slots"`
	KVM        bool     `json:"kvm"`
	Reset      string   `json:"reset"`
	Generation string   `json:"generation"`
	Versions   Versions `json:"versions"`
}

// Validate applies the schema's per-driver rules.
func (f Facts) Validate() error {
	if f.Arch != "amd64" && f.Arch != "arm64" {
		return errors.New("facts: arch must be amd64 or arm64")
	}
	if f.Driver != DriverFirecracker && f.Driver != DriverDedicated {
		return errors.New("facts: driver must be firecracker or dedicated")
	}
	if f.Slots < 1 || f.Slots > MaxSlots {
		return fmt.Errorf("facts: slots must be 1-%d", MaxSlots)
	}
	if f.Reset != ResetNone && f.Reset != ResetProviderRebuild && f.Reset != ResetMeasuredBoot {
		return errors.New("facts: unknown reset")
	}
	if !ValidGeneration(f.Generation) {
		return errors.New("facts: invalid generation")
	}
	if err := f.Versions.Validate(); err != nil {
		return err
	}
	fc := f.Driver == DriverFirecracker
	switch {
	case fc && !f.KVM:
		return errors.New("facts: the firecracker driver needs KVM")
	case fc && f.Reset != ResetNone:
		return errors.New("facts: a firecracker host declares reset none")
	case !fc && f.Reset == ResetNone:
		return errors.New("facts: a dedicated host needs a verified reset")
	case !fc && f.Slots != 1:
		return errors.New("facts: a dedicated host has exactly 1 slot")
	case fc != (f.Versions.Firecracker != "") || fc != (f.Versions.GuestKernel != ""):
		return errors.New("facts: firecracker and guest_kernel versions exactly for the firecracker driver")
	}
	return nil
}

// EnrollRequest is the enroll body.
type EnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	SigningKey      string `json:"signing_key"`
	SealingKey      string `json:"sealing_key"`
	Facts           Facts  `json:"facts"`
}

// Validate checks the body.
func (r EnrollRequest) Validate() error {
	if !ValidEnrollmentToken(r.EnrollmentToken) {
		return errors.New("enroll: invalid enrollment token")
	}
	if !ValidBase64Url32(r.SigningKey) || !ValidBase64Url32(r.SealingKey) {
		return errors.New("enroll: keys must be base64url of 32 bytes")
	}
	return r.Facts.Validate()
}

// EnrollResponse is the enroll 201 body.
type EnrollResponse struct {
	HostID        string `json:"host_id"`
	Status        string `json:"status"`
	Fingerprint   string `json:"fingerprint"`
	NextPollAfter int    `json:"next_poll_after"`
}

// Validate checks the response.
func (r EnrollResponse) Validate() error {
	if !ValidUUID(r.HostID) || (r.Status != "pending" && r.Status != "active") || !ValidFingerprint(r.Fingerprint) ||
		r.NextPollAfter < 1 || r.NextPollAfter > 60 {
		return errors.New("enroll response: invalid")
	}
	return nil
}

// ---------------------------------------------------------------- report

// PhaseLine is one entrypoint or kete-job-init phase line (kete-code phaselog).
type PhaseLine struct {
	TS       string `json:"ts"`
	Step     string `json:"step"`
	Event    string `json:"event"`
	Code     string `json:"code,omitempty"`
	Class    string `json:"class,omitempty"`
	Errno    *int   `json:"errno,omitempty"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

var phaseEvents = map[string]bool{"start": true, "ok": true, "failed": true, "note": true, "exit": true}

// Validate applies JobHostPhaseLine.
func (p PhaseLine) Validate() error {
	if !ValidTimestamp(p.TS) || !phaseNameRe.MatchString(p.Step) || !phaseEvents[p.Event] {
		return errors.New("phase line: invalid ts, step or event")
	}
	if (p.Code != "" && !phaseNameRe.MatchString(p.Code)) || (p.Class != "" && !phaseNameRe.MatchString(p.Class)) {
		return errors.New("phase line: invalid code or class")
	}
	if (p.Errno != nil && (*p.Errno < 0 || *p.Errno > 4095)) || (p.ExitCode != nil && (*p.ExitCode < 0 || *p.ExitCode > 255)) {
		return errors.New("phase line: errno or exit_code out of range")
	}
	return nil
}

// ObservedMachine is one machine (or tombstone) in a report.
type ObservedMachine struct {
	MachineID         string      `json:"machine_id"`
	JobID             *string     `json:"job_id"`
	State             string      `json:"state"`
	Since             string      `json:"since"`
	Reason            string      `json:"reason,omitempty"`
	PhaseLines        []PhaseLine `json:"phase_lines"`
	PhaseLinesDropped int64       `json:"phase_lines_dropped"`
}

// Validate applies JobHostObservedMachine.
func (m ObservedMachine) Validate() error {
	if !ValidUUID(m.MachineID) || (m.JobID != nil && !ValidUUID(*m.JobID)) || !states[m.State] || !ValidTimestamp(m.Since) {
		return fmt.Errorf("machine %q: invalid id, job id, state or since", m.MachineID)
	}
	terminal := Terminal(m.State)
	if terminal != (m.Reason != "") {
		return fmt.Errorf("machine %s: reason exactly with failed or destroyed", m.MachineID)
	}
	if terminal && ((m.State == StateFailed && !FailedReason(m.Reason)) || (m.State == StateDestroyed && !DestroyedReason(m.Reason))) {
		return fmt.Errorf("machine %s: reason does not fit the state", m.MachineID)
	}
	if m.PhaseLines == nil || len(m.PhaseLines) > PhaseLinesMax || m.PhaseLinesDropped < 0 {
		return fmt.Errorf("machine %s: phase lines out of range", m.MachineID)
	}
	for _, l := range m.PhaseLines {
		if err := l.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Slots is the report's slot count.
type Slots struct {
	Total int `json:"total"`
	Free  int `json:"free"`
}

// Report is the poll body.
type Report struct {
	Generation      string            `json:"generation"`
	Versions        Versions          `json:"versions"`
	Slots           Slots             `json:"slots"`
	StartsBlocked   *string           `json:"starts_blocked"`
	AppliedRevision *int64            `json:"applied_revision"`
	Machines        []ObservedMachine `json:"machines"`
}

// Validate applies JobHostReport.
func (r Report) Validate() error {
	if !ValidGeneration(r.Generation) {
		return errors.New("report: invalid generation")
	}
	if err := r.Versions.Validate(); err != nil {
		return err
	}
	if r.Slots.Total < 1 || r.Slots.Total > MaxSlots || r.Slots.Free < 0 || r.Slots.Free > r.Slots.Total {
		return errors.New("report: slots out of range")
	}
	if r.StartsBlocked != nil && !ValidStartsBlocked(*r.StartsBlocked) {
		return errors.New("report: unknown starts_blocked")
	}
	if r.AppliedRevision != nil && *r.AppliedRevision < 0 {
		return errors.New("report: negative applied_revision")
	}
	if r.Machines == nil || len(r.Machines) > ReportMaxMachines {
		return errors.New("report: machines out of range")
	}
	seen := map[string]bool{}
	for _, m := range r.Machines {
		if err := m.Validate(); err != nil {
			return err
		}
		if seen[m.MachineID] {
			return errors.New("report: duplicate machine id")
		}
		seen[m.MachineID] = true
	}
	return nil
}

// ---------------------------------------------------------------- desired state

// SealedConfig is the HPKE envelope.
type SealedConfig struct {
	KemID      int    `json:"kem_id"`
	KdfID      int    `json:"kdf_id"`
	AeadID     int    `json:"aead_id"`
	Enc        string `json:"enc"`
	Ciphertext string `json:"ciphertext"`
}

// MaxCiphertextChars is ceil((MachineConfigMaxBytes + 16) * 4 / 3).
const MaxCiphertextChars = ((MachineConfigMaxBytes+16)*4 + 2) / 3

// Validate applies JobHostSealedConfig.
func (s SealedConfig) Validate() error {
	if s.KemID != HPKEKemID || s.KdfID != HPKEKdfID || s.AeadID != HPKEAeadID {
		return errors.New("sealed config: unsupported suite")
	}
	if !ValidBase64Url32(s.Enc) || len(s.Ciphertext) < 22 || len(s.Ciphertext) > MaxCiphertextChars || !ciphertextRe.MatchString(s.Ciphertext) {
		return errors.New("sealed config: invalid enc or ciphertext")
	}
	return nil
}

// Resources is a machine's size.
type Resources struct {
	VCPUs      int `json:"vcpus"`
	MemoryMiB  int `json:"memory_mib"`
	ScratchGiB int `json:"scratch_gib"`
}

// RunMachine is one machine the platform wants running.
type RunMachine struct {
	MachineID string        `json:"machine_id"`
	JobID     string        `json:"job_id"`
	Image     string        `json:"image"`
	Deadline  string        `json:"deadline"`
	Resources Resources     `json:"resources"`
	Config    *SealedConfig `json:"config,omitempty"`
}

// Validate applies JobHostRunMachine except the sealed config's own fields (checked when it is
// opened, so a bad envelope fails only its machine, as config_undecryptable).
func (m RunMachine) Validate() error {
	if !ValidUUID(m.MachineID) || !ValidUUID(m.JobID) || !ValidTimestamp(m.Deadline) {
		return errors.New("run machine: invalid id, job id or deadline")
	}
	if m.Image == "" || len(m.Image) > 300 {
		return errors.New("run machine: invalid image")
	}
	r := m.Resources
	if r.VCPUs < 1 || r.VCPUs > 16 || r.MemoryMiB < 512 || r.MemoryMiB > 65_536 || r.ScratchGiB < 1 || r.ScratchGiB > 200 {
		return errors.New("run machine: resources out of range")
	}
	return nil
}

// DesiredState is the poll response's desired state. Revision, Run and Destroy are pointers so a
// missing field is told apart from zero or empty (both are required).
type DesiredState struct {
	Revision *int64        `json:"revision"`
	Run      *[]RunMachine `json:"run"`
	Destroy  *[]string     `json:"destroy"`
}

// PollResponse is the poll 200 body.
type PollResponse struct {
	InReplyTo     string       `json:"in_reply_to"`
	HostID        string       `json:"host_id"`
	Status        string       `json:"status"`
	NextPollAfter int          `json:"next_poll_after"`
	Desired       DesiredState `json:"desired"`
}

// Validate applies JobHostPollResponse. The image ref's own shape is checked by the agent per
// machine (image_not_allowed), not here, so one bad entry doesn't discard the whole response.
func (p PollResponse) Validate() error {
	if !ValidNonce(p.InReplyTo) || !ValidUUID(p.HostID) || (p.Status != "active" && p.Status != "draining") ||
		p.NextPollAfter < 1 || p.NextPollAfter > 60 {
		return errors.New("poll response: invalid envelope")
	}
	d := p.Desired
	if d.Revision == nil || *d.Revision < 0 || d.Run == nil || d.Destroy == nil {
		return errors.New("poll response: desired state incomplete")
	}
	if len(*d.Run) > MaxSlots || len(*d.Destroy) > ReportMaxMachines {
		return errors.New("poll response: desired state too large")
	}
	seen := map[string]bool{}
	for _, m := range *d.Run {
		if err := m.Validate(); err != nil {
			return err
		}
		if seen[m.MachineID] {
			return errors.New("poll response: duplicate machine id in run")
		}
		seen[m.MachineID] = true
	}
	for _, id := range *d.Destroy {
		if !ValidUUID(id) {
			return errors.New("poll response: invalid id in destroy")
		}
	}
	return nil
}

// ErrorBody is the error member of every non-2xx response.
type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Reason    string `json:"reason"`
}

// ErrorResponse is every non-2xx body.
type ErrorResponse struct {
	Error ErrorBody `json:"error"`
}
