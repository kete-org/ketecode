package bootenv

import (
	"bytes"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

const nodeBoot = "26ab45b9-0d3c-4c1e-9b8a-1f2e3d4c5b6a"

func goodLocal() *Local {
	return &Local{
		Repository: LocalRepository{Name: "gitlab:payments/api", CloneURL: "https://gitlab.corp.example:8443/payments/api.git", Ref: "main", Username: "deploy-token", Token: "gldt-0123456789abcdef"},
		Boundary:   LocalBoundary{Summary: "none", Denials: "actions", PublishRefs: "send"},
		Egress: &LocalEgress{Proxy: "http://proxy.corp.example:3128", ProxyAuth: "svc:pw",
			Internal: []InternalRange{{CIDR: "10.20.0.0/16", Ports: []int{443, 3128, 8443}}}},
		NodeAddresses: []string{"10.0.0.7"},
	}
}

func goodKubeVM() Config {
	return Config{
		JobID: "0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c", PlatformURL: "https://platform.kete.test", ClaimToken: goodToken,
		StorageHost: "storage.kete.test", HostProfile: "kubevm", NodeBootID: nodeBoot, Local: goodLocal(),
	}
}

func TestKubeVMConfig(t *testing.T) {
	c, err := ParseKubeVMConfig(marshal(t, goodKubeVM()))
	if err != nil || c.Local == nil || c.Local.Repository.Name != "gitlab:payments/api" {
		t.Fatalf("good kubevm config: %+v %v", c, err)
	}
	// Never on a pipe, and a --config-file configuration is kubevm's only.
	if _, err := ParseConfig(marshal(t, goodKubeVM())); err == nil {
		t.Error("ParseConfig (the pipe) accepted kubevm")
	}
	if _, err := ParseKubeVMConfig(marshal(t, goodConfig())); err == nil {
		t.Error("ParseKubeVMConfig accepted a dedicated configuration")
	}
	mut := func(f func(*Config)) []byte {
		c := goodKubeVM()
		l := *c.Local
		c.Local = &l
		f(&c)
		return marshal(t, c)
	}
	bad := map[string][]byte{
		"no boot id":         mut(func(c *Config) { c.NodeBootID = "" }),
		"bad boot id":        mut(func(c *Config) { c.NodeBootID = "not-a-uuid" }),
		"no local":           mut(func(c *Config) { c.Local = nil }),
		"bad repo name":      mut(func(c *Config) { c.Local.Repository.Name = "https://gitlab.corp/x" }),
		"http clone url":     mut(func(c *Config) { c.Local.Repository.CloneURL = "http://gitlab.corp.example/x.git" }),
		"userinfo clone url": mut(func(c *Config) { c.Local.Repository.CloneURL = "https://u:p@gitlab.corp.example/x.git" }),
		"ip clone url":       mut(func(c *Config) { c.Local.Repository.CloneURL = "https://10.0.0.1/x.git" }),
		"dotdot clone url":   mut(func(c *Config) { c.Local.Repository.CloneURL = "https://gitlab.corp.example/a/../x.git" }),
		"bad ref":            mut(func(c *Config) { c.Local.Repository.Ref = "../main" }),
		"colon username":     mut(func(c *Config) { c.Local.Repository.Username = "a:b" }),
		"no token":           mut(func(c *Config) { c.Local.Repository.Token = "" }),
		"bad boundary":       mut(func(c *Config) { c.Local.Boundary.Summary = "everything" }),
		"proxy with path":    mut(func(c *Config) { c.Local.Egress = &LocalEgress{Proxy: "http://proxy.corp.example:3128/x"} }),
		"auth without proxy": mut(func(c *Config) { c.Local.Egress = &LocalEgress{ProxyAuth: "a:b"} }),
		"ca bundle not pem":  mut(func(c *Config) { c.Local.Egress = &LocalEgress{Proxy: "http://p.example:3128", CABundle: "nope"} }),
		"non-canonical cidr": mut(func(c *Config) {
			c.Local.Egress = &LocalEgress{Internal: []InternalRange{{CIDR: "10.20.0.1/16", Ports: []int{443}}}}
		}),
		"no ports":            mut(func(c *Config) { c.Local.Egress = &LocalEgress{Internal: []InternalRange{{CIDR: "10.20.0.0/16"}}} }),
		"bad node address":    mut(func(c *Config) { c.Local.NodeAddresses = []string{"node-1"} }),
		"local for dedicated": marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "dedicated", HostGeneration: "g", Local: goodLocal()}),
		"oversize":            append([]byte(`{"job_id":"`), bytes.Repeat([]byte("a"), MaxKubeVMConfig)...),
	}
	if !hostprofile.SharedKernelTestBuild {
		bad["shared-kernel test mode in a release build"] = mut(func(c *Config) { c.Local.SharedKernelTest = true })
	}
	for name, raw := range bad {
		if _, err := ParseKubeVMConfig(raw); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestKubeVMValuesRoundTrip(t *testing.T) {
	env := map[string]string{"KUBERNETES_SERVICE_HOST": "10.96.0.1", "KUBERNETES_SERVICE_PORT": "443", hostprofile.Var: "kubevm"}
	v, err := FromConfig(goodKubeVM(), func(k string) string { return env[k] })
	if err != nil || v.Source != string(hostprofile.SourceFile) || v.KubeAPI != "10.96.0.1:443" || v.NodeBootID != nodeBoot || v.Local == nil {
		t.Fatalf("FromConfig: %+v %v", v, err)
	}
	b, err := Encode(v)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Decode(bytes.NewReader(b))
	if err != nil || back.Local == nil || back.Local.Repository.Token != v.Local.Repository.Token || back.KubeAPI != v.KubeAPI {
		t.Fatalf("Decode: %+v %v", back, err)
	}
	// A kubevm value set claiming the pipe as its source is refused.
	v.Source = string(hostprofile.SourcePipe)
	b, _ = Encode(v)
	if _, err := Decode(bytes.NewReader(b)); err == nil {
		t.Error("kubevm values from a pipe were accepted")
	}
	// The Kubernetes API is only for kubevm.
	d, _ := FromConfig(goodConfig(), func(string) string { return "" })
	d.KubeAPI = "10.96.0.1:443"
	b, _ = Encode(d)
	if _, err := Decode(bytes.NewReader(b)); err == nil || !strings.Contains(err.Error(), "kube_api") {
		t.Errorf("kube_api on dedicated: %v", err)
	}
}

func TestCloneTarget(t *testing.T) {
	for in, want := range map[string][2]string{
		"https://gitlab.corp.example/payments/api.git":      {"https://gitlab.corp.example/payments/api.git", "gitlab.corp.example"},
		"https://gitlab.corp.example:443/payments/api.git":  {"https://gitlab.corp.example/payments/api.git", "gitlab.corp.example"},
		"https://gitlab.corp.example:8443/payments/api.git": {"https://gitlab.corp.example:8443/payments/api.git", "gitlab.corp.example:8443"},
	} {
		u, e, err := CloneTarget(in)
		if err != nil || u != want[0] || e != want[1] {
			t.Errorf("%s: %s %s %v", in, u, e, err)
		}
	}
	for _, bad := range []string{"https://gitlab.corp.example", "https://gitlab.corp.example:0/x", "https://gitlab.corp.example:08443/x", "https://gitlab.corp.example/x?y=1"} {
		if _, _, err := CloneTarget(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
