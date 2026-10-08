// Package kubernetes is the `kubernetes` driver's pod machinery (ADR 0011, spec §4 and Appendix
// C): one pod per machine in the jobs namespace, labelled so the controller can rebuild its view
// from the cluster after a restart, a per-machine Secret written only after the pod is scheduled
// (carrying the node's boot ID — spec "S0 findings" 2 — so the job can prove it runs in its own
// kernel), deleted once the pod runs, and owner-referenced to the pod so it never outlives it.
//
// What runs in the pod comes from a PodFunc and what the Secret holds from a SecretFunc: the
// kubevm pod driver (kubevm.go: the job image's entrypoint in a VM-isolated RuntimeClass, its
// machine configuration and local section in the Secret, an outbox volume) or, in test builds
// only, the placeholder (placeholder.go, build tag kete_testdriver). The driver reads each job
// pod's log for its phase lines (pods/log) and reports pods that can't start with job-host-v2's
// failed reasons (pod_unschedulable, image_pull_failed).
//
// The driver never logs or keeps a machine configuration, never execs into a pod (S0: exec into a
// Kata job pod fails once its cgroups are set up, and the controller has no pods/exec), and every
// call honours its context.
package kubernetes

import (
	"bytes"
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
	// LabelInstance is the Helm release the pod belongs to (Selector adds it).
	LabelInstance = "app.kubernetes.io/instance"
	// SecretBootID is the per-machine Secret's node boot ID key; ConfigMountPath where job pods
	// see the Secret.
	SecretBootID    = "node_boot_id"
	ConfigMountPath = "/run/kete-config"
)

// Selector selects every pod a runner instance owns.
func Selector(instance string) string {
	return kube.LabelManaged + "=" + kube.ManagedBy + "," + LabelRole + "=" + RoleJob + "," + LabelInstance + "=" + instance
}

// PodName is a machine's pod (and Secret) name.
func PodName(machineID string) string { return "kete-job-" + machineID }

// PodFunc builds what runs for a machine: containers, runtime class, security context. The driver
// adds the name, namespace, labels, the config Secret volume and the pod-level invariants (no
// service account token, no service links, never restarted, a second deadline killer).
type PodFunc func(spec driver.Spec) (kube.Pod, error)

// SecretFunc builds the per-machine Secret's data once the pod is scheduled on node. nil: the
// node's boot ID only.
type SecretFunc func(ctx context.Context, spec driver.Spec, node kube.NodeInfo) (map[string][]byte, error)

// OutboxOptions give each machine an outbox volume (spec §4.1): a ReadWriteOnce PVC created
// before the pod, mounted at MountPath, kept after the pod ends so the publisher (P3) can read it,
// and deleted by CollectOutboxes once Hold has passed after the machine's deadline.
type OutboxOptions struct {
	Size, StorageClass, MountPath string
	Hold                          time.Duration
}

// LabelRole values and the outbox PVC's name.
const RoleOutbox = "outbox"

// OutboxName is a machine's outbox PVC.
func OutboxName(machineID string) string { return "kete-outbox-" + machineID }

// Options configure the driver.
type Options struct {
	Client    *kube.Client
	Namespace string
	// Instance is the runner's Helm release name: a label on every pod and part of the List
	// selector, so runners never touch each other's pods.
	Instance string
	// Blocked, when set, returns why starts are blocked ("" = not): the runner's admission-policy
	// guard. It must return at once (a cached result). Start refuses while it is non-empty.
	Blocked func() string
	// StartTimeout bounds a pod's time in Pending after Start; past it the machine counts as
	// crashed and is destroyed.
	StartTimeout time.Duration
	Pod          PodFunc
	Secret       SecretFunc
	Outbox       *OutboxOptions
	// ReadLogs reads each job pod's log for its phase lines (pods/log).
	ReadLogs bool
	// ImagePullGrace is how long an image pull may keep failing before the machine fails
	// image_pull_failed (default 60 s).
	ImagePullGrace time.Duration
	Log            *slog.Logger
	Now            func() time.Time
	// PollEvery is how often Start and Stop re-read a pod (default 1 s).
	PollEvery time.Duration
}

// Driver implements driver.Driver on pods.
type Driver struct {
	o Options

	mu            sync.Mutex
	secretRemoved map[string]bool
	logSeen       map[string]int
}

// New checks the options and returns a driver.
func New(o Options) (*Driver, error) {
	if o.Client == nil || o.Pod == nil || o.Namespace == "" || o.Instance == "" {
		return nil, errors.New("kubernetes driver: client, namespace, instance and pod builder are required")
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
	if o.ImagePullGrace <= 0 {
		o.ImagePullGrace = time.Minute
	}
	return &Driver{o: o, secretRemoved: map[string]bool{}, logSeen: map[string]int{}}, nil
}

func ptr[T any](v T) *T { return &v }

// Start creates the machine's pod, waits until it is scheduled, reads its node's boot ID and
// writes the machine's Secret, which the kubelet waits for before starting the containers.
func (d *Driver) Start(ctx context.Context, s driver.Spec) error {
	if !contract.ValidUUID(s.MachineID) || !contract.ValidUUID(s.JobID) {
		return errors.New("kubernetes driver: invalid machine or job id")
	}
	if b := d.StartsBlocked(); b != "" {
		return fmt.Errorf("kubernetes driver: starts blocked (%s)", b)
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
			kube.LabelManaged: kube.ManagedBy, LabelRole: RoleJob, LabelInstance: d.o.Instance,
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
	if ob := d.o.Outbox; ob != nil {
		if err := d.createOutbox(ctx, s); err != nil {
			return err
		}
		pod.Spec.Volumes = append(pod.Spec.Volumes, kube.Volume{Name: "kete-outbox", PersistentVolumeClaim: &kube.ClaimVolume{ClaimName: OutboxName(s.MachineID)}})
		for i := range pod.Spec.Containers {
			pod.Spec.Containers[i].VolumeMounts = append(pod.Spec.Containers[i].VolumeMounts, kube.VolumeMount{Name: "kete-outbox", MountPath: ob.MountPath})
		}
	}
	created, err := d.o.Client.CreatePod(ctx, pod)
	if err != nil {
		return fmt.Errorf("kubernetes driver: creating pod: %w", err)
	}
	d.event(created.Metadata, "Normal", "Created", "kete-runner created the job pod for machine "+s.MachineID)
	node := created.Spec.NodeName
	for node == "" {
		if err := sleep(ctx, d.o.PollEvery); err != nil {
			return d.notScheduled(created.Metadata, err)
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
	ni, err := d.o.Client.Node(ctx, node)
	if err != nil {
		return fmt.Errorf("kubernetes driver: node boot id: %w", err)
	}
	data := map[string][]byte{SecretBootID: []byte(ni.BootID)}
	if d.o.Secret != nil {
		if data, err = d.o.Secret(ctx, s, ni); err != nil {
			return err
		}
	}
	defer func() {
		for _, v := range data {
			clear(v)
		}
	}()
	sec := kube.NewSecret(d.o.Namespace, name, data)
	sec.Immutable = ptr(true)
	sec.Metadata.Labels = map[string]string{kube.LabelManaged: kube.ManagedBy, LabelRole: RoleJob, LabelInstance: d.o.Instance, LabelMachineID: s.MachineID}
	sec.Metadata.OwnerReferences = []kube.OwnerReference{{APIVersion: "v1", Kind: "Pod", Name: name, UID: created.Metadata.UID}}
	if _, err := d.o.Client.CreateSecret(ctx, sec); err != nil {
		if kube.IsConflict(err) {
			// Someone else's Secret under the machine's name (the admission policy should make
			// this impossible): the pod must never mount it. Delete the pod at once.
			if derr := d.o.Client.DeletePod(ctx, d.o.Namespace, name, ptr(int64(0))); derr != nil {
				d.o.Log.Error("pod_delete_failed", "machine_id", s.MachineID, "error", derr.Error())
			}
			d.event(created.Metadata, "Warning", "SecretSquatted", "a Secret named like this machine's already existed; the pod was deleted")
		}
		return fmt.Errorf("kubernetes driver: creating the machine Secret: %w", err)
	}
	return nil
}

// notScheduled is Start's error when the pod got no node in time: pod_unschedulable when the
// scheduler said so (a fresh context: Start's own has ended), else the wait's error.
func (d *Driver) notScheduled(m kube.ObjectMeta, err error) error {
	ctx, cancel := context.WithTimeout(context.Background(), kube.RequestTimeout)
	defer cancel()
	if p, gerr := d.o.Client.GetPod(ctx, d.o.Namespace, m.Name); gerr == nil && p.Metadata.UID == m.UID {
		for _, c := range p.Status.Conditions {
			if c.Type == "PodScheduled" && c.Status == "False" {
				d.event(m, "Warning", "KeteMachineFailed", "the job pod can't be scheduled: "+c.Reason)
				return &driver.FailedError{Reason: contract.ReasonPodUnschedulable, Err: fmt.Errorf("%s: %w", c.Reason, err)}
			}
		}
	}
	return fmt.Errorf("kubernetes driver: pod not scheduled: %w", err)
}

// createOutbox creates the machine's outbox PVC. One that already exists is refused: an outbox
// is never reused (the entrypoint also refuses a volume that isn't empty).
func (d *Driver) createOutbox(ctx context.Context, s driver.Spec) error {
	ob := d.o.Outbox
	pvc := kube.PVC{APIVersion: "v1", Kind: "PersistentVolumeClaim",
		Metadata: kube.ObjectMeta{Name: OutboxName(s.MachineID), Namespace: d.o.Namespace, Labels: map[string]string{
			kube.LabelManaged: kube.ManagedBy, LabelRole: RoleOutbox, LabelInstance: d.o.Instance,
			LabelMachineID: s.MachineID, LabelJobID: s.JobID, LabelDeadline: strconv.FormatInt(s.Deadline.Unix(), 10),
		}},
		Spec: kube.PVCSpec{AccessModes: []string{"ReadWriteOnce"}, Resources: &kube.Resources{Requests: map[string]string{"storage": ob.Size}}},
	}
	if ob.StorageClass != "" {
		pvc.Spec.StorageClassName = &ob.StorageClass
	}
	if _, err := d.o.Client.CreatePVC(ctx, pvc); err != nil {
		return fmt.Errorf("kubernetes driver: creating the outbox: %w", err)
	}
	return nil
}

// CollectOutboxes deletes the outbox PVCs whose machine has no pod any more and whose deadline
// (plus the grace and the kubelet's own killer) and hold time have passed. It returns how many it
// deleted. The runner calls it periodically.
func (d *Driver) CollectOutboxes(ctx context.Context) (int, error) {
	if d.o.Outbox == nil {
		return 0, nil
	}
	sel := kube.LabelManaged + "=" + kube.ManagedBy + "," + LabelRole + "=" + RoleOutbox + "," + LabelInstance + "=" + d.o.Instance
	pvcs, err := d.o.Client.ListPVCs(ctx, d.o.Namespace, sel)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, p := range pvcs {
		id := p.Metadata.Labels[LabelMachineID]
		dl, err := strconv.ParseInt(p.Metadata.Labels[LabelDeadline], 10, 64)
		if err != nil || !contract.ValidUUID(id) || p.Metadata.Name != OutboxName(id) {
			continue // not one of ours as written; left for an operator
		}
		if d.o.Now().Before(time.Unix(dl, 0).Add(contract.DeadlineGrace + time.Minute + d.o.Outbox.Hold)) {
			continue
		}
		if _, err := d.o.Client.GetPod(ctx, d.o.Namespace, PodName(id)); !kube.IsNotFound(err) {
			continue // its pod still exists (or can't be read): not yet
		}
		if err := d.o.Client.DeletePVC(ctx, d.o.Namespace, p.Metadata.Name); err != nil {
			return n, err
		}
		d.o.Log.Info("outbox_deleted", "machine_id", id)
		n++
	}
	return n, nil
}

// StartsBlocked implements driver.Blocker.
func (d *Driver) StartsBlocked() string {
	if d.o.Blocked == nil {
		return ""
	}
	return d.o.Blocked()
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
	delete(d.logSeen, id)
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
		age := time.Duration(0)
		if t, err := time.Parse(time.RFC3339, p.Metadata.CreationTimestamp); err == nil {
			age = d.o.Now().Sub(t)
		}
		if reason, err := pendingFailure(p, age, d.o.StartTimeout, d.o.ImagePullGrace); reason != "" {
			d.event(p.Metadata, "Warning", "KeteMachineFailed", "the job pod can't start: "+reason)
			return 0, &driver.FailedError{Reason: reason, Err: err}
		}
		if age > d.o.StartTimeout {
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

// pendingFailure says why a Pending pod will not start (job-host-v2 failed reasons): its image
// can't be pulled (an invalid name at once; pull errors once they persisted past pullGrace), or
// no node could take it until the start timeout.
func pendingFailure(p kube.Pod, age, startTimeout, pullGrace time.Duration) (string, error) {
	for _, c := range p.Status.ContainerStatuses {
		w := c.State.Waiting
		if w == nil {
			continue
		}
		switch w.Reason {
		case "InvalidImageName", "ErrImageNeverPull":
			return contract.ReasonImagePullFailed, errors.New(w.Reason)
		case "ErrImagePull", "ImagePullBackOff":
			if age > pullGrace {
				return contract.ReasonImagePullFailed, errors.New(w.Reason)
			}
		}
	}
	if age > startTimeout {
		for _, c := range p.Status.Conditions {
			if c.Type == "PodScheduled" && c.Status == "False" {
				return contract.ReasonPodUnschedulable, errors.New(c.Reason)
			}
		}
	}
	return "", nil
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
	pods, err := d.o.Client.ListPods(ctx, d.o.Namespace, Selector(d.o.Instance))
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

// MaxPodLog bounds how much of a job pod's log is read (its stdout holds phase lines only).
const MaxPodLog = 256 << 10

// Logs returns the job pod's log lines not returned before (the agent keeps only phase lines).
// The whole log, at most MaxPodLog, is read each time and the lines already returned skipped.
func (d *Driver) Logs(ctx context.Context, id string) ([][]byte, error) {
	if !d.o.ReadLogs {
		return nil, nil
	}
	b, err := d.o.Client.PodLog(ctx, d.o.Namespace, PodName(id), "job", MaxPodLog)
	if kube.IsNotFound(err) || isNotStarted(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(b, []byte("\n"))
	if len(b) > 0 && b[len(b)-1] == '\n' {
		lines = lines[:len(lines)-1]
	} else if len(lines) > 0 {
		lines = lines[:len(lines)-1] // a partial last line waits for the next call
	}
	d.mu.Lock()
	seen := d.logSeen[id]
	if seen > len(lines) {
		seen = len(lines)
	}
	d.logSeen[id] = len(lines)
	d.mu.Unlock()
	return lines[seen:], nil
}

// isNotStarted is the API server's answer for a container that hasn't started (400 BadRequest
// "container … is waiting to start").
func isNotStarted(err error) bool {
	var se *kube.StatusError
	return errors.As(err, &se) && se.Code == 400
}

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
