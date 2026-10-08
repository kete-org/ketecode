// Package kubernetes is the `kubernetes` driver's pod machinery (ADR 0011, spec §4 and Appendix
// C): one pod per machine in the jobs namespace, labelled so the controller can rebuild its view
// from the cluster after a restart, a per-machine Secret written only after the pod is scheduled
// (carrying the node's boot ID — spec "S0 findings" 2 — so the job can prove it runs in its own
// kernel), deleted once the pod runs, and owner-referenced to the pod so it never outlives it.
//
// What runs in the pod comes from a PodFunc. This piece (P1) ships only the test-only placeholder
// (placeholder.go, build tag kete_testdriver); the VM-isolated job pod with the kubevm entrypoint
// and its machine configuration is P2. A release build has no PodFunc, so the kubernetes driver is
// inert there.
//
// The driver never logs or keeps a machine configuration, never execs into a pod (S0: exec into a
// Kata job pod fails once its cgroups are set up, and the controller has no pods/exec), and every
// call honours its context.
package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
)

// Labels every job pod carries (Appendix C).
const (
	LabelMachineID = "kete.dev/machine-id"
	LabelJobID     = "kete.dev/job-id"
	LabelDeadline  = "kete.dev/deadline" // Unix seconds
	LabelRole      = "kete.dev/role"
	RoleJob        = "job"
	// Selector selects every pod this driver owns.
	Selector = kube.LabelManaged + "=" + kube.ManagedBy + "," + LabelRole + "=" + RoleJob
	// SecretBootID is the per-machine Secret's node boot ID key; ConfigMountPath where job pods
	// see the Secret.
	SecretBootID    = "node_boot_id"
	ConfigMountPath = "/run/kete-config"
)

// PodName is a machine's pod (and Secret) name.
func PodName(machineID string) string { return "kete-job-" + machineID }

// PodFunc builds what runs for a machine: containers, runtime class, security context. The driver
// adds the name, namespace, labels, the config Secret volume and the pod-level invariants (no
// service account token, no service links, never restarted, a second deadline killer).
type PodFunc func(spec driver.Spec) (kube.Pod, error)

// Options configure the driver.
type Options struct {
	Client    *kube.Client
	Namespace string
	// StartTimeout bounds a pod's time in Pending after Start; past it the machine counts as
	// crashed and is destroyed.
	StartTimeout time.Duration
	Pod          PodFunc
	Log          *slog.Logger
	Now          func() time.Time
	// PollEvery is how often Start and Stop re-read a pod (default 1 s).
	PollEvery time.Duration
}

// Driver implements driver.Driver on pods.
type Driver struct {
	o Options

	mu            sync.Mutex
	secretRemoved map[string]bool
}

// New checks the options and returns a driver.
func New(o Options) (*Driver, error) {
	if o.Client == nil || o.Pod == nil || o.Namespace == "" {
		return nil, errors.New("kubernetes driver: client, namespace and pod builder are required")
	}
	if o.StartTimeout <= 0 {
		o.StartTimeout = 10 * time.Minute
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.PollEvery <= 0 {
		o.PollEvery = time.Second
	}
	return &Driver{o: o, secretRemoved: map[string]bool{}}, nil
}

func ptr[T any](v T) *T { return &v }

// Start creates the machine's pod, waits until it is scheduled, reads its node's boot ID and
// writes the machine's Secret, which the kubelet waits for before starting the containers.
func (d *Driver) Start(ctx context.Context, s driver.Spec) error {
	if !contract.ValidUUID(s.MachineID) || !contract.ValidUUID(s.JobID) {
		return errors.New("kubernetes driver: invalid machine or job id")
	}
	pod, err := d.o.Pod(s)
	if err != nil {
		return err
	}
	name := PodName(s.MachineID)
	pod.APIVersion, pod.Kind = "v1", "Pod"
	pod.Metadata = kube.ObjectMeta{
		Name: name, Namespace: d.o.Namespace,
		Labels: map[string]string{
			kube.LabelManaged: kube.ManagedBy, LabelRole: RoleJob,
			LabelMachineID: s.MachineID, LabelJobID: s.JobID, LabelDeadline: strconv.FormatInt(s.Deadline.Unix(), 10),
		},
	}
	pod.Spec.AutomountServiceAccountToken = ptr(false)
	pod.Spec.EnableServiceLinks = ptr(false)
	pod.Spec.RestartPolicy = "Never"
	// Appendix C: a second deadline killer, the kubelet's, a minute after the controller's own
	// (deadline + grace), so it acts only when the controller is gone.
	ads := int64(max(60, s.Deadline.Add(contract.DeadlineGrace+time.Minute).Sub(d.o.Now()).Seconds()))
	pod.Spec.ActiveDeadlineSeconds = &ads
	pod.Spec.Volumes = append(pod.Spec.Volumes, kube.Volume{Name: "kete-config", Secret: &kube.SecretVolume{SecretName: name, DefaultMode: ptr(int32(0o400))}})
	for i := range pod.Spec.Containers {
		pod.Spec.Containers[i].VolumeMounts = append(pod.Spec.Containers[i].VolumeMounts, kube.VolumeMount{Name: "kete-config", MountPath: ConfigMountPath, ReadOnly: true})
	}
	created, err := d.o.Client.CreatePod(ctx, pod)
	if err != nil {
		return fmt.Errorf("kubernetes driver: creating pod: %w", err)
	}
	d.event(created.Metadata, "Normal", "Created", "kete-runner created the job pod for machine "+s.MachineID)
	node := created.Spec.NodeName
	for node == "" {
		if err := sleep(ctx, d.o.PollEvery); err != nil {
			return fmt.Errorf("kubernetes driver: pod not scheduled: %w", err)
		}
		p, err := d.o.Client.GetPod(ctx, d.o.Namespace, name)
		if err != nil {
			return fmt.Errorf("kubernetes driver: reading pod: %w", err)
		}
		if p.Metadata.UID != created.Metadata.UID {
			return errors.New("kubernetes driver: the pod was replaced")
		}
		node = p.Spec.NodeName
	}
	bootID, err := d.o.Client.NodeBootID(ctx, node)
	if err != nil {
		return fmt.Errorf("kubernetes driver: node boot id: %w", err)
	}
	sec := kube.NewSecret(d.o.Namespace, name, map[string][]byte{SecretBootID: []byte(bootID)})
	sec.Immutable = ptr(true)
	sec.Metadata.Labels = map[string]string{kube.LabelManaged: kube.ManagedBy, LabelRole: RoleJob, LabelMachineID: s.MachineID}
	sec.Metadata.OwnerReferences = []kube.OwnerReference{{APIVersion: "v1", Kind: "Pod", Name: name, UID: created.Metadata.UID}}
	if _, err := d.o.Client.CreateSecret(ctx, sec); err != nil {
		return fmt.Errorf("kubernetes driver: creating the machine Secret: %w", err)
	}
	return nil
}

// Stop deletes the pod and its Secret and waits until the pod is gone.
func (d *Driver) Stop(ctx context.Context, id string) error {
	name := PodName(id)
	p, err := d.o.Client.GetPod(ctx, d.o.Namespace, name)
	if kube.IsNotFound(err) {
		d.forget(id)
		return d.o.Client.DeleteSecret(ctx, d.o.Namespace, name)
	}
	if err != nil {
		return err
	}
	if p.Metadata.DeletionTimestamp == "" {
		if err := d.o.Client.DeletePod(ctx, d.o.Namespace, name, nil); err != nil {
			return err
		}
		d.event(p.Metadata, "Normal", "Deleted", "kete-runner deleted the job pod")
	}
	if err := d.o.Client.DeleteSecret(ctx, d.o.Namespace, name); err != nil {
		return err
	}
	for {
		_, err := d.o.Client.GetPod(ctx, d.o.Namespace, name)
		if kube.IsNotFound(err) {
			d.forget(id)
			return nil
		}
		if err != nil {
			return err
		}
		if err := sleep(ctx, d.o.PollEvery); err != nil {
			return fmt.Errorf("kubernetes driver: pod still terminating: %w", err)
		}
	}
}

func (d *Driver) forget(id string) {
	d.mu.Lock()
	delete(d.secretRemoved, id)
	d.mu.Unlock()
}

// Status maps the pod's phase: Pending → starting (crashed past StartTimeout), Running →
// running (the machine Secret is deleted then: the job has read it), Succeeded or Failed →
// exited (the job ended; an OOM kill or the kubelet's deadline → crashed), missing → gone.
func (d *Driver) Status(ctx context.Context, id string) (driver.Status, error) {
	p, err := d.o.Client.GetPod(ctx, d.o.Namespace, PodName(id))
	if kube.IsNotFound(err) {
		return driver.StatusGone, nil
	}
	if err != nil {
		return 0, err
	}
	if p.Metadata.DeletionTimestamp != "" {
		return driver.StatusCrashed, nil // deleted by someone else (eviction, an admin)
	}
	switch p.Status.Phase {
	case kube.PodPending, "":
		if t, err := time.Parse(time.RFC3339, p.Metadata.CreationTimestamp); err == nil && d.o.Now().Sub(t) > d.o.StartTimeout {
			return driver.StatusCrashed, nil
		}
		return driver.StatusStarting, nil
	case kube.PodRunning:
		d.removeSecret(ctx, id)
		return driver.StatusRunning, nil
	case kube.PodSucceeded:
		return driver.StatusExited, nil
	case kube.PodFailed:
		if p.Status.Reason == "DeadlineExceeded" || p.Status.Reason == "Evicted" {
			return driver.StatusCrashed, nil
		}
		for _, c := range p.Status.ContainerStatuses {
			if t := c.State.Terminated; t != nil && t.Reason == "OOMKilled" {
				return driver.StatusCrashed, nil
			}
		}
		return driver.StatusExited, nil
	}
	return 0, fmt.Errorf("kubernetes driver: pod phase %q", p.Status.Phase)
}

// removeSecret deletes a running machine's Secret once (spec §4.1: the per-job Secret goes when
// the pod runs, like the config disk's unlink).
func (d *Driver) removeSecret(ctx context.Context, id string) {
	d.mu.Lock()
	done := d.secretRemoved[id]
	d.mu.Unlock()
	if done {
		return
	}
	if err := d.o.Client.DeleteSecret(ctx, d.o.Namespace, PodName(id)); err != nil {
		d.o.Log.Warn("machine_secret_delete_failed", "machine_id", id, "error", err.Error())
		return
	}
	d.mu.Lock()
	d.secretRemoved[id] = true
	d.mu.Unlock()
}

// List returns every machine whose pod carries the driver's labels. A labelled pod that isn't a
// well-formed machine pod (wrong name or id) is deleted here: nothing legitimate creates one.
func (d *Driver) List(ctx context.Context) ([]string, error) {
	pods, err := d.o.Client.ListPods(ctx, d.o.Namespace, Selector)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, p := range pods {
		id := p.Metadata.Labels[LabelMachineID]
		if contract.ValidUUID(id) && p.Metadata.Name == PodName(id) {
			ids = append(ids, id)
			continue
		}
		d.o.Log.Warn("malformed_job_pod_deleted", "pod", p.Metadata.Name)
		if err := d.o.Client.DeletePod(ctx, d.o.Namespace, p.Metadata.Name, nil); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// Logs returns no lines in P1 (the placeholder prints none); P2 reads the job pod's log for phase
// lines.
func (d *Driver) Logs(context.Context, string) ([][]byte, error) { return nil, nil }

// event records a Kubernetes Event on a job pod, best effort.
func (d *Driver) event(m kube.ObjectMeta, typ, reason, msg string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.o.Client.RecordPodEvent(ctx, m, typ, reason, msg, d.o.Now()); err != nil {
		d.o.Log.Debug("event_failed", "pod", m.Name, "error", err.Error())
	}
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
