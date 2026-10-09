package kubernetes

// Publisher pods (enterprise runtime P3; spec §4.1, §4.5, Appendix C): once a job pod has exited
// and the platform has authorized publishing, the controller starts `kete-publish-<machine>` in the
// jobs namespace. It runs the runner image (trusted code only, `kete-job-host publish`), in the
// job pods' VM-isolated RuntimeClass, non-root, no capabilities, read-only root file system; it
// mounts the job's outbox read-only (the StorageClass mounts it nosuid,nodev,noexec), the
// publisher configuration ConfigMap the chart renders (the controller can't change it), the
// repository's writer Secret (which the controller can't read), and optionally the CA bundle and
// proxy credential Secrets. It writes its outcome — fixed codes only — as its termination message,
// which the controller reads from the pod status. The admission policy pins every one of these
// properties, so the controller can't make a publisher pod run anything else.

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
)

// Publisher pod constants (the chart's admission policy pins the same values; change together).
const (
	RolePublish      = "publish"
	PublisherCommand = "/usr/local/bin/kete-job-host"
	PublishConfigDir = "/etc/kete-publish"         // the publisher ConfigMap (publish.json)
	PublishWriterDir = "/etc/kete-publish-writers" // <dir>/<secret>/token
	PublishCADir     = "/etc/kete-publish-ca"      // ca.crt
	PublishProxyDir  = "/etc/kete-publish-proxy"   // auth
	PublishContainer = "publish"
	publishUID       = int64(65532)
)

// PublishPodName is a machine's publisher pod.
func PublishPodName(machineID string) string { return "kete-publish-" + machineID }

// PublishOptions configure publisher pods.
type PublishOptions struct {
	Image, RuntimeClass, ConfigMap string
	CASecret, ProxyAuthSecret      string
	CPU, Memory                    string
	Timeout                        time.Duration
	// Writers maps a repository name to its writer Secret in the jobs namespace.
	Writers map[string]string
	// BaseSHA returns the commit the controller resolved the machine's base_ref to ("" unknown).
	BaseSHA func(machineID string) string
}

func publishSelector(instance string) string {
	return kube.LabelManaged + "=" + kube.ManagedBy + "," + LabelRole + "=" + RolePublish + "," + LabelInstance + "=" + instance
}

// CanPublish implements driver.Publisher.
func (d *Driver) CanPublish(repository string) bool {
	return d.o.Publish != nil && d.o.Outbox != nil && d.o.Publish.Writers[repository] != ""
}

// EndJob implements driver.Publisher: the job pod and its Secret go, the outbox stays.
func (d *Driver) EndJob(ctx context.Context, id string) error { return d.stopJob(ctx, id) }

// PublishPod builds a machine's publisher pod.
func (d *Driver) PublishPod(s driver.PublishSpec) (kube.Pod, error) {
	po := d.o.Publish
	if po == nil || d.o.Outbox == nil {
		return kube.Pod{}, errors.New("kubernetes driver: publishing is not configured")
	}
	writer := po.Writers[s.Repository.Name]
	if writer == "" {
		return kube.Pod{}, fmt.Errorf("kubernetes driver: repository %s has no writer", s.Repository.Name)
	}
	if !contract.ValidUUID(s.MachineID) || !contract.ValidUUID(s.JobID) || !contract.ValidRuntimeRepoName(s.Repository.Name) ||
		!contract.ValidGitRef(s.Repository.BaseRef) || !contract.ValidJobBranch(s.Branch) {
		return kube.Pod{}, errors.New("kubernetes driver: invalid publish request")
	}
	baseSHA := "none"
	if po.BaseSHA != nil {
		if v := po.BaseSHA(s.MachineID); contract.ValidGitSHA(v) {
			baseSHA = v
		}
	}
	ro, mode := int32(0o444), int32(0o444)
	res := map[string]string{"cpu": po.CPU, "memory": po.Memory}
	grace := int64(10)
	ads := int64(po.Timeout.Seconds())
	pod := kube.Pod{
		APIVersion: "v1", Kind: "Pod",
		Metadata: kube.ObjectMeta{
			Name: PublishPodName(s.MachineID), Namespace: d.o.Namespace,
			Labels: map[string]string{
				kube.LabelManaged: kube.ManagedBy, LabelRole: RolePublish, LabelInstance: d.o.Instance,
				LabelMachineID: s.MachineID, LabelJobID: s.JobID,
			},
		},
		Spec: kube.PodSpec{
			RuntimeClassName: po.RuntimeClass, AutomountServiceAccountToken: ptr(false), EnableServiceLinks: ptr(false),
			RestartPolicy: "Never", TerminationGracePeriodSeconds: &grace, ActiveDeadlineSeconds: &ads,
			SecurityContext: &kube.PodSecurityContext{
				RunAsNonRoot: ptr(true), RunAsUser: ptr(publishUID), RunAsGroup: ptr(publishUID),
				SeccompProfile: &kube.SeccompProfile{Type: "RuntimeDefault"},
			},
			Containers: []kube.Container{{
				Name: PublishContainer, Image: po.Image, ImagePullPolicy: "IfNotPresent",
				Command: []string{PublisherCommand},
				Args: []string{"publish", "--machine", s.MachineID, "--job", s.JobID, "--repository", s.Repository.Name,
					"--base-ref", s.Repository.BaseRef, "--branch", s.Branch, "--base-sha", baseSHA, "--open-mr=" + strconv.FormatBool(s.OpenMR)},
				Resources:                &kube.Resources{Requests: res, Limits: res},
				TerminationMessagePolicy: "File",
				SecurityContext: &kube.SecurityContext{
					Privileged: ptr(false), AllowPrivilegeEscalation: ptr(false), ReadOnlyRootFilesystem: ptr(true),
					RunAsNonRoot: ptr(true), Capabilities: &kube.Capabilities{Drop: []string{"ALL"}},
				},
				VolumeMounts: []kube.VolumeMount{
					{Name: "kete-outbox", MountPath: OutboxPath, ReadOnly: true},
					{Name: "kete-publish-config", MountPath: PublishConfigDir, ReadOnly: true},
					{Name: "kete-publish-writer", MountPath: PublishWriterDir + "/" + writer, ReadOnly: true},
				},
			}},
			Volumes: []kube.Volume{
				{Name: "kete-outbox", PersistentVolumeClaim: &kube.ClaimVolume{ClaimName: OutboxName(s.MachineID), ReadOnly: true}},
				{Name: "kete-publish-config", ConfigMap: &kube.ConfigMapVolume{Name: po.ConfigMap, DefaultMode: &ro}},
				{Name: "kete-publish-writer", Secret: &kube.SecretVolume{SecretName: writer, DefaultMode: &mode}},
			},
		},
	}
	c := &pod.Spec.Containers[0]
	if po.CASecret != "" {
		c.VolumeMounts = append(c.VolumeMounts, kube.VolumeMount{Name: "kete-publish-ca", MountPath: PublishCADir, ReadOnly: true})
		pod.Spec.Volumes = append(pod.Spec.Volumes, kube.Volume{Name: "kete-publish-ca", Secret: &kube.SecretVolume{SecretName: po.CASecret, DefaultMode: &mode}})
	}
	if po.ProxyAuthSecret != "" {
		c.VolumeMounts = append(c.VolumeMounts, kube.VolumeMount{Name: "kete-publish-proxy", MountPath: PublishProxyDir, ReadOnly: true})
		pod.Spec.Volumes = append(pod.Spec.Volumes, kube.Volume{Name: "kete-publish-proxy", Secret: &kube.SecretVolume{SecretName: po.ProxyAuthSecret, DefaultMode: &mode}})
	}
	return pod, nil
}

// StartPublish implements driver.Publisher: it creates the publisher pod. One that already exists
// for this machine is kept (a restart between creating it and recording it).
func (d *Driver) StartPublish(ctx context.Context, s driver.PublishSpec) error {
	pod, err := d.PublishPod(s)
	if err != nil {
		return err
	}
	if _, err := d.o.Client.GetPVC(ctx, d.o.Namespace, OutboxName(s.MachineID)); err != nil {
		return fmt.Errorf("kubernetes driver: the machine's outbox: %w", err)
	}
	created, err := d.o.Client.CreatePod(ctx, pod)
	if kube.IsConflict(err) {
		p, gerr := d.o.Client.GetPod(ctx, d.o.Namespace, pod.Metadata.Name)
		if gerr == nil && p.Metadata.Labels[LabelMachineID] == s.MachineID && p.Metadata.Labels[LabelRole] == RolePublish {
			return nil
		}
		return fmt.Errorf("kubernetes driver: a pod named like the publisher exists: %w", err)
	}
	if err != nil {
		return fmt.Errorf("kubernetes driver: creating the publisher pod: %w", err)
	}
	d.event(created.Metadata, "Normal", "Created", "kete-runner started the publisher for machine "+s.MachineID)
	return nil
}

// MaxOutcome bounds the publisher's termination message (Kubernetes keeps at most 4096 bytes).
const MaxOutcome = 4096

// PublishResult implements driver.Publisher: the outcome from the publisher pod's termination
// message once the pod has ended. A pod gone, deleted, stuck pending past its timeout, or ended
// without a valid outcome is failed/publisher_failed.
func (d *Driver) PublishResult(ctx context.Context, id string) (contract.PublishOutcome, bool, error) {
	failed := contract.PublishOutcome{Status: contract.PublishFailed, Reason: "publisher_failed"}
	p, err := d.o.Client.GetPod(ctx, d.o.Namespace, PublishPodName(id))
	if kube.IsNotFound(err) {
		d.o.Log.Warn("publisher_pod_missing", "machine_id", id)
		return failed, true, nil
	}
	if err != nil {
		return contract.PublishOutcome{}, false, err
	}
	timeout := time.Duration(0)
	if d.o.Publish != nil {
		timeout = d.o.Publish.Timeout
	}
	// An unreadable creation time counts as timed out (fail closed).
	age := timeout + 3*time.Minute
	if t, err := time.Parse(time.RFC3339, p.Metadata.CreationTimestamp); err == nil {
		age = d.o.Now().Sub(t)
	}
	switch {
	case p.Metadata.DeletionTimestamp != "":
		return failed, true, nil
	case p.Status.Phase == kube.PodSucceeded || p.Status.Phase == kube.PodFailed:
		for _, c := range p.Status.ContainerStatuses {
			if c.Name != PublishContainer || c.State.Terminated == nil {
				continue
			}
			if o, ok := ParseOutcome([]byte(c.State.Terminated.Message)); ok {
				return o, true, nil
			}
		}
		d.o.Log.Warn("publisher_no_outcome", "machine_id", id, "phase", p.Status.Phase)
		return failed, true, nil
	case age > timeout+2*time.Minute:
		// Past its own activeDeadlineSeconds by a margin: whatever it is doing, it is over.
		d.o.Log.Warn("publisher_timed_out", "machine_id", id, "phase", p.Status.Phase)
		return failed, true, nil
	}
	return contract.PublishOutcome{}, false, nil
}

// ParseOutcome decodes a publisher's termination message strictly as a publish outcome.
func ParseOutcome(b []byte) (contract.PublishOutcome, bool) {
	if len(b) == 0 || len(b) > MaxOutcome {
		return contract.PublishOutcome{}, false
	}
	var o contract.PublishOutcome
	if contract.Decode(b, &o) != nil || o.Validate() != nil {
		return contract.PublishOutcome{}, false
	}
	return o, true
}

// DiscardOutputs implements driver.Publisher.
func (d *Driver) DiscardOutputs(ctx context.Context, id string, keepOutputs bool) error {
	if err := d.o.Client.DeletePod(ctx, d.o.Namespace, PublishPodName(id), nil); err != nil {
		return err
	}
	if d.o.Forget != nil {
		d.o.Forget(id)
	}
	if keepOutputs || d.o.Outbox == nil {
		return nil
	}
	if err := d.o.Client.DeletePVC(ctx, d.o.Namespace, OutboxName(id)); err != nil {
		return err
	}
	d.o.Log.Info("outbox_deleted", "machine_id", id)
	return nil
}
