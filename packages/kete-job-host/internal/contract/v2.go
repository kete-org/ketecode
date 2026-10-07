package contract

// job-host-v2 (kete-code-platform `packages/shared/src/api/v1/job-hosts-v2.ts`; standalone copy
// `docs/platform/job-host-v2.md`): the enterprise runner's contract. Every v1 rule applies unless
// this file says otherwise. The differences: the signature tag (internal/sig V2), `version: 2` in
// every body (a response without it is discarded), the HPKE info label (internal/seal OpenV2), the
// `kubernetes` driver and `kubevm` profile, slots up to 128, the run machine's `repository` and
// `publish`, the `publishing` state, and the report's `publish`, `repositories`, `boundary`,
// `images` and `runtime_classes`. Bodies are decoded with Decode (required fields, nulls, strict
// objects) and then checked with Validate; the agent validates what it builds before sending.

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
)

// Version, limits and labels.
const (
	V2Version = 2

	V2PollMaxBytes      = 4_194_304
	V2ResponseMaxBytes  = 2_097_152
	V2MaxSlots          = 128
	V2ReportMaxMachines = 256
	V2MaxImages         = 16
	V2MaxRepositories   = 256
	V2MaxRuntimeClasses = 8
	HPKEInfoLabelV2     = "kete-job-host-v2 sealed-config"

	DriverKubernetes    = "kubernetes"
	StatePublishing     = "publishing"
	ErrContractMismatch = "contract_mismatch"

	ChangeRequestURLMax = 500
	ChangeRequestMaxIID = 2_147_483_647
	RuntimeRepoNameMax  = 200
	KubernetesNameMax   = 253

	maxSafeInteger  = 1<<53 - 1
	jobBranchPrefix = "kete/job/"
	boundaryOmit    = "omit"
	boundarySend    = "send"
)

// DriverProfile is the machine configuration profile each v2 driver's machines get.
var DriverProfile = map[string]string{DriverFirecracker: "microvm", DriverDedicated: "dedicated", DriverKubernetes: "kubevm"}

// v2 failure reasons (with `failed`) and starts-blocked reasons.
const (
	ReasonPodUnschedulable      = "pod_unschedulable"
	ReasonImagePullFailed       = "image_pull_failed"
	ReasonRepositoryUnknown     = "repository_unknown"
	ReasonRepositoryUnavailable = "repository_unavailable"

	BlockedClusterUnhealthy    = "cluster_unhealthy"
	BlockedRuntimeClassMissing = "runtime_class_missing"
)

// FailedReasonV2 reports a reason that goes with `failed` under v2 (v1's plus the cluster and
// repository ones). The `destroyed` reasons are v1's (DestroyedReason).
func FailedReasonV2(r string) bool {
	return failedReasons[r] || r == ReasonPodUnschedulable || r == ReasonImagePullFailed ||
		r == ReasonRepositoryUnknown || r == ReasonRepositoryUnavailable
}

// ValidStartsBlockedV2 reports a known v2 starts-blocked reason.
func ValidStartsBlockedV2(s string) bool {
	return blocked[s] || s == BlockedClusterUnhealthy || s == BlockedRuntimeClassMissing
}

// ValidErrorReasonV2 reports a known v2 error reason (v1's plus contract_mismatch).
func ValidErrorReasonV2(s string) bool { return errorReasons[s] || s == ErrContractMismatch }

var statesV2 = map[string]bool{StatePreparing: true, StateStarting: true, StateRunning: true, StateStopping: true, StatePublishing: true, StateDestroyed: true, StateFailed: true}

// Publish outcomes (each is also a jobs-v1 push status) and the reasons each allows: `created`
// only `mr_failed` (or none), `no_changes` none, `refused` and `failed` one of theirs (required).
const (
	PublishCreated   = "created"
	PublishNoChanges = "no_changes"
	PublishRefused   = "refused"
	PublishFailed    = "failed"

	PublishReasonMRFailed = "mr_failed"
)

// PublishReasons is JOB_HOST_PUBLISH_REASONS.
var PublishReasons = map[string][]string{
	PublishCreated:   {PublishReasonMRFailed},
	PublishNoChanges: {},
	PublishRefused:   {"symlink", "unreadable", "bundle_invalid", "base_unprotected", "branch_exists", "push_rejected"},
	PublishFailed:    {"processes_alive", "proxy_failed", "provider_unavailable", "provider_error", "protection_unknown", "hold_expired", "publisher_failed"},
}

// ---------------------------------------------------------------- shared value rules

var (
	runtimeRepoNameRe  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,19}:[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*$`)
	kubernetesNameRe   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$`)
	changeRequestURLRe = regexp.MustCompile(`^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$`)
	gitRefCharsRe      = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,255}$`)
	gitRefBadRe        = regexp.MustCompile(`(^[-/.]|/$|\.$|//|\.\.|/\.|\.lock(/|$)|@\{)`)
	gitSHARe           = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// ValidRuntimeRepoName reports a JobRuntimeRepoName: `<kind>:<path>` (e.g. `gitlab:payments/api`),
// a label, never a URL; every segment starts with a letter, digit or `_`.
func ValidRuntimeRepoName(s string) bool {
	return len(s) <= RuntimeRepoNameMax && runtimeRepoNameRe.MatchString(s)
}

// ValidKubernetesName reports a DNS-1123 subdomain (a RuntimeClass name).
func ValidKubernetesName(s string) bool {
	return len(s) <= KubernetesNameMax && kubernetesNameRe.MatchString(s)
}

// ValidChangeRequestURL reports a merge request URL: https, a lowercase host, an optional port,
// an absolute path of RFC 3986 pchars and `/`; no userinfo, query or fragment.
func ValidChangeRequestURL(s string) bool {
	return len(s) <= ChangeRequestURLMax && changeRequestURLRe.MatchString(s)
}

// ValidGitRef is the platform's isJobGitRef (a conservative subset of git-check-ref-format).
func ValidGitRef(s string) bool { return gitRefCharsRe.MatchString(s) && !gitRefBadRe.MatchString(s) }

// ValidJobBranch reports `kete/job/<suffix>` that is a valid ref.
func ValidJobBranch(s string) bool {
	return len(s) > len(jobBranchPrefix) && s[:len(jobBranchPrefix)] == jobBranchPrefix && ValidGitRef(s)
}

// ValidGitSHA reports a full lowercase SHA-1.
func ValidGitSHA(s string) bool { return gitSHARe.MatchString(s) }

func unique(xs []string) bool {
	seen := make(map[string]bool, len(xs))
	for _, x := range xs {
		if seen[x] {
			return false
		}
		seen[x] = true
	}
	return true
}

// ---------------------------------------------------------------- data boundary

// DataBoundary is jobs-v1 JobDataBoundary: what a runner lets leave the enterprise. Each setting
// is ordered strictest first.
type DataBoundary struct {
	Summary     string `json:"summary"`
	Denials     string `json:"denials"`
	PublishRefs string `json:"publish_refs"`
}

func (DataBoundary) strictObject() {}

// Boundary settings, strictest first.
var (
	BoundarySummary     = []string{"none", "redacted", "full"}
	BoundaryDenials     = []string{"count", "actions", "full"}
	BoundaryPublishRefs = []string{boundaryOmit, boundarySend}
)

// DefaultDataBoundary is JOB_DATA_BOUNDARY_DEFAULT.
var DefaultDataBoundary = DataBoundary{Summary: "none", Denials: "actions", PublishRefs: boundarySend}

// Validate applies JobDataBoundary.
func (b DataBoundary) Validate() error {
	if !slices.Contains(BoundarySummary, b.Summary) || !slices.Contains(BoundaryDenials, b.Denials) || !slices.Contains(BoundaryPublishRefs, b.PublishRefs) {
		return errors.New("boundary: unknown setting")
	}
	return nil
}

// Narrow is narrowJobDataBoundary: the stricter of two boundaries, setting by setting.
func (b DataBoundary) Narrow(o DataBoundary) DataBoundary {
	stricter := func(options []string, x, y string) string {
		if slices.Index(options, x) <= slices.Index(options, y) {
			return x
		}
		return y
	}
	return DataBoundary{
		Summary:     stricter(BoundarySummary, b.Summary, o.Summary),
		Denials:     stricter(BoundaryDenials, b.Denials, o.Denials),
		PublishRefs: stricter(BoundaryPublishRefs, b.PublishRefs, o.PublishRefs),
	}
}

// ---------------------------------------------------------------- enrollment

// VersionsV2 is JobHostV2Versions: v1's plus `kubernetes` (the API server's gitVersion).
type VersionsV2 struct {
	Agent       string `json:"agent"`
	Firecracker string `json:"firecracker,omitempty"`
	GuestKernel string `json:"guest_kernel,omitempty"`
	Kubernetes  string `json:"kubernetes,omitempty"`
	HostKernel  string `json:"host_kernel"`
}

func (VersionsV2) strictObject() {}

// Validate checks every present version.
func (v VersionsV2) Validate() error {
	if err := (Versions{Agent: v.Agent, Firecracker: v.Firecracker, GuestKernel: v.GuestKernel, HostKernel: v.HostKernel}).Validate(); err != nil {
		return err
	}
	if v.Kubernetes != "" && !ValidVersion(v.Kubernetes) {
		return errors.New("versions: invalid kubernetes")
	}
	return nil
}

// FactsV2 is JobHostV2Facts. RuntimeClasses is nil when absent.
type FactsV2 struct {
	Arch           string     `json:"arch"`
	Driver         string     `json:"driver"`
	Slots          int        `json:"slots"`
	KVM            bool       `json:"kvm"`
	Reset          string     `json:"reset"`
	Generation     string     `json:"generation"`
	Versions       VersionsV2 `json:"versions"`
	RuntimeClasses []string   `json:"runtime_classes,omitempty"`
}

func (FactsV2) strictObject() {}

func validRuntimeClasses(rc []string) error {
	if len(rc) < 1 || len(rc) > V2MaxRuntimeClasses {
		return fmt.Errorf("runtime_classes: 1-%d", V2MaxRuntimeClasses)
	}
	for _, n := range rc {
		if !ValidKubernetesName(n) {
			return errors.New("runtime_classes: invalid name")
		}
	}
	if !unique(rc) {
		return errors.New("runtime_classes: duplicate")
	}
	return nil
}

// Validate applies the schema's per-driver rules: firecracker 1–32 slots with KVM, dedicated one
// slot with a verified reset, kubernetes 1–128 slots, kvm false, reset none, versions.kubernetes and
// runtime_classes exactly for kubernetes.
func (f FactsV2) Validate() error {
	if f.Arch != "amd64" && f.Arch != "arm64" {
		return errors.New("facts: arch must be amd64 or arm64")
	}
	if f.Driver != DriverFirecracker && f.Driver != DriverDedicated && f.Driver != DriverKubernetes {
		return errors.New("facts: unknown driver")
	}
	if f.Slots < 1 || f.Slots > V2MaxSlots {
		return fmt.Errorf("facts: slots must be 1-%d", V2MaxSlots)
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
	if f.RuntimeClasses != nil {
		if err := validRuntimeClasses(f.RuntimeClasses); err != nil {
			return fmt.Errorf("facts: %w", err)
		}
	}
	fc, k8s, ded := f.Driver == DriverFirecracker, f.Driver == DriverKubernetes, f.Driver == DriverDedicated
	switch {
	case fc && !f.KVM:
		return errors.New("facts: the firecracker driver needs KVM")
	case fc && f.Slots > MaxSlots:
		return fmt.Errorf("facts: a firecracker host has at most %d slots", MaxSlots)
	case ded && f.Reset == ResetNone:
		return errors.New("facts: a dedicated host needs a verified reset")
	case ded && f.Slots != 1:
		return errors.New("facts: a dedicated host has exactly 1 slot")
	case !ded && f.Reset != ResetNone:
		return errors.New("facts: only a dedicated host declares a reset")
	case k8s && f.KVM:
		return errors.New("facts: a kubernetes host declares kvm false")
	case fc != (f.Versions.Firecracker != "") || fc != (f.Versions.GuestKernel != ""):
		return errors.New("facts: firecracker and guest_kernel versions exactly for the firecracker driver")
	case k8s != (f.Versions.Kubernetes != ""):
		return errors.New("facts: the kubernetes version exactly for the kubernetes driver")
	case k8s != (f.RuntimeClasses != nil):
		return errors.New("facts: runtime_classes exactly for the kubernetes driver")
	}
	return nil
}

// EnrollRequestV2 is the v2 enroll body.
type EnrollRequestV2 struct {
	Version         int     `json:"version"`
	EnrollmentToken string  `json:"enrollment_token"`
	SigningKey      string  `json:"signing_key"`
	SealingKey      string  `json:"sealing_key"`
	Facts           FactsV2 `json:"facts"`
}

func (EnrollRequestV2) strictObject() {}

// Validate checks the body.
func (r EnrollRequestV2) Validate() error {
	if r.Version != V2Version {
		return errors.New("enroll: version must be 2")
	}
	if !ValidEnrollmentToken(r.EnrollmentToken) {
		return errors.New("enroll: invalid enrollment token")
	}
	if !ValidBase64Url32(r.SigningKey) || !ValidBase64Url32(r.SealingKey) {
		return errors.New("enroll: keys must be base64url of 32 bytes")
	}
	return r.Facts.Validate()
}

// EnrollResponseV2 is the v2 enroll 201 body (unknown fields ignored).
type EnrollResponseV2 struct {
	Version       int    `json:"version"`
	HostID        string `json:"host_id"`
	Status        string `json:"status"`
	Fingerprint   string `json:"fingerprint"`
	NextPollAfter int    `json:"next_poll_after"`
}

// Validate checks the response; one without `version: 2` is discarded.
func (r EnrollResponseV2) Validate() error {
	if r.Version != V2Version {
		return errors.New("enroll response: version must be 2")
	}
	return EnrollResponse{HostID: r.HostID, Status: r.Status, Fingerprint: r.Fingerprint, NextPollAfter: r.NextPollAfter}.Validate()
}

// ParseEnrollResponseV2 decodes and validates an enroll response.
func ParseEnrollResponseV2(data []byte) (EnrollResponseV2, error) {
	var r EnrollResponseV2
	if err := Decode(data, &r); err != nil {
		return EnrollResponseV2{}, fmt.Errorf("enroll response: %w", err)
	}
	return r, r.Validate()
}

// ---------------------------------------------------------------- report

// MergeRequest is a publish outcome's `mr`.
type MergeRequest struct {
	IID int64  `json:"iid"`
	URL string `json:"url"`
}

func (MergeRequest) strictObject() {}

// PublishOutcome is JobHostPublishOutcome: a machine's publish result, fixed codes only. BaseSHA,
// CommitSHA and MR are boundary-gated (ReportV2.Validate); Branch is job metadata and never gated.
type PublishOutcome struct {
	Status    string        `json:"status"`
	Reason    string        `json:"reason,omitempty"`
	Branch    string        `json:"branch,omitempty"`
	BaseSHA   string        `json:"base_sha,omitempty"`
	CommitSHA string        `json:"commit_sha,omitempty"`
	MR        *MergeRequest `json:"mr,omitempty"`
}

func (PublishOutcome) strictObject() {}

// HasRefs reports a base SHA, commit SHA or merge request: what boundary.publish_refs gates.
func (p PublishOutcome) HasRefs() bool { return p.BaseSHA != "" || p.CommitSHA != "" || p.MR != nil }

// Validate applies the outcome's own rules: the reason-by-status table, commit_sha and mr only with
// created, and no mr with mr_failed.
func (p PublishOutcome) Validate() error {
	allowed, ok := PublishReasons[p.Status]
	if !ok {
		return errors.New("publish: unknown status")
	}
	if (p.Status == PublishRefused || p.Status == PublishFailed) && p.Reason == "" {
		return errors.New("publish: reason is required")
	}
	if p.Reason != "" && !slices.Contains(allowed, p.Reason) {
		return errors.New("publish: reason does not fit the status")
	}
	if p.Branch != "" && !ValidJobBranch(p.Branch) {
		return errors.New("publish: invalid branch")
	}
	if (p.BaseSHA != "" && !ValidGitSHA(p.BaseSHA)) || (p.CommitSHA != "" && !ValidGitSHA(p.CommitSHA)) {
		return errors.New("publish: invalid sha")
	}
	if p.MR != nil && (p.MR.IID < 1 || p.MR.IID > ChangeRequestMaxIID || !ValidChangeRequestURL(p.MR.URL)) {
		return errors.New("publish: invalid merge request")
	}
	if p.Status != PublishCreated && (p.CommitSHA != "" || p.MR != nil) {
		return errors.New("publish: commit_sha and mr only with created")
	}
	if p.MR != nil && p.Reason == PublishReasonMRFailed {
		return errors.New("publish: mr contradicts mr_failed")
	}
	return nil
}

// ObservedMachineV2 is JobHostV2ObservedMachine: v1's with v2 states and reasons, and `publish`.
type ObservedMachineV2 struct {
	MachineID         string          `json:"machine_id"`
	JobID             *string         `json:"job_id" shape:"nullable"`
	State             string          `json:"state"`
	Since             string          `json:"since"`
	Reason            string          `json:"reason,omitempty"`
	PhaseLines        []PhaseLine     `json:"phase_lines"`
	PhaseLinesDropped int64           `json:"phase_lines_dropped"`
	Publish           *PublishOutcome `json:"publish,omitempty"`
}

func (ObservedMachineV2) strictObject() {}

// Validate applies JobHostV2ObservedMachine: a reason exactly with failed or destroyed and fitting
// the state, publish only on a machine destroyed with reason exited.
func (m ObservedMachineV2) Validate() error {
	if !ValidUUID(m.MachineID) || (m.JobID != nil && !ValidUUID(*m.JobID)) || !statesV2[m.State] || !ValidTimestamp(m.Since) {
		return fmt.Errorf("machine %q: invalid id, job id, state or since", m.MachineID)
	}
	terminal := Terminal(m.State)
	if terminal != (m.Reason != "") {
		return fmt.Errorf("machine %s: reason exactly with failed or destroyed", m.MachineID)
	}
	if terminal && ((m.State == StateFailed && !FailedReasonV2(m.Reason)) || (m.State == StateDestroyed && !DestroyedReason(m.Reason))) {
		return fmt.Errorf("machine %s: reason does not fit the state", m.MachineID)
	}
	if m.PhaseLines == nil || len(m.PhaseLines) > PhaseLinesMax || m.PhaseLinesDropped < 0 || m.PhaseLinesDropped > maxSafeInteger {
		return fmt.Errorf("machine %s: phase lines out of range", m.MachineID)
	}
	for _, l := range m.PhaseLines {
		if err := l.Validate(); err != nil {
			return err
		}
	}
	if m.Publish != nil {
		if m.State != StateDestroyed || m.Reason != ReasonExited {
			return fmt.Errorf("machine %s: publish only on a machine destroyed with reason exited", m.MachineID)
		}
		if err := m.Publish.Validate(); err != nil {
			return fmt.Errorf("machine %s: %w", m.MachineID, err)
		}
	}
	return nil
}

// SlotsV2 is the v2 report's slot count.
type SlotsV2 struct {
	Total int `json:"total"`
	Free  int `json:"free"`
}

func (SlotsV2) strictObject() {}

// ReportV2 is the v2 poll body (JobHostV2Report). Fields are in the contract's order, so
// json.Marshal writes it as the platform's builders do. Repositories nil is null (the host doesn't
// advertise); RuntimeClasses nil is absent.
type ReportV2 struct {
	Version         int                 `json:"version"`
	Generation      string              `json:"generation"`
	Versions        VersionsV2          `json:"versions"`
	Slots           SlotsV2             `json:"slots"`
	StartsBlocked   *string             `json:"starts_blocked" shape:"nullable"`
	AppliedRevision *int64              `json:"applied_revision" shape:"nullable"`
	RuntimeClasses  []string            `json:"runtime_classes,omitempty"`
	Images          []string            `json:"images"`
	Repositories    *[]string           `json:"repositories" shape:"nullable"`
	Boundary        DataBoundary        `json:"boundary"`
	Machines        []ObservedMachineV2 `json:"machines"`
}

func (ReportV2) strictObject() {}

// Validate applies JobHostV2Report, including the boundary rules for every machine's publish:
// under publish_refs omit no base_sha, commit_sha or mr; under send a created outcome carries
// branch, base_sha and commit_sha.
func (r ReportV2) Validate() error {
	if r.Version != V2Version {
		return errors.New("report: version must be 2")
	}
	if !ValidGeneration(r.Generation) {
		return errors.New("report: invalid generation")
	}
	if err := r.Versions.Validate(); err != nil {
		return err
	}
	if r.Slots.Total < 1 || r.Slots.Total > V2MaxSlots || r.Slots.Free < 0 || r.Slots.Free > V2MaxSlots || r.Slots.Free > r.Slots.Total {
		return errors.New("report: slots out of range")
	}
	if r.StartsBlocked != nil && !ValidStartsBlockedV2(*r.StartsBlocked) {
		return errors.New("report: unknown starts_blocked")
	}
	if r.AppliedRevision != nil && (*r.AppliedRevision < 0 || *r.AppliedRevision > maxSafeInteger) {
		return errors.New("report: applied_revision out of range")
	}
	if r.RuntimeClasses != nil {
		if err := validRuntimeClasses(r.RuntimeClasses); err != nil {
			return fmt.Errorf("report: %w", err)
		}
	}
	if len(r.Images) < 1 || len(r.Images) > V2MaxImages || !unique(r.Images) {
		return fmt.Errorf("report: images must be 1-%d distinct digests", V2MaxImages)
	}
	for _, img := range r.Images {
		if !ValidImageRef(img) {
			return errors.New("report: an image is not a digest reference")
		}
	}
	if r.Repositories != nil {
		repos := *r.Repositories
		if len(repos) > V2MaxRepositories || !unique(repos) {
			return fmt.Errorf("report: repositories must be at most %d distinct names", V2MaxRepositories)
		}
		for _, n := range repos {
			if !ValidRuntimeRepoName(n) {
				return errors.New("report: invalid repository name")
			}
		}
	}
	if err := r.Boundary.Validate(); err != nil {
		return fmt.Errorf("report: %w", err)
	}
	if r.Machines == nil || len(r.Machines) > V2ReportMaxMachines {
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
		if p := m.Publish; p != nil {
			if r.Boundary.PublishRefs == boundaryOmit && p.HasRefs() {
				return fmt.Errorf("report: machine %s: the boundary omits publish references", m.MachineID)
			}
			if r.Boundary.PublishRefs == boundarySend && p.Status == PublishCreated && (p.Branch == "" || p.BaseSHA == "" || p.CommitSHA == "") {
				return fmt.Errorf("report: machine %s: created carries branch, base_sha and commit_sha when the boundary sends references", m.MachineID)
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------- desired state

// RunRepository is a run machine's `repository`: the name to look up in the host's registry and
// the base ref to resolve and check.
type RunRepository struct {
	Name    string `json:"name"`
	BaseRef string `json:"base_ref"`
}

// RunPublish is a run machine's `publish`: the host publishes only once `authorized` is true in a
// fresh desired state that still runs the machine.
type RunPublish struct {
	Branch     string `json:"branch"`
	OpenMR     bool   `json:"open_mr"`
	Authorized bool   `json:"authorized"`
}

// RunMachineV2 is JobHostV2RunMachine (unknown fields ignored).
type RunMachineV2 struct {
	MachineID  string         `json:"machine_id"`
	JobID      string         `json:"job_id"`
	Image      string         `json:"image"`
	Deadline   string         `json:"deadline"`
	Resources  Resources      `json:"resources"`
	Repository *RunRepository `json:"repository,omitempty"`
	Publish    *RunPublish    `json:"publish,omitempty"`
	Config     *SealedConfig  `json:"config,omitempty"`
}

// ValidateEnvelope applies v1's run machine rules (ids, deadline, resources): what PollResponseV2
// checks for every machine, so one machine with a bad image, repository or publish fails only
// itself (Validate, ValidateKubernetes), not the whole response — v1's behaviour.
func (m RunMachineV2) ValidateEnvelope() error {
	return RunMachine{MachineID: m.MachineID, JobID: m.JobID, Image: m.Image, Deadline: m.Deadline, Resources: m.Resources}.Validate()
}

// Validate applies JobHostV2RunMachine except the sealed config's own fields (checked when it is
// opened, config_undecryptable): the image is a digest reference, repository and publish are
// well formed, and publish needs repository.
func (m RunMachineV2) Validate() error {
	if err := m.ValidateEnvelope(); err != nil {
		return err
	}
	if !ValidImageRef(m.Image) {
		return errors.New("run machine: image is not a digest reference")
	}
	if r := m.Repository; r != nil && (!ValidRuntimeRepoName(r.Name) || !ValidGitRef(r.BaseRef)) {
		return errors.New("run machine: invalid repository")
	}
	if p := m.Publish; p != nil {
		if !ValidJobBranch(p.Branch) {
			return errors.New("run machine: invalid publish branch")
		}
		if m.Repository == nil {
			return errors.New("run machine: publish needs repository")
		}
	}
	return nil
}

// ValidateKubernetes is JobHostV2KubernetesRunMachine, what a kubernetes host accepts (fail
// closed): Validate plus a repository — a kubernetes host runs only runtime repositories' jobs. A
// machine that fails it is not started and is reported failed with reason config_invalid.
func (m RunMachineV2) ValidateKubernetes() error {
	if err := m.Validate(); err != nil {
		return err
	}
	if m.Repository == nil {
		return errors.New("run machine: a kubernetes host runs only runtime repositories' jobs")
	}
	return nil
}

// DesiredStateV2 is the v2 desired state.
type DesiredStateV2 struct {
	Revision int64          `json:"revision"`
	Run      []RunMachineV2 `json:"run"`
	Destroy  []string       `json:"destroy"`
}

// PollResponseV2 is the v2 poll 200 body (unknown fields ignored).
type PollResponseV2 struct {
	Version       int            `json:"version"`
	InReplyTo     string         `json:"in_reply_to"`
	HostID        string         `json:"host_id"`
	Status        string         `json:"status"`
	NextPollAfter int            `json:"next_poll_after"`
	Desired       DesiredStateV2 `json:"desired"`
}

// Validate applies JobHostV2PollResponse's envelope and limits; a response without `version: 2`
// is discarded. Each run machine's own rules are applied per machine (RunMachineV2.Validate,
// ValidateKubernetes), as in v1.
func (p PollResponseV2) Validate() error {
	if p.Version != V2Version {
		return errors.New("poll response: version must be 2")
	}
	if !ValidNonce(p.InReplyTo) || !ValidUUID(p.HostID) || (p.Status != "active" && p.Status != "draining") ||
		p.NextPollAfter < 1 || p.NextPollAfter > 60 {
		return errors.New("poll response: invalid envelope")
	}
	d := p.Desired
	if d.Revision < 0 || d.Revision > maxSafeInteger || d.Run == nil || d.Destroy == nil {
		return errors.New("poll response: desired state incomplete")
	}
	if len(d.Run) > V2MaxSlots || len(d.Destroy) > V2ReportMaxMachines {
		return errors.New("poll response: desired state too large")
	}
	seen := map[string]bool{}
	for _, m := range d.Run {
		if err := m.ValidateEnvelope(); err != nil {
			return err
		}
		if seen[m.MachineID] {
			return errors.New("poll response: duplicate machine id in run")
		}
		seen[m.MachineID] = true
	}
	for _, id := range d.Destroy {
		if !ValidUUID(id) {
			return errors.New("poll response: invalid id in destroy")
		}
	}
	return nil
}

// ParsePollResponseV2 decodes (shape rules) and validates a poll response.
func ParsePollResponseV2(data []byte) (PollResponseV2, error) {
	var p PollResponseV2
	if err := Decode(data, &p); err != nil {
		return PollResponseV2{}, fmt.Errorf("poll response: %w", err)
	}
	return p, p.Validate()
}

// ---------------------------------------------------------------- errors

// ErrorCodes is the platform's ErrorCode enum.
var ErrorCodes = []string{"invalid_request", "invalid_key", "forbidden", "not_found", "expired", "rate_limited", "internal", "insufficient_balance", "conflict", "not_permitted", "unavailable"}

// ErrorResponseV2 is every non-2xx v2 body.
type ErrorResponseV2 struct {
	Error ErrorBody `json:"error"`
}

// Validate applies JobHostV2ErrorResponse.
func (e ErrorResponseV2) Validate() error {
	if !slices.Contains(ErrorCodes, e.Error.Code) || !ValidErrorReasonV2(e.Error.Reason) {
		return errors.New("error response: unknown code or reason")
	}
	return nil
}

// JobHostPhaseLine is a strict object (in v1 too; v1's agent only builds phase lines).
func (PhaseLine) strictObject() {}
