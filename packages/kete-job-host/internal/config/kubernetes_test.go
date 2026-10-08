package config

import (
	"strings"
	"testing"
)

const kubeImg = "docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111"

func kubeConfig(slots, section string) string {
	return `{"platform_url":"https://portal.kete.example","driver":"kubernetes","slots":` + slots + `,"reset":"none",
	  "image_allowlist":["` + kubeImg + `"],"kubernetes":{` + section + `}}`
}

const okSection = `"namespace":"kete-system","jobs_namespace":"kete-jobs","instance":"kete-runner","admission_policies":["kete-runner-jobs"],"runtime_class_names":["kata","kata-qemu"],"pod_driver":"placeholder"`

func TestKubernetesConfig(t *testing.T) {
	c, err := Parse([]byte(kubeConfig("128", okSection+`,"proxy":"http://proxy.corp:3128","ca_bundle":"/etc/kete-runner/ca/ca.crt",
	  "repositories":["gitlab:payments/api"],"boundary":{"summary":"full","denials":"full","publish_refs":"send"}`)))
	if err != nil {
		t.Fatal(err)
	}
	k := c.Kube
	if c.HostProfile() != "kubevm" || k.KeysSecret != "kete-runner-keys" || k.StateSecret != "kete-runner-state" || k.Lease != "kete-runner" ||
		k.Proxy.Host != "proxy.corp:3128" || k.Boundary.Summary != "full" || len(k.Repositories) != 1 || k.EnrollmentSecret != "" {
		t.Fatalf("%+v", k)
	}
	c, err = Parse([]byte(kubeConfig("1", okSection)))
	if err != nil || c.Kube.Boundary.Summary != "none" || c.Kube.Proxy != nil {
		t.Fatalf("defaults: %+v %v", c.Kube, err)
	}
}

func TestKubernetesConfigRefusals(t *testing.T) {
	for name, raw := range map[string]string{
		"slots over 128":         kubeConfig("129", okSection),
		"same namespaces":        kubeConfig("1", `"namespace":"a","jobs_namespace":"a","instance":"r","admission_policies":["p"],"runtime_class_names":["kata"],"pod_driver":"placeholder"`),
		"bad namespace":          kubeConfig("1", `"namespace":"Kete","jobs_namespace":"b","instance":"r","admission_policies":["p"],"runtime_class_names":["kata"],"pod_driver":"placeholder"`),
		"no runtime class":       kubeConfig("1", `"namespace":"a","jobs_namespace":"b","instance":"r","admission_policies":["p"],"runtime_class_names":[],"pod_driver":"placeholder"`),
		"repeated class":         kubeConfig("1", `"namespace":"a","jobs_namespace":"b","instance":"r","admission_policies":["p"],"runtime_class_names":["kata","kata"],"pod_driver":"placeholder"`),
		"no pod driver":          kubeConfig("1", `"namespace":"a","jobs_namespace":"b","instance":"r","admission_policies":["p"],"runtime_class_names":["kata"]`),
		"unknown pod driver":     kubeConfig("1", `"namespace":"a","jobs_namespace":"b","instance":"r","admission_policies":["p"],"runtime_class_names":["kata"],"pod_driver":"runc"`),
		"proxy credentials":      kubeConfig("1", okSection+`,"proxy":"http://user:pw@proxy.corp:3128"`),
		"proxy scheme":           kubeConfig("1", okSection+`,"proxy":"socks5://proxy.corp:1080"`),
		"relative ca":            kubeConfig("1", okSection+`,"ca_bundle":"ca.crt"`),
		"bad repository":         kubeConfig("1", okSection+`,"repositories":["https://gitlab.corp/x.git"]`),
		"bad boundary":           kubeConfig("1", okSection+`,"boundary":{"summary":"all","denials":"full","publish_refs":"send"}`),
		"exit for other image":   kubeConfig("1", okSection+`,"placeholder":{"exit_after":[{"image":"docker.io/library/x@sha256:2222222222222222222222222222222222222222222222222222222222222222","seconds":5}]}`),
		"same secret names":      kubeConfig("1", okSection+`,"keys_secret":"s","state_secret":"s"`),
		"unknown field":          kubeConfig("1", okSection+`,"privileged":true`),
		"section on firecracker": strings.Replace(kubeConfig("1", okSection), `"driver":"kubernetes"`, `"driver":"firecracker"`, 1),
		"reset on kubernetes":    strings.Replace(kubeConfig("1", okSection), `"reset":"none"`, `"reset":"provider_rebuild"`, 1),
		"no section":             `{"platform_url":"https://portal.kete.example","driver":"kubernetes","slots":1,"reset":"none","image_allowlist":["` + kubeImg + `"]}`,
		"no instance":            strings.Replace(kubeConfig("1", okSection), `"instance":"kete-runner",`, ``, 1),
		"no admission policies":  strings.Replace(kubeConfig("1", okSection), `"admission_policies":["kete-runner-jobs"],`, `"admission_policies":[],`, 1),
		"no images":              strings.Replace(kubeConfig("1", okSection), `"image_allowlist":["`+kubeImg+`"]`, `"image_allowlist":[]`, 1),
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
