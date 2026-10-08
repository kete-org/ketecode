package kubernetes

// The kubevm pod driver (enterprise runtime P2; spec §4.2, Appendix C and "S0 findings"): each
// machine is the released job image's entrypoint, profile kubevm, in a VM-isolated RuntimeClass,
// with exactly the capabilities S0 measured, no service account token, requests = limits, the
// per-job Secret (the machine configuration and the runner's local section, written once the pod
// is scheduled, with the node's boot ID) and the outbox volume.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
)

// Job pod constants (packages/kete-job-entrypoint layout: ConfigFile, OutboxDir; change together).
const (
	EntrypointPath = "/usr/local/libexec/kete/kete-job-entrypoint"
	SecretConfig   = "config.json"
	OutboxPath     = "/var/lib/kete-outbox"
	// SharedKernelTestClass is the CI-only RuntimeClass (kind: runc). Only a kete_testdriver build
	// accepts it (the runner refuses it otherwise), and only for it does the job's configuration
	// ask for the entrypoint's test-only shared-kernel mode.
	SharedKernelTestClass = "kete-test"
)

// JobCapabilities are the capabilities a kubevm job pod adds inside its own VM (spec "S0
// findings" 1: the ten measured, plus NET_BIND_SERVICE for the proxy's ports 81-83 instead of
// relying on containerd's ip_unprivileged_port_start=0). The chart's admission policy allows
// exactly these.
var JobCapabilities = []string{"NET_ADMIN", "SYS_ADMIN", "SYS_RESOURCE", "SETUID", "SETGID", "KILL", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "NET_BIND_SERVICE"}

// KubeVMOptions configure the kubevm pod and Secret builders.
type KubeVMOptions struct {
	RuntimeClass string
	// SharedKernelTest asks the job for the entrypoint's test-only shared-kernel mode: set only by a
	// kete_testdriver build for SharedKernelTestClass.
	SharedKernelTest bool
	JobPod           config.JobPod
	Boundary         contract.DataBoundary
	Sources          map[string]config.RepositorySourceFile
	// ReadSecret reads a Secret's data in the controller's namespace (the clone credential).
	ReadSecret func(ctx context.Context, name string) (map[string][]byte, error)
	// Credential, when set, obtains and checks the job's read credential (P3: static or minted,
	// base_ref resolved); its *driver.FailedError reasons are kept. nil: the static Secret only.
	Credential func(ctx context.Context, s driver.Spec, src config.RepositorySourceFile) (username, token string, err error)
	// The enterprise proxy for the jobs' egress (nil: none), its credentials and the extra
	// roots for upstream TLS; ReadProxyAuth and ReadCABundle are read for each job (rotation).
	Proxy         *url.URL
	ReadProxyAuth func() (string, error)
	ReadCABundle  func() (string, error)
}

// KubeVMPod builds a kubevm job pod (the generic driver adds the name, labels, the config
// Secret's volume and the pod-level invariants).
func KubeVMPod(o KubeVMOptions) PodFunc {
	return func(s driver.Spec) (kube.Pod, error) {
		if s.Repository == nil {
			return kube.Pod{}, errors.New("kubevm: the machine names no repository")
		}
		res := map[string]string{"cpu": o.JobPod.CPU, "memory": o.JobPod.Memory, "ephemeral-storage": o.JobPod.EphemeralStorage}
		grace := int64(30)
		return kube.Pod{Spec: kube.PodSpec{
			RuntimeClassName:              o.RuntimeClass,
			TerminationGracePeriodSeconds: &grace,
			Containers: []kube.Container{{
				Name: "job", Image: s.Image, ImagePullPolicy: "IfNotPresent",
				Command:   []string{EntrypointPath, "--config-file", ConfigMountPath + "/" + SecretConfig},
				Env:       []kube.EnvVar{{Name: "KETE_JOB_HOST_PROFILE", Value: seal.ProfileKubeVM}},
				Resources: &kube.Resources{Requests: res, Limits: res},
				SecurityContext: &kube.SecurityContext{
					Privileged: ptr(false), AllowPrivilegeEscalation: ptr(false),
					Capabilities: &kube.Capabilities{Drop: []string{"ALL"}, Add: JobCapabilities},
				},
			}},
		}}, nil
	}
}

// jobConfig is the entrypoint's kubevm configuration (packages/kete-job-entrypoint
// internal/bootenv Config and Local; change together).
type jobConfig struct {
	JobID       string   `json:"job_id"`
	PlatformURL string   `json:"platform_url"`
	ClaimToken  string   `json:"claim_token"`
	StorageHost string   `json:"storage_host"`
	HostProfile string   `json:"host_profile"`
	NodeBootID  string   `json:"node_boot_id"`
	Local       jobLocal `json:"local"`
}

type jobLocal struct {
	Repository       jobRepository         `json:"repository"`
	Boundary         contract.DataBoundary `json:"boundary"`
	Egress           *jobEgress            `json:"egress,omitempty"`
	NodeAddresses    []string              `json:"node_addresses,omitempty"`
	SharedKernelTest bool                  `json:"shared_kernel_test,omitempty"`
}

type jobRepository struct {
	Name     string `json:"name"`
	CloneURL string `json:"clone_url"`
	Ref      string `json:"ref"`
	Username string `json:"username"`
	Token    string `json:"token"`
}

type jobEgress struct {
	Proxy     string                     `json:"proxy,omitempty"`
	ProxyAuth string                     `json:"proxy_auth,omitempty"`
	CABundle  string                     `json:"ca_bundle,omitempty"`
	Internal  []config.InternalRangeFile `json:"internal,omitempty"`
}

// MaxJobConfig is the entrypoint's limit for the kubevm configuration (bootenv.MaxKubeVMConfig).
const MaxJobConfig = 48 << 10

// ProxyHostPort is the jobs' upstream proxy as kete-egress takes it: scheme://host:port (the
// scheme's default port when the URL names none).
func ProxyHostPort(u *url.URL) string {
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	return u.Scheme + "://" + net.JoinHostPort(u.Hostname(), port)
}

// KubeVMSecret builds the per-job Secret's data: config.json, from the sealed machine
// configuration, the node the pod landed on, and the runner's local section. It never logs or
// keeps it.
func KubeVMSecret(o KubeVMOptions) SecretFunc {
	return func(ctx context.Context, s driver.Spec, node kube.NodeInfo) (map[string][]byte, error) {
		mc, err := seal.ParseMachineConfig(s.Config)
		if err != nil {
			return nil, err
		}
		if mc.HostProfile != seal.ProfileKubeVM || s.Repository == nil {
			return nil, errors.New("kubevm: the machine configuration is not kubevm's or names no repository")
		}
		src, ok := o.Sources[s.Repository.Name]
		if !ok {
			return nil, &driver.FailedError{Reason: contract.ReasonRepositoryUnknown, Err: errors.New("no source for the repository")}
		}
		var username, token string
		if o.Credential != nil {
			if username, token, err = o.Credential(ctx, s, src); err != nil {
				return nil, err
			}
		} else {
			cred, err := o.ReadSecret(ctx, src.CloneSecret)
			if err != nil {
				return nil, &driver.FailedError{Reason: contract.ReasonRepositoryUnavailable, Err: fmt.Errorf("clone credential: %w", err)}
			}
			username, token = strings.TrimSpace(string(cred["username"])), strings.TrimSpace(string(cred["token"]))
			clear(cred["token"])
			if username == "" || token == "" {
				return nil, &driver.FailedError{Reason: contract.ReasonRepositoryUnavailable, Err: errors.New("the clone Secret needs keys username and token")}
			}
		}
		// The internal ranges open the proxy user's way to their ports: none may contain the node
		// or its pods (the controller already refused ranges holding the Kubernetes API).
		var addrs []netip.Addr
		for _, a := range node.Addresses {
			if ad, err := netip.ParseAddr(a); err == nil {
				addrs = append(addrs, ad)
			}
		}
		var podNets []netip.Prefix
		for _, c := range node.PodCIDRs {
			if p, err := netip.ParsePrefix(c); err == nil {
				podNets = append(podNets, p)
			}
		}
		if r := config.InternalOverlaps(o.JobPod.Internal, addrs); r != "" {
			return nil, fmt.Errorf("kubevm: internal range %s contains an address of the job's node", r)
		}
		if r := config.InternalOverlapsPrefix(o.JobPod.Internal, podNets); r != "" {
			return nil, fmt.Errorf("kubevm: internal range %s overlaps the node's pod range", r)
		}
		c := jobConfig{
			JobID: mc.JobID, PlatformURL: mc.PlatformURL, ClaimToken: mc.ClaimToken, StorageHost: mc.StorageHost,
			HostProfile: seal.ProfileKubeVM, NodeBootID: node.BootID,
			Local: jobLocal{
				Repository:       jobRepository{Name: src.Name, CloneURL: src.CloneURL, Ref: s.Repository.BaseRef, Username: username, Token: token},
				Boundary:         o.Boundary,
				NodeAddresses:    node.Addresses,
				SharedKernelTest: o.SharedKernelTest,
			},
		}
		if o.Proxy != nil || len(o.JobPod.Internal) > 0 {
			e := &jobEgress{Internal: o.JobPod.Internal}
			if o.Proxy != nil {
				e.Proxy = ProxyHostPort(o.Proxy)
				if o.ReadProxyAuth != nil {
					if e.ProxyAuth, err = o.ReadProxyAuth(); err != nil {
						return nil, fmt.Errorf("proxy credentials: %w", err)
					}
				}
				if o.ReadCABundle != nil {
					if e.CABundle, err = o.ReadCABundle(); err != nil {
						return nil, fmt.Errorf("CA bundle: %w", err)
					}
				}
			}
			c.Local.Egress = e
		}
		b, err := json.Marshal(c)
		if err != nil {
			return nil, err
		}
		if len(b) > MaxJobConfig {
			clear(b)
			return nil, fmt.Errorf("kubevm: the job configuration is %d bytes, over %d (the CA bundle?)", len(b), MaxJobConfig)
		}
		return map[string][]byte{SecretConfig: b, SecretBootID: []byte(node.BootID)}, nil
	}
}
