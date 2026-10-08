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
	"os"
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
	podFunc, verifier, err := podDriver(o)
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
	var wg sync.WaitGroup
	var lost error
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := el.Hold(rctx); err != nil {
			lost = err
			o.Log.Error("lease_lost", "error", err.Error(), "action", "stopping; Kubernetes restarts the controller")
			cancel()
		}
	}()
	store := &kube.SecretStore{Client: o.Kube, Namespace: k.Namespace, Name: k.StateSecret, Log: o.Log}
	storeCtx, stopStore := context.WithCancel(context.Background())
	storeDone := make(chan struct{})
	go func() { defer close(storeDone); store.Run(storeCtx) }()
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
		if lost != nil {
			return lost
		}
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
	drv, err := kdriver.New(kdriver.Options{
		Client: o.Kube, Namespace: k.JobsNamespace, StartTimeout: k.StartTimeout, Pod: podFunc, Log: o.Log, Now: o.Now, PollEvery: o.DriverPoll,
	})
	if err != nil {
		return finish(err)
	}
	a, err := agent.New(agent.Options{
		Config: o.Config, Keys: ks, Driver: drv, Verifier: verifier,
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

// podDriver picks the pod builder and image verifier for the configured pod driver.
func podDriver(o Options) (kdriver.PodFunc, image.Verifier, error) {
	k := o.Config.Kube
	switch k.PodDriver {
	case config.PodDriverPlaceholder:
		if !kdriver.PlaceholderAvailable {
			return nil, nil, errors.New("runner: pod_driver placeholder exists only in test builds (-tags kete_testdriver); this build has no pod driver for real jobs yet (enterprise runtime P2)")
		}
		v := o.Verifier
		if v == nil {
			v = placeholderVerifier()
		}
		return kdriver.Placeholder(k.RuntimeClasses[0], k.PlaceholderExit, o.Now), v, nil
	}
	return nil, nil, fmt.Errorf("runner: unknown pod driver %q", k.PodDriver)
}

// clientOptions adds the enterprise proxy and CA bundle (system roots plus the bundle) and the v2
// profile to the platform client's options.
func clientOptions(o Options) (client.Options, error) {
	co := o.ClientOptions
	co.V2 = true
	k := o.Config.Kube
	if co.Proxy == nil {
		co.Proxy = k.Proxy
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
	ks, err := keys.Generate(o.Rand)
	if err != nil {
		return keys.Keys{}, true, err
	}
	if err := ksec.Stage(ctx, ks); err != nil {
		return keys.Keys{}, false, fmt.Errorf("staging keys: %w", err)
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
