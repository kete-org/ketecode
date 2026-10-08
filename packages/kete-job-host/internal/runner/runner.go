// Package runner is `kete-job-host kubernetes`: the enterprise Kubernetes runner's controller
// (ADR 0011, spec §4). It is the same agent (internal/agent) speaking job-host-v2, with the
// state in a Secret (kube.SecretStore), the keys in a Secret (kube.KeySecret), the
// `kubernetes` pod driver (internal/driver/kubernetes) and a Lease so that exactly one replica
// polls with the host's key. It runs as a non-root pod under Pod Security `restricted`.
//
// It does not run the VM/dedicated host guard (internal/hostguard): that guard refuses to run in
// a container because the firecracker and dedicated drivers isolate jobs with the host's own
// kernel features. The controller runs in a pod by design and isolates nothing itself — every
// job is a separate VM-isolated pod whose isolation the jobs namespace's admission policy, the
// RuntimeClass and the entrypoint's boot-ID check enforce (spec §4.2, "S0 findings" 2).
package runner

import (
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/clock"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// Options configure the runner.
type Options struct {
	Config       config.Config
	Kube         *kube.Client
	Identity     string // the pod's name (Lease holder identity)
	AgentVersion string
	HostKernel   string
	Arch         string
	Clock        clock.Checker
	Log          *slog.Logger
	// ClientOptions are the platform client's options; New fills Proxy, RootCAs and V2 from the
	// configuration unless set (tests pass their own roots and dialer).
	ClientOptions client.Options
	// Verifier checks job image signatures (nil: chosen from the pod driver).
	Verifier image.Verifier
	Now      func() time.Time
	Rand     io.Reader
	// Test seams.
	Interval       func(int) time.Duration
	SuperviseEvery time.Duration
	EnrollRetry    time.Duration
	Lease          kube.Elector
	DriverPoll     time.Duration
	// PolicyEvery is how often the admission policies are checked (default 30 s).
	PolicyEvery time.Duration
	// PullGrace is the driver's ImagePullGrace (default 60 s).
	PullGrace time.Duration
}

// ErrNotEnrolled means the runner has no keys and no enrollment token was found within ctx.
var ErrNotEnrolled = errors.New("runner: not enrolled")

// Run holds the Lease, enrolls if needed, and runs the agent until ctx ends, leadership is lost
// (kube.ErrLost) or the agent halts (agent.ErrHalted).
func Run(ctx context.Context, o Options) error {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Rand == nil {
		o.Rand = rand.Reader
	}
	if o.EnrollRetry <= 0 {
		o.EnrollRetry = 30 * time.Second
	}
	k := o.Config.Kube
	if o.Config.Driver != contract.DriverKubernetes || k == nil {
		return errors.New("runner: the configuration's driver must be kubernetes")
	}
	if o.Identity == "" {
		return errors.New("runner: no identity (KETE_RUNNER_POD_NAME)")
	}
	if !kdriver.TestBuild && slices.Contains(k.RuntimeClasses, kdriver.SharedKernelTestClass) {
		return fmt.Errorf("runner: RuntimeClass %q is kind CI's runc stand-in, accepted only by test builds; job pods need a VM-isolated RuntimeClass", kdriver.SharedKernelTestClass)
	}
	if k.PodDriver == config.PodDriverKubeVM {
		if !kdriver.TestBuild && k.JobPod.OutboxStorageClass == "" {
			return errors.New("runner: job_pod outbox_storage_class is required (a StorageClass that enforces capacity and mounts nosuid,nodev,noexec; never the cluster default by accident)")
		}
		// No internal range may open the Kubernetes API to jobs.
		if a, err := netip.ParseAddr(os.Getenv("KUBERNETES_SERVICE_HOST")); err == nil {
			if r := config.InternalOverlaps(k.JobPod.Internal, []netip.Addr{a}); r != "" {
				return fmt.Errorf("runner: internal range %s contains the Kubernetes API's address", r)
			}
		}
	}
	pd, err := podDriver(o)
	if err != nil {
		return err
	}
	copts, err := clientOptions(o)
	if err != nil {
		return err
	}

	el := o.Lease
	el.Client, el.Namespace, el.Name, el.Identity, el.Log = o.Kube, k.Namespace, k.Lease, o.Identity, o.Log
	if err := el.Acquire(ctx); err != nil {
		return err
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// stopErr is the first reason the runner must stop acting as the host: the lease lost, or the
	// state Secret changed under it.
	var stopMu sync.Mutex
	var stopErr error
	stop := func(err error, msg string) {
		stopMu.Lock()
		if stopErr == nil {
			stopErr = err
			o.Log.Error(msg, "error", err.Error(), "action", "stopping; Kubernetes restarts the controller")
		}
		stopMu.Unlock()
		cancel()
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := el.Hold(rctx); err != nil {
			stop(err, "lease_lost")
		}
	}()
	store := &kube.SecretStore{Client: o.Kube, Namespace: k.Namespace, Name: k.StateSecret, Log: o.Log,
		OnFatal: func(err error) { stop(err, "state_conflict") }}
	storeCtx, stopStore := context.WithCancel(context.Background())
	storeDone := make(chan struct{})
	go func() { defer close(storeDone); store.Run(storeCtx) }()
	guard := &policyGuard{o: o}
	// finish runs once nothing acts as the host any more (the agent has returned): write the last
	// state, stop the writer and the lease holder, and only then give the lease up — never before
	// the final state is written, and never after losing it.
	finish := func(err error) error {
		cancel()
		fctx, fcancel := context.WithTimeout(context.Background(), kube.RequestTimeout)
		if ferr := store.Flush(fctx); ferr != nil {
			o.Log.Error("state_flush_failed", "error", ferr.Error())
		}
		fcancel()
		stopStore()
		<-storeDone
		wg.Wait()
		guard.wait()
		stopMu.Lock()
		defer stopMu.Unlock()
		if stopErr != nil {
			if !errors.Is(stopErr, kube.ErrLost) {
				el.Release()
			}
			return stopErr
		}
		el.Release()
		return err
	}

	kver, err := o.Kube.ServerVersion(rctx)
	if err == nil && !contract.ValidVersion(kver) {
		err = fmt.Errorf("API server version %q is not a valid version", kver)
	}
	if err != nil {
		return finish(fmt.Errorf("runner: %w", err))
	}
	ks, err := ensureEnrolled(rctx, o, store, copts, kver)
	if err != nil {
		return finish(err)
	}
	guard.start(rctx)
	drv, err := kdriver.New(kdriver.Options{
		Client: o.Kube, Namespace: k.JobsNamespace, Instance: k.Instance, StartTimeout: k.StartTimeout, Pod: pd.pod,
		Secret: pd.secret, Outbox: pd.outbox, ReadLogs: pd.logs, ImagePullGrace: o.PullGrace,
		Log: o.Log, Now: o.Now, PollEvery: o.DriverPoll, Blocked: guard.blocked,
	})
	if err != nil {
		return finish(err)
	}
	if pd.outbox != nil {
		wg.Add(1)
		go func() { defer wg.Done(); collectOutboxes(rctx, o, drv) }()
	}
	a, err := agent.New(agent.Options{
		Config: o.Config, Keys: ks, Driver: drv, Verifier: pd.verifier,
		Client: client.New(o.Config.Origin, o.Config.Authority, o.Now, copts), Clock: o.Clock,
		Versions: contract.Versions{Agent: o.AgentVersion, HostKernel: o.HostKernel}, Log: o.Log, Now: o.Now,
		Interval: o.Interval, SuperviseEvery: o.SuperviseEvery, Store: store,
		V2: &agent.V2{Kubernetes: kver, RuntimeClasses: k.RuntimeClasses, Repositories: k.Repositories, Advertise: k.AdvertiseRepos, Boundary: k.Boundary},
	})
	if err != nil {
		return finish(err)
	}
	o.Log.Info("started", "driver", o.Config.Driver, "pod_driver", k.PodDriver, "slots", o.Config.Slots, "platform", o.Config.Origin,
		"kubernetes", kver, "proxy", copts.Proxy != nil)
	return finish(a.Run(rctx))
}

// podDriverParts is what a pod driver contributes to the kubernetes driver.
type podDriverParts struct {
	pod      kdriver.PodFunc
	secret   kdriver.SecretFunc
	outbox   *kdriver.OutboxOptions
	logs     bool
	verifier image.Verifier
}

// podDriver picks the pod builder, Secret builder, outbox and image verifier for the configured
// pod driver.
func podDriver(o Options) (podDriverParts, error) {
	k := o.Config.Kube
	switch k.PodDriver {
	case config.PodDriverPlaceholder:
		if !kdriver.PlaceholderAvailable {
			return podDriverParts{}, errors.New("runner: pod_driver placeholder exists only in test builds (-tags kete_testdriver); use kubevm")
		}
		v := o.Verifier
		if v == nil {
			v = placeholderVerifier()
		}
		return podDriverParts{pod: kdriver.Placeholder(k.RuntimeClasses[0], k.PlaceholderExit, o.Now), verifier: v}, nil
	case config.PodDriverKubeVM:
		class := k.RuntimeClasses[0]
		ko := kdriver.KubeVMOptions{
			RuntimeClass: class, SharedKernelTest: kdriver.TestBuild && class == kdriver.SharedKernelTestClass,
			JobPod: *k.JobPod, Boundary: k.Boundary, Sources: k.Sources, Proxy: k.Proxy,
			ReadSecret: func(ctx context.Context, name string) (map[string][]byte, error) {
				s, err := o.Kube.GetSecret(ctx, k.Namespace, name)
				return s.Data, err
			},
		}
		if k.JobProxyAuthFile != "" {
			// The jobs' own credential, never the controller's: every job VM holds it.
			ko.ReadProxyAuth = func() (string, error) { return readProxyAuth(k.JobProxyAuthFile) }
		}
		if k.CABundle != "" && k.Proxy != nil {
			// The jobs' kete-egress takes extra roots with its upstream proxy only (egress
			// configuration v2); without a proxy the bundle serves the controller alone.
			ko.ReadCABundle = func() (string, error) {
				b, err := os.ReadFile(k.CABundle)
				if err != nil {
					return "", err
				}
				if len(b) > maxJobCABundle {
					return "", fmt.Errorf("the CA bundle is over %d bytes, too large for a job's configuration", maxJobCABundle)
				}
				return string(b), nil
			}
		}
		v := o.Verifier
		if v == nil {
			v = kubeVMVerifier()
		}
		return podDriverParts{
			pod: kdriver.KubeVMPod(ko), secret: kdriver.KubeVMSecret(ko), logs: true, verifier: v,
			outbox: &kdriver.OutboxOptions{Size: k.JobPod.OutboxSize, StorageClass: k.JobPod.OutboxStorageClass, AccessMode: k.JobPod.OutboxAccessMode, MountPath: kdriver.OutboxPath, Hold: k.JobPod.OutboxHold},
		}, nil
	}
	return podDriverParts{}, fmt.Errorf("runner: unknown pod driver %q", k.PodDriver)
}

// maxJobCABundle is the entrypoint's limit for a job's CA bundle (bootenv).
const maxJobCABundle = 32 << 10

// readProxyAuth reads `username:password` from a mounted Secret's file.
func readProxyAuth(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	v := strings.TrimRight(string(b), "\r\n")
	if i := strings.IndexByte(v, ':'); i < 1 || len(v) > 1024 || strings.ContainsAny(v, "\r\n") {
		return "", errors.New("the proxy credentials file must hold username:password")
	}
	return v, nil
}

// collectOutboxes deletes expired outbox volumes at start and every 10 minutes.
func collectOutboxes(ctx context.Context, o Options, d *kdriver.Driver) {
	for {
		if n, err := d.CollectOutboxes(ctx); err != nil {
			o.Log.Warn("outbox_collect_failed", "error", err.Error())
		} else if n > 0 {
			o.Log.Info("outboxes_collected", "count", n)
		}
		if sleep(ctx, 10*time.Minute) != nil {
			return
		}
	}
}

// clientOptions adds the enterprise proxy and CA bundle (system roots plus the bundle) and the v2
// profile to the platform client's options.
func clientOptions(o Options) (client.Options, error) {
	co := o.ClientOptions
	co.V2 = true
	k := o.Config.Kube
	if co.Proxy == nil && k.Proxy != nil {
		u := *k.Proxy
		if k.ProxyAuthFile != "" {
			auth, err := readProxyAuth(k.ProxyAuthFile)
			if err != nil {
				return client.Options{}, fmt.Errorf("runner: proxy credentials: %w", err)
			}
			user, pass, _ := strings.Cut(auth, ":")
			u.User = url.UserPassword(user, pass) // sent as Proxy-Authorization on CONNECT only
		}
		co.Proxy = &u
	}
	if k.CABundle != "" && co.RootCAs == nil {
		pem, err := os.ReadFile(k.CABundle)
		if err != nil {
			return client.Options{}, fmt.Errorf("runner: CA bundle: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return client.Options{}, fmt.Errorf("runner: CA bundle %s holds no PEM certificate", k.CABundle)
		}
		co.RootCAs = pool
	}
	return co, nil
}

// ensureEnrolled returns the enrolled keys, enrolling under job-host-v2 first when the state
// holds no enrollment.
func ensureEnrolled(ctx context.Context, o Options, store *kube.SecretStore, copts client.Options, kver string) (keys.Keys, error) {
	k := o.Config.Kube
	ksec := kube.KeySecret{Client: o.Kube, Namespace: k.Namespace, Name: k.KeysSecret}
	st, err := store.LoadContext(ctx)
	if err != nil {
		return keys.Keys{}, fmt.Errorf("runner: state: %w", err)
	}
	if st.Enrolled() {
		ks, err := ksec.Load(ctx)
		if err != nil {
			return keys.Keys{}, fmt.Errorf("runner: the state records host %s but its keys can't be used (%w); to re-enroll, delete the %s and %s Secrets and provide a new enrollment token", st.HostID, err, k.StateSecret, k.KeysSecret)
		}
		if ks.Fingerprint() != st.Fingerprint {
			return keys.Keys{}, fmt.Errorf("runner: the keys in %s are not the keys host %s enrolled with", k.KeysSecret, st.HostID)
		}
		return ks, nil
	}
	if k.EnrollmentSecret == "" {
		return keys.Keys{}, fmt.Errorf("%w: no enrollment token Secret configured (values enrollment.tokenSecret)", ErrNotEnrolled)
	}
	for {
		ks, done, err := enrollOnce(ctx, o, store, ksec, copts, kver)
		if done {
			return ks, err
		}
		o.Log.Warn("enroll_waiting", "error", err.Error(), "retry_in", o.EnrollRetry.String())
		if serr := sleep(ctx, o.EnrollRetry); serr != nil {
			return keys.Keys{}, fmt.Errorf("%w: %v", ErrNotEnrolled, err)
		}
	}
}

// enrollOnce tries one enrollment. done is false for a retryable failure (no token Secret yet, a
// transport error or a transient answer).
func enrollOnce(ctx context.Context, o Options, store *kube.SecretStore, ksec kube.KeySecret, copts client.Options, kver string) (keys.Keys, bool, error) {
	k := o.Config.Kube
	tsec, err := o.Kube.GetSecret(ctx, k.Namespace, k.EnrollmentSecret)
	if kube.IsNotFound(err) {
		return keys.Keys{}, false, fmt.Errorf("enrollment token Secret %s/%s not found", k.Namespace, k.EnrollmentSecret)
	}
	if err != nil {
		return keys.Keys{}, false, err
	}
	token, err := enroll.ReadToken(strings.NewReader(string(tsec.Data["token"])))
	clear(tsec.Data["token"])
	if err != nil {
		return keys.Keys{}, true, fmt.Errorf("runner: enrollment Secret %s key \"token\": %w", k.EnrollmentSecret, err)
	}
	defer clear(token)
	// A retry reuses the keys staged by an earlier attempt (the platform may have recorded it).
	ks, err := ksec.LoadStaged(ctx)
	switch {
	case errors.Is(err, kube.ErrNoKeys):
		if ks, err = keys.Generate(o.Rand); err != nil {
			return keys.Keys{}, true, err
		}
		if err := ksec.Stage(ctx, ks); err != nil {
			return keys.Keys{}, false, fmt.Errorf("staging keys: %w", err)
		}
	case err != nil:
		return keys.Keys{}, false, fmt.Errorf("reading staged keys: %w", err)
	default:
		o.Log.Info("enroll_reusing_staged_keys")
	}
	var b [4]byte
	if _, err := io.ReadFull(o.Rand, b[:]); err != nil {
		return keys.Keys{}, true, err
	}
	generation := "k8s-" + o.Now().UTC().Format("20060102") + "-" + hex.EncodeToString(b[:])
	fp := ks.Fingerprint()
	o.Log.Info("enrolling", "fingerprint", sig.GroupFingerprint(fp), "action", "compare this fingerprint with the portal before approving the runner")
	req := contract.EnrollRequestV2{
		Version: contract.V2Version, EnrollmentToken: string(token),
		SigningKey: sig.EncodeKey(ks.SigningPublic()), SealingKey: sig.EncodeKey(ks.SealingPublic()),
		Facts: contract.FactsV2{
			Arch: o.Arch, Driver: contract.DriverKubernetes, Slots: o.Config.Slots, KVM: false, Reset: contract.ResetNone,
			Generation: generation, RuntimeClasses: k.RuntimeClasses,
			Versions: contract.VersionsV2{Agent: o.AgentVersion, Kubernetes: kver, HostKernel: o.HostKernel},
		},
	}
	if err := req.Validate(); err != nil {
		return keys.Keys{}, true, fmt.Errorf("runner: enroll request: %w", err)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return keys.Keys{}, true, err
	}
	resp, err := client.New(o.Config.Origin, o.Config.Authority, o.Now, copts).Post(ctx, contract.EnrollPath, fp, ks.Signing, body, 201)
	clear(body)
	var ae *client.APIError
	definitive := err == nil || (errors.As(err, &ae) && (ae.Reason == contract.ErrEnrollmentTokenInvalid || ae.Reason == contract.ErrKeyInUse))
	if definitive {
		// The token is spent (accepted or refused for good): delete it, as `enroll --token-file`.
		if derr := o.Kube.DeleteSecret(ctx, k.Namespace, k.EnrollmentSecret); derr != nil {
			o.Log.Error("enroll_token_secret_not_deleted", "error", derr.Error())
		}
	}
	if err != nil {
		if errors.As(err, &ae) {
			o.Log.Error("enroll_refused", "status", ae.Status, "reason", ae.Reason, "request_id", ae.RequestID)
			if definitive || ae.Reason == contract.ErrSignatureMalformed || ae.Reason == contract.ErrContractMismatch {
				return keys.Keys{}, true, fmt.Errorf("runner: the platform refused the enrollment (%s); create a new enrollment token Secret", ae.Reason)
			}
		}
		return keys.Keys{}, false, fmt.Errorf("enroll: %w", err)
	}
	er, err := contract.ParseEnrollResponseV2(resp.Body)
	if err != nil {
		return keys.Keys{}, true, fmt.Errorf("runner: the platform's enroll response: %w", err)
	}
	if er.Fingerprint != fp {
		return keys.Keys{}, true, errors.New("runner: the platform recorded another fingerprint than this runner's keys")
	}
	if err := ksec.Commit(ctx, ks); err != nil {
		return keys.Keys{}, true, fmt.Errorf("runner: installing the keys: %w", err)
	}
	if err := store.Save(state.State{
		Version: state.Version, HostID: er.HostID, Fingerprint: fp, Generation: generation, EnrolledStatus: er.Status, Machines: []state.Machine{},
	}); err != nil {
		return keys.Keys{}, true, err
	}
	if err := store.Flush(ctx); err != nil {
		return keys.Keys{}, true, fmt.Errorf("runner: the platform accepted host %s but the state Secret couldn't be written: %w", er.HostID, err)
	}
	o.Log.Info("enrolled", "host_id", er.HostID, "status", er.Status, "fingerprint", fp, "request_id", resp.RequestID)
	return ks, true, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// policyGuard blocks starts (cluster_unhealthy) unless every configured admission policy exists
// with failurePolicy Fail and a binding of the same name that names it and denies, and
// (runtime_class_missing) unless every configured RuntimeClass exists. The jobs
// namespace is Pod Security privileged, so without the policies nothing would stop a pod there
// from escaping its VM boundary: the controller fails closed. Checked once before the agent
// starts and then every PolicyEvery; the result is cached for the agent's lock-held calls.
type policyGuard struct {
	o    Options
	mu   sync.Mutex
	why  string
	done chan struct{}
}

func (g *policyGuard) blocked() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.why
}

func (g *policyGuard) check(ctx context.Context) {
	why := ""
	for _, name := range g.o.Config.Kube.AdmissionPolicies {
		if why != "" {
			break
		}
		p, err := g.o.Kube.GetAdmissionPolicy(ctx, name)
		if err == nil && p.Spec.FailurePolicy != "Fail" {
			err = errors.New("failurePolicy is not Fail")
		}
		var b kube.AdmissionPolicyBinding
		if err == nil {
			b, err = g.o.Kube.GetAdmissionPolicyBinding(ctx, name)
		}
		if err == nil && (b.Spec.PolicyName != name || !slices.Contains(b.Spec.ValidationActions, "Deny")) {
			err = errors.New("the binding does not deny with this policy")
		}
		if err != nil {
			why = contract.BlockedClusterUnhealthy
			g.o.Log.Error("admission_policy_missing", "policy", name, "error", err.Error(), "action", "starts blocked until it is restored")
			break
		}
	}
	// Every configured RuntimeClass must exist (job-host-v2 runtime_class_missing): a pod naming
	// a missing one would never start, and the platform shouldn't place jobs here meanwhile.
	for _, name := range g.o.Config.Kube.RuntimeClasses {
		if why != "" {
			break
		}
		handler, ok, err := g.o.Kube.RuntimeClassHandler(ctx, name)
		switch {
		case err != nil:
			why = contract.BlockedClusterUnhealthy
			g.o.Log.Error("runtime_class_check_failed", "runtime_class", name, "error", err.Error(), "action", "starts blocked")
		case !ok:
			why = contract.BlockedRuntimeClassMissing
			g.o.Log.Error("runtime_class_missing", "runtime_class", name, "action", "starts blocked until it exists")
		case !kdriver.TestBuild && sharedKernelHandlers[strings.ToLower(handler)]:
			// A RuntimeClass whose handler is a shared-kernel runtime is not VM-isolated whatever
			// its name says (the entrypoint would refuse each job; the controller refuses first).
			why = contract.BlockedClusterUnhealthy
			g.o.Log.Error("runtime_class_not_vm_isolated", "runtime_class", name, "handler", handler, "action", "starts blocked")
		}
	}
	if why == "" {
		why = g.checkStorageClass(ctx)
	}
	g.mu.Lock()
	if g.why != why && why == "" {
		g.o.Log.Info("admission_policies_ok")
	}
	g.why = why
	g.mu.Unlock()
}

// sharedKernelHandlers are container runtimes that share the node's kernel (or, for gVisor, lack
// what the entrypoint needs): never a job pod's RuntimeClass handler outside test builds.
var sharedKernelHandlers = map[string]bool{"runc": true, "crun": true, "runsc": true, "gvisor": true, "youki": true}

// localProvisioners write volumes into node directories (0777, no capacity limit, no mount
// options): never an outbox outside test builds.
var localProvisioners = map[string]bool{
	"rancher.io/local-path": true, "kubernetes.io/no-provisioner": true, "k8s.io/minikube-hostpath": true,
	"microk8s.io/hostpath": true, "docker.io/hostpath": true, "hostpath.csi.k8s.io": true, "openebs.io/local": true,
	"kubernetes.io/host-path": true,
}

// outboxMountOptions must all be on an outbox StorageClass outside test builds: the volume is
// written by a job VM and read by the publisher, never executed.
var outboxMountOptions = []string{"nosuid", "nodev", "noexec"}

// checkStorageClass checks the outbox StorageClass (kubevm): it exists, isn't a node-directory
// provisioner and mounts nosuid,nodev,noexec. Test builds (kind's local-path) skip the last two.
func (g *policyGuard) checkStorageClass(ctx context.Context) string {
	jp := g.o.Config.Kube.JobPod
	if jp == nil || jp.OutboxStorageClass == "" {
		return ""
	}
	sc, err := g.o.Kube.GetStorageClass(ctx, jp.OutboxStorageClass)
	if err != nil {
		g.o.Log.Error("outbox_storage_class_check_failed", "storage_class", jp.OutboxStorageClass, "error", err.Error(), "action", "starts blocked")
		return contract.BlockedClusterUnhealthy
	}
	if kdriver.TestBuild {
		return ""
	}
	if localProvisioners[sc.Provisioner] {
		g.o.Log.Error("outbox_storage_class_refused", "storage_class", jp.OutboxStorageClass, "provisioner", sc.Provisioner,
			"reason", "node-directory provisioner", "action", "starts blocked")
		return contract.BlockedClusterUnhealthy
	}
	for _, o := range outboxMountOptions {
		if !slices.Contains(sc.MountOptions, o) {
			g.o.Log.Error("outbox_storage_class_refused", "storage_class", jp.OutboxStorageClass, "reason", "mountOptions lacks "+o, "action", "starts blocked")
			return contract.BlockedClusterUnhealthy
		}
	}
	return ""
}

func (g *policyGuard) start(ctx context.Context) {
	every := g.o.PolicyEvery
	if every <= 0 {
		every = 30 * time.Second
	}
	g.check(ctx)
	g.done = make(chan struct{})
	go func() {
		defer close(g.done)
		for sleep(ctx, every) == nil {
			g.check(ctx)
		}
	}()
}

func (g *policyGuard) wait() {
	if g.done != nil {
		<-g.done
	}
}

// CacheDir is the controller's writable cache (the chart mounts an emptyDir): the Sigstore TUF
// metadata for job image verification.
const CacheDir = "/var/cache/kete-runner"
