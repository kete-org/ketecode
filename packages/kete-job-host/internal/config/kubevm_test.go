package config

import (
	"strings"
	"testing"
	"time"
)

const kubeVMSection = `"namespace":"kete-system","jobs_namespace":"kete-jobs","instance":"kete-runner","admission_policies":["p"],"runtime_class_names":["kata"],
  "pod_driver":"kubevm","proxy":"http://10.20.0.5:3128","proxy_auth_file":"/etc/kete-runner/proxy/auth",
  "repositories":["gitlab:payments/api"],
  "repository_sources":[{"name":"gitlab:payments/api","clone_url":"https://gitlab.corp.example:8443/payments/api.git","clone_secret":"gitlab-payments-read"}],
  "job_pod":{"cpu":"2","memory":"4Gi","ephemeral_storage":"20Gi","outbox_size":"1Gi","internal":[{"cidr":"10.20.0.0/16","ports":[443,3128,8443]}]}`

func TestKubeVMConfig(t *testing.T) {
	c, err := Parse([]byte(kubeConfig("16", kubeVMSection)))
	if err != nil {
		t.Fatal(err)
	}
	k := c.Kube
	if k.PodDriver != PodDriverKubeVM || k.JobPod == nil || k.JobPod.OutboxHold != 24*time.Hour || k.Sources["gitlab:payments/api"].CloneSecret != "gitlab-payments-read" ||
		k.ProxyAuthFile != "/etc/kete-runner/proxy/auth" || len(k.JobPod.Internal) != 1 {
		t.Fatalf("%+v %+v", k, k.JobPod)
	}
	mut := func(old, new string) string { return kubeConfig("16", strings.Replace(kubeVMSection, old, new, 1)) }
	for name, raw := range map[string]string{
		"no job_pod":                kubeConfig("1", strings.TrimRight(strings.Split(kubeVMSection, `"job_pod"`)[0], ",\n ")),
		"repository without source": mut(`"repositories":["gitlab:payments/api"]`, `"repositories":["gitlab:payments/api","gitlab:other/x"]`),
		"source for no repository":  mut(`"name":"gitlab:payments/api","clone_url"`, `"name":"gitlab:other/x","clone_url"`),
		"http clone url":            mut(`https://gitlab.corp.example:8443`, `http://gitlab.corp.example:8443`),
		"userinfo clone url":        mut(`https://gitlab.corp.example:8443`, `https://u:p@gitlab.corp.example:8443`),
		"bad quantity":              mut(`"cpu":"2"`, `"cpu":"two"`),
		"broad internal":            mut(`"10.20.0.0/16"`, `"10.0.0.0/7"`),
		"non-canonical internal":    mut(`"10.20.0.0/16"`, `"10.20.0.1/16"`),
		"forbidden internal":        mut(`"10.20.0.0/16"`, `"169.254.0.0/16"`),
		"loopback internal":         mut(`"10.20.0.0/16"`, `"127.0.0.0/8"`),
		"no ports":                  mut(`"ports":[443,3128,8443]`, `"ports":[]`),
		"repeated port":             mut(`"ports":[443,3128,8443]`, `"ports":[443,443]`),
		"proxy auth without proxy":  mut(`"proxy":"http://10.20.0.5:3128",`, ``),
		"bad hold":                  mut(`"outbox_size":"1Gi"`, `"outbox_size":"1Gi","outbox_hold_hours":721`),
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// job_pod is the kubevm pod driver's only.
	if _, err := Parse([]byte(kubeConfig("1", okSection+`,"job_pod":{"cpu":"1","memory":"1Gi","ephemeral_storage":"1Gi","outbox_size":"1Gi"}`))); err == nil {
		t.Error("job_pod accepted for the placeholder")
	}
}

func TestKubeVMConfigReviewRules(t *testing.T) {
	mut := func(old, new string) string { return kubeConfig("16", strings.Replace(kubeVMSection, old, new, 1)) }
	for name, raw := range map[string]string{
		"dotdot clone url":     mut(`8443/payments/api.git`, `8443/payments/../api.git`),
		"ipv6 proxy literal":   mut(`"proxy":"http://10.20.0.5:3128"`, `"proxy":"http://[fd00::5]:3128"`),
		"bad access mode":      mut(`"outbox_size":"1Gi"`, `"outbox_size":"1Gi","outbox_access_mode":"ReadWriteMany"`),
		"job credential = own": mut(`"proxy_auth_file":"/etc/kete-runner/proxy/auth"`, `"proxy_auth_file":"/etc/kete-runner/proxy/auth","job_proxy_auth_file":"/etc/kete-runner/proxy/auth"`),
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	c, err := Parse([]byte(mut(`"proxy_auth_file":"/etc/kete-runner/proxy/auth"`, `"proxy_auth_file":"/etc/kete-runner/proxy/auth","job_proxy_auth_file":"/etc/kete-runner/job-proxy/auth"`)))
	if err != nil || c.Kube.JobProxyAuthFile != "/etc/kete-runner/job-proxy/auth" || c.Kube.JobPod.OutboxAccessMode != "ReadWriteOncePod" {
		t.Fatalf("%v %+v", err, c.Kube)
	}
}
