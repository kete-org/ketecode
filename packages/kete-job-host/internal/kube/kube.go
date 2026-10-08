// Package kube is the Kubernetes runner's API client (ADR 0011): a small typed REST client for
// exactly the objects the controller touches — Pods and Secrets in its two namespaces, one Lease,
// Events on job pods, `get` on Nodes (the boot-ID handoff, spec "S0 findings" 2) and the API
// server's version. It is deliberately not client-go: the controller needs a dozen calls, and a
// small surface keeps the agent's dependency set and its audit small (CLAUDE.md §12 dependencies;
// recorded in the k8s-runner-p1 task).
//
// In the cluster it authenticates with the pod's bound service account token (re-read from disk,
// the kubelet rotates it) and trusts only the cluster CA. It never uses a proxy: the API server is
// reached directly, whatever the enterprise proxy settings for the platform connection are. Every
// request has a timeout; responses are size-capped.
package kube

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// In-cluster service account paths.
const (
	SATokenPath     = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	SACAPath        = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	RequestTimeout  = 15 * time.Second
	maxResponseSize = 8 << 20
)

// Client calls the API server.
type Client struct {
	base  string
	http  *http.Client
	token func() (string, error)
}

// New returns a client for base (`https://host:port`) with token as the bearer token source. hc
// carries the TLS trust (tests pass an httptest client).
func New(base string, hc *http.Client, token func() (string, error)) *Client {
	return &Client{base: strings.TrimRight(base, "/"), http: hc, token: token}
}

// InCluster builds the client from the pod's environment: KUBERNETES_SERVICE_HOST/PORT, the
// service account token and the cluster CA.
func InCluster() (*Client, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("kube: not running in a cluster (KUBERNETES_SERVICE_HOST/PORT unset)")
	}
	ca, err := os.ReadFile(SACAPath)
	if err != nil {
		return nil, fmt.Errorf("kube: cluster CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("kube: cluster CA holds no certificate")
	}
	tr := &http.Transport{
		Proxy:                 nil, // the API server is never reached through a proxy
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: RequestTimeout,
		MaxIdleConns:          4,
		IdleConnTimeout:       90 * time.Second,
	}
	return New("https://"+net.JoinHostPort(host, port), &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, FileToken(SATokenPath)), nil
}

// FileToken reads the bearer token from path, cached for a minute (the kubelet refreshes bound
// tokens well before they expire).
func FileToken(path string) func() (string, error) {
	var mu sync.Mutex
	var tok string
	var at time.Time
	return func() (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if tok != "" && time.Since(at) < time.Minute {
			return tok, nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("kube: service account token: %w", err)
		}
		t := strings.TrimSpace(string(b))
		if t == "" {
			return "", errors.New("kube: empty service account token")
		}
		tok, at = t, time.Now()
		return tok, nil
	}
}

// StatusError is a non-2xx answer: the HTTP code and the Status object's reason.
type StatusError struct {
	Code    int
	Reason  string
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("kube: %d %s: %s", e.Code, e.Reason, e.Message)
}

// IsNotFound reports a 404.
func IsNotFound(err error) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Code == http.StatusNotFound
}

// IsConflict reports a 409 (a stale resourceVersion, or an object that already exists).
func IsConflict(err error) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Code == http.StatusConflict
}

// do sends one request. body (if not nil) is JSON-encoded; out (if not nil) receives the answer.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	tok, err := c.token()
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("kube: %s %s: %w", method, path, unwrapURL(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize+1))
	if err != nil {
		return fmt.Errorf("kube: reading %s %s: %w", method, path, unwrapURL(err))
	}
	if len(data) > maxResponseSize {
		return fmt.Errorf("kube: %s %s: response too large", method, path)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		se := &StatusError{Code: resp.StatusCode}
		var st struct {
			Reason  string `json:"reason"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &st) == nil {
			se.Reason = st.Reason
			if len(st.Message) > 300 {
				st.Message = st.Message[:300]
			}
			se.Message = st.Message
		}
		return se
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("kube: decoding %s %s: %w", method, path, err)
		}
	}
	return nil
}

func unwrapURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

func nsPath(group, ns, resource, name string) string {
	p := "/api/v1"
	if group != "" {
		p = "/apis/" + group
	}
	p += "/namespaces/" + url.PathEscape(ns) + "/" + resource
	if name != "" {
		p += "/" + url.PathEscape(name)
	}
	return p
}

// ---------------------------------------------------------------- objects

// ObjectMeta is the subset of metadata the controller reads and writes.
type ObjectMeta struct {
	Name              string            `json:"name,omitempty"`
	GenerateName      string            `json:"generateName,omitempty"`
	Namespace         string            `json:"namespace,omitempty"`
	UID               string            `json:"uid,omitempty"`
	ResourceVersion   string            `json:"resourceVersion,omitempty"`
	Labels            map[string]string `json:"labels,omitempty"`
	Annotations       map[string]string `json:"annotations,omitempty"`
	OwnerReferences   []OwnerReference  `json:"ownerReferences,omitempty"`
	CreationTimestamp string            `json:"creationTimestamp,omitempty"`
	DeletionTimestamp string            `json:"deletionTimestamp,omitempty"`
}

// OwnerReference makes an object garbage-collected with its owner.
type OwnerReference struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid"`
}

// Secret is a core/v1 Secret (Data values are raw bytes; JSON carries them base64).
type Secret struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   ObjectMeta        `json:"metadata"`
	Type       string            `json:"type,omitempty"`
	Immutable  *bool             `json:"immutable,omitempty"`
	Data       map[string][]byte `json:"data,omitempty"`
}

// NewSecret returns an Opaque Secret.
func NewSecret(ns, name string, data map[string][]byte) Secret {
	return Secret{APIVersion: "v1", Kind: "Secret", Type: "Opaque", Metadata: ObjectMeta{Name: name, Namespace: ns}, Data: data}
}

// GetSecret reads a Secret.
func (c *Client) GetSecret(ctx context.Context, ns, name string) (Secret, error) {
	var s Secret
	return s, c.do(ctx, http.MethodGet, nsPath("", ns, "secrets", name), nil, nil, &s)
}

// CreateSecret creates a Secret.
func (c *Client) CreateSecret(ctx context.Context, s Secret) (Secret, error) {
	var out Secret
	return out, c.do(ctx, http.MethodPost, nsPath("", s.Metadata.Namespace, "secrets", ""), nil, s, &out)
}

// UpdateSecret replaces a Secret; s.Metadata.ResourceVersion makes it conditional (409 if stale).
func (c *Client) UpdateSecret(ctx context.Context, s Secret) (Secret, error) {
	var out Secret
	return out, c.do(ctx, http.MethodPut, nsPath("", s.Metadata.Namespace, "secrets", s.Metadata.Name), nil, s, &out)
}

// DeleteSecret deletes a Secret; a missing one is not an error.
func (c *Client) DeleteSecret(ctx context.Context, ns, name string) error {
	err := c.do(ctx, http.MethodDelete, nsPath("", ns, "secrets", name), nil, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// Pod is the subset of core/v1 Pod the controller builds and reads.
type Pod struct {
	APIVersion string     `json:"apiVersion"`
	Kind       string     `json:"kind"`
	Metadata   ObjectMeta `json:"metadata"`
	Spec       PodSpec    `json:"spec"`
	Status     PodStatus  `json:"status,omitempty"`
}

// PodSpec is the subset of the pod spec the controller sets.
type PodSpec struct {
	RuntimeClassName              string              `json:"runtimeClassName,omitempty"`
	ServiceAccountName            string              `json:"serviceAccountName,omitempty"`
	AutomountServiceAccountToken  *bool               `json:"automountServiceAccountToken,omitempty"`
	EnableServiceLinks            *bool               `json:"enableServiceLinks,omitempty"`
	RestartPolicy                 string              `json:"restartPolicy,omitempty"`
	TerminationGracePeriodSeconds *int64              `json:"terminationGracePeriodSeconds,omitempty"`
	ActiveDeadlineSeconds         *int64              `json:"activeDeadlineSeconds,omitempty"`
	NodeName                      string              `json:"nodeName,omitempty"`
	SecurityContext               *PodSecurityContext `json:"securityContext,omitempty"`
	Containers                    []Container         `json:"containers"`
	Volumes                       []Volume            `json:"volumes,omitempty"`
}

// PodSecurityContext is the pod-level security context subset.
type PodSecurityContext struct {
	RunAsNonRoot   *bool           `json:"runAsNonRoot,omitempty"`
	RunAsUser      *int64          `json:"runAsUser,omitempty"`
	RunAsGroup     *int64          `json:"runAsGroup,omitempty"`
	SeccompProfile *SeccompProfile `json:"seccompProfile,omitempty"`
}

// SeccompProfile selects a seccomp profile.
type SeccompProfile struct {
	Type string `json:"type"`
}

// Container is the container subset.
type Container struct {
	Name            string           `json:"name"`
	Image           string           `json:"image"`
	ImagePullPolicy string           `json:"imagePullPolicy,omitempty"`
	Command         []string         `json:"command,omitempty"`
	Args            []string         `json:"args,omitempty"`
	Resources       *Resources       `json:"resources,omitempty"`
	SecurityContext *SecurityContext `json:"securityContext,omitempty"`
	VolumeMounts    []VolumeMount    `json:"volumeMounts,omitempty"`
	Env             []EnvVar         `json:"env,omitempty"`
	// TerminationMessagePolicy File (the default) makes /dev/termination-log the container's
	// termination message: the publisher's outcome (P3).
	TerminationMessagePolicy string `json:"terminationMessagePolicy,omitempty"`
}

// EnvVar is a literal environment variable.
type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Resources are requests and limits ("cpu", "memory", "ephemeral-storage").
type Resources struct {
	Requests map[string]string `json:"requests,omitempty"`
	Limits   map[string]string `json:"limits,omitempty"`
}

// SecurityContext is the container security context subset.
type SecurityContext struct {
	Privileged               *bool         `json:"privileged,omitempty"`
	AllowPrivilegeEscalation *bool         `json:"allowPrivilegeEscalation,omitempty"`
	ReadOnlyRootFilesystem   *bool         `json:"readOnlyRootFilesystem,omitempty"`
	RunAsNonRoot             *bool         `json:"runAsNonRoot,omitempty"`
	RunAsUser                *int64        `json:"runAsUser,omitempty"`
	Capabilities             *Capabilities `json:"capabilities,omitempty"`
}

// Capabilities adds and drops Linux capabilities.
type Capabilities struct {
	Add  []string `json:"add,omitempty"`
	Drop []string `json:"drop,omitempty"`
}

// VolumeMount mounts a volume.
type VolumeMount struct {
	Name      string `json:"name"`
	MountPath string `json:"mountPath"`
	ReadOnly  bool   `json:"readOnly,omitempty"`
}

// Volume is a pod volume: a Secret (the machine configuration, the publisher's credentials), a
// PVC (the outbox) or a ConfigMap (the publisher's configuration).
type Volume struct {
	Name                  string           `json:"name"`
	Secret                *SecretVolume    `json:"secret,omitempty"`
	PersistentVolumeClaim *ClaimVolume     `json:"persistentVolumeClaim,omitempty"`
	ConfigMap             *ConfigMapVolume `json:"configMap,omitempty"`
}

// ClaimVolume mounts a PersistentVolumeClaim (ReadOnly: the publisher's view of an outbox).
type ClaimVolume struct {
	ClaimName string `json:"claimName"`
	ReadOnly  bool   `json:"readOnly,omitempty"`
}

// ConfigMapVolume projects a ConfigMap.
type ConfigMapVolume struct {
	Name        string `json:"name"`
	DefaultMode *int32 `json:"defaultMode,omitempty"`
}

// SecretVolume projects a Secret.
type SecretVolume struct {
	SecretName  string `json:"secretName"`
	DefaultMode *int32 `json:"defaultMode,omitempty"`
}

// PodStatus is the status subset the drivers read.
type PodStatus struct {
	Phase             string            `json:"phase,omitempty"`
	Reason            string            `json:"reason,omitempty"`
	StartTime         string            `json:"startTime,omitempty"`
	Conditions        []PodCondition    `json:"conditions,omitempty"`
	ContainerStatuses []ContainerStatus `json:"containerStatuses,omitempty"`
}

// PodCondition is one pod condition (PodScheduled False / Unschedulable: no node fits).
type PodCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// ContainerStatus is one container's state.
type ContainerStatus struct {
	Name  string         `json:"name"`
	State ContainerState `json:"state"`
}

// ContainerState is waiting, running or terminated.
type ContainerState struct {
	Waiting *struct {
		Reason string `json:"reason"`
	} `json:"waiting,omitempty"`
	Running    *struct{} `json:"running,omitempty"`
	Terminated *struct {
		ExitCode int    `json:"exitCode"`
		Reason   string `json:"reason"`
		Message  string `json:"message,omitempty"`
	} `json:"terminated,omitempty"`
}

// Pod phases.
const (
	PodPending   = "Pending"
	PodRunning   = "Running"
	PodSucceeded = "Succeeded"
	PodFailed    = "Failed"
)

// CreatePod creates a pod.
func (c *Client) CreatePod(ctx context.Context, p Pod) (Pod, error) {
	var out Pod
	return out, c.do(ctx, http.MethodPost, nsPath("", p.Metadata.Namespace, "pods", ""), nil, p, &out)
}

// GetPod reads a pod.
func (c *Client) GetPod(ctx context.Context, ns, name string) (Pod, error) {
	var p Pod
	return p, c.do(ctx, http.MethodGet, nsPath("", ns, "pods", name), nil, nil, &p)
}

// ListPods lists the pods matching a label selector.
func (c *Client) ListPods(ctx context.Context, ns, selector string) ([]Pod, error) {
	var out []Pod
	cont := ""
	for range 1000 {
		var l struct {
			Items    []Pod `json:"items"`
			Metadata struct {
				Continue string `json:"continue"`
			} `json:"metadata"`
		}
		q := url.Values{"labelSelector": {selector}, "limit": {"500"}}
		if cont != "" {
			q.Set("continue", cont)
		}
		if err := c.do(ctx, http.MethodGet, nsPath("", ns, "pods", ""), q, nil, &l); err != nil {
			return nil, err
		}
		out = append(out, l.Items...)
		if cont = l.Metadata.Continue; cont == "" {
			return out, nil
		}
	}
	return nil, errors.New("kube: pod list did not end")
}

// DeletePod deletes a pod with a grace period (nil: the pod's own); a missing pod is not an error.
func (c *Client) DeletePod(ctx context.Context, ns, name string, grace *int64) error {
	body := map[string]any{"apiVersion": "v1", "kind": "DeleteOptions", "propagationPolicy": "Background"}
	if grace != nil {
		body["gracePeriodSeconds"] = *grace
	}
	err := c.do(ctx, http.MethodDelete, nsPath("", ns, "pods", name), nil, body, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// NodeBootID returns Node.status.nodeInfo.bootID (the kubevm boot-ID handoff: a job pod in its
// own VM sees a different boot ID than its node's).
func (c *Client) NodeBootID(ctx context.Context, node string) (string, error) {
	n, err := c.Node(ctx, node)
	return n.BootID, err
}

// NodeInfo is what the kubevm handoff reads from a Node: its boot ID and its addresses (the job's
// host-boundary probe checks none of them answers).
type NodeInfo struct {
	BootID    string
	Addresses []string // InternalIP and ExternalIP addresses, as the API lists them
	PodCIDRs  []string // spec.podCIDRs (or podCIDR)
}

// Node reads a Node's boot ID and IP addresses.
func (c *Client) Node(ctx context.Context, node string) (NodeInfo, error) {
	var n struct {
		Spec struct {
			PodCIDR  string   `json:"podCIDR"`
			PodCIDRs []string `json:"podCIDRs"`
		} `json:"spec"`
		Status struct {
			NodeInfo struct {
				BootID string `json:"bootID"`
			} `json:"nodeInfo"`
			Addresses []struct {
				Type    string `json:"type"`
				Address string `json:"address"`
			} `json:"addresses"`
		} `json:"status"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/v1/nodes/"+url.PathEscape(node), nil, nil, &n); err != nil {
		return NodeInfo{}, err
	}
	if n.Status.NodeInfo.BootID == "" {
		return NodeInfo{}, fmt.Errorf("kube: node %s reports no boot ID", node)
	}
	out := NodeInfo{BootID: n.Status.NodeInfo.BootID, PodCIDRs: n.Spec.PodCIDRs}
	if len(out.PodCIDRs) == 0 && n.Spec.PodCIDR != "" {
		out.PodCIDRs = []string{n.Spec.PodCIDR}
	}
	for _, a := range n.Status.Addresses {
		if a.Type == "InternalIP" || a.Type == "ExternalIP" {
			out.Addresses = append(out.Addresses, a.Address)
		}
	}
	return out, nil
}

// PodLog returns a container's log, at most limitBytes (the job pod's stdout: phase lines only).
func (c *Client) PodLog(ctx context.Context, ns, name, container string, limitBytes int) ([]byte, error) {
	q := url.Values{"container": {container}, "limitBytes": {strconv.Itoa(limitBytes)}}
	return c.raw(ctx, nsPath("", ns, "pods", name)+"/log", q, limitBytes)
}

// raw GETs a non-JSON body of at most max bytes.
func (c *Client) raw(ctx context.Context, path string, query url.Values, max int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	tok, err := c.token()
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kube: GET %s: %w", path, unwrapURL(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)))
	if err != nil {
		return nil, fmt.Errorf("kube: reading %s: %w", path, unwrapURL(err))
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		se := &StatusError{Code: resp.StatusCode}
		var st struct {
			Reason string `json:"reason"`
		}
		if json.Unmarshal(data, &st) == nil {
			se.Reason = st.Reason
		}
		return nil, se
	}
	return data, nil
}

// RuntimeClassHandler returns a RuntimeClass's handler, or found false (a 404; any other error
// is an error).
func (c *Client) RuntimeClassHandler(ctx context.Context, name string) (string, bool, error) {
	var rc struct {
		Handler string `json:"handler"`
	}
	err := c.do(ctx, http.MethodGet, "/apis/node.k8s.io/v1/runtimeclasses/"+url.PathEscape(name), nil, nil, &rc)
	if IsNotFound(err) {
		return "", false, nil
	}
	return rc.Handler, err == nil, err
}

// StorageClass is the part of a StorageClass the controller checks for outboxes.
type StorageClass struct {
	Provisioner  string   `json:"provisioner"`
	MountOptions []string `json:"mountOptions"`
}

// GetStorageClass reads a StorageClass.
func (c *Client) GetStorageClass(ctx context.Context, name string) (StorageClass, error) {
	var sc StorageClass
	return sc, c.do(ctx, http.MethodGet, "/apis/storage.k8s.io/v1/storageclasses/"+url.PathEscape(name), nil, nil, &sc)
}

// PVC is the subset of a PersistentVolumeClaim the controller builds and reads.
type PVC struct {
	APIVersion string     `json:"apiVersion"`
	Kind       string     `json:"kind"`
	Metadata   ObjectMeta `json:"metadata"`
	Spec       PVCSpec    `json:"spec"`
}

// PVCSpec is the claim's spec subset.
type PVCSpec struct {
	AccessModes      []string   `json:"accessModes"`
	StorageClassName *string    `json:"storageClassName,omitempty"`
	Resources        *Resources `json:"resources"`
}

// CreatePVC creates a PersistentVolumeClaim.
func (c *Client) CreatePVC(ctx context.Context, p PVC) (PVC, error) {
	var out PVC
	return out, c.do(ctx, http.MethodPost, nsPath("", p.Metadata.Namespace, "persistentvolumeclaims", ""), nil, p, &out)
}

// GetPVC reads a PersistentVolumeClaim.
func (c *Client) GetPVC(ctx context.Context, ns, name string) (PVC, error) {
	var p PVC
	return p, c.do(ctx, http.MethodGet, nsPath("", ns, "persistentvolumeclaims", name), nil, nil, &p)
}

// ListPVCs lists the claims matching a label selector (one page of up to 500: the outbox
// collector runs again).
func (c *Client) ListPVCs(ctx context.Context, ns, selector string) ([]PVC, error) {
	var l struct {
		Items []PVC `json:"items"`
	}
	q := url.Values{"labelSelector": {selector}, "limit": {"500"}}
	return l.Items, c.do(ctx, http.MethodGet, nsPath("", ns, "persistentvolumeclaims", ""), q, nil, &l)
}

// DeletePVC deletes a PersistentVolumeClaim; a missing one is not an error.
func (c *Client) DeletePVC(ctx context.Context, ns, name string) error {
	err := c.do(ctx, http.MethodDelete, nsPath("", ns, "persistentvolumeclaims", name), nil, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// ServerVersion returns the API server's gitVersion (versions.kubernetes).
func (c *Client) ServerVersion(ctx context.Context) (string, error) {
	var v struct {
		GitVersion string `json:"gitVersion"`
	}
	if err := c.do(ctx, http.MethodGet, "/version", nil, nil, &v); err != nil {
		return "", err
	}
	return v.GitVersion, nil
}

// Event is a core/v1 Event about a job pod (operators see the controller's actions with
// `kubectl describe pod`). Never carries a token or a configuration.
type Event struct {
	APIVersion     string          `json:"apiVersion"`
	Kind           string          `json:"kind"`
	Metadata       ObjectMeta      `json:"metadata"`
	InvolvedObject ObjectReference `json:"involvedObject"`
	Reason         string          `json:"reason"`
	Message        string          `json:"message"`
	Type           string          `json:"type"`
	Source         struct {
		Component string `json:"component"`
	} `json:"source"`
	FirstTimestamp string `json:"firstTimestamp"`
	LastTimestamp  string `json:"lastTimestamp"`
	Count          int    `json:"count"`
}

// ObjectReference names an event's object.
type ObjectReference struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	UID        string `json:"uid,omitempty"`
}

// RecordPodEvent creates a Normal or Warning event on a pod.
func (c *Client) RecordPodEvent(ctx context.Context, p ObjectMeta, typ, reason, message string, now time.Time) error {
	ts := now.UTC().Format(time.RFC3339)
	e := Event{
		APIVersion: "v1", Kind: "Event",
		Metadata:       ObjectMeta{GenerateName: p.Name + ".", Namespace: p.Namespace},
		InvolvedObject: ObjectReference{APIVersion: "v1", Kind: "Pod", Namespace: p.Namespace, Name: p.Name, UID: p.UID},
		Reason:         reason, Message: message, Type: typ, FirstTimestamp: ts, LastTimestamp: ts, Count: 1,
	}
	e.Source.Component = "kete-runner"
	return c.do(ctx, http.MethodPost, nsPath("", p.Namespace, "events", ""), nil, e, nil)
}

// AdmissionPolicy is the part of a ValidatingAdmissionPolicy the controller checks.
type AdmissionPolicy struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		FailurePolicy string `json:"failurePolicy"`
	} `json:"spec"`
}

// AdmissionPolicyBinding is the part of a ValidatingAdmissionPolicyBinding the controller checks.
type AdmissionPolicyBinding struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		PolicyName        string   `json:"policyName"`
		ValidationActions []string `json:"validationActions"`
	} `json:"spec"`
}

const admissionGroup = "/apis/admissionregistration.k8s.io/v1/"

// GetAdmissionPolicy reads a ValidatingAdmissionPolicy.
func (c *Client) GetAdmissionPolicy(ctx context.Context, name string) (AdmissionPolicy, error) {
	var p AdmissionPolicy
	return p, c.do(ctx, http.MethodGet, admissionGroup+"validatingadmissionpolicies/"+url.PathEscape(name), nil, nil, &p)
}

// GetAdmissionPolicyBinding reads a ValidatingAdmissionPolicyBinding.
func (c *Client) GetAdmissionPolicyBinding(ctx context.Context, name string) (AdmissionPolicyBinding, error) {
	var b AdmissionPolicyBinding
	return b, c.do(ctx, http.MethodGet, admissionGroup+"validatingadmissionpolicybindings/"+url.PathEscape(name), nil, nil, &b)
}
