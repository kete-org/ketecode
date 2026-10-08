package config

import (
	"strings"
	"testing"
)

func TestGitLabProject(t *testing.T) {
	for _, tc := range []struct{ clone, api, base, project string }{
		{"https://gitlab.corp.example/payments/api.git", "", "https://gitlab.corp.example", "payments/api"},
		{"https://gitlab.corp.example:8443/a/b/c.git", "", "https://gitlab.corp.example:8443", "a/b/c"},
		{"https://corp.example/gitlab/a/b.git", "https://corp.example/gitlab", "https://corp.example/gitlab", "a/b"},
	} {
		b, p, err := GitLabProject(tc.clone, tc.api)
		if err != nil || b != tc.base || p != tc.project {
			t.Errorf("%s %s: %s %s %v", tc.clone, tc.api, b, p, err)
		}
	}
	for _, bad := range [][2]string{
		{"https://gitlab.corp.example/api.git", ""},                               // no namespace
		{"https://gitlab.corp.example/a/b", ""},                                   // no .git
		{"https://corp.example/gitlab/a/b.git", "https://other.example/gitlab"},   // another host
		{"https://corp.example/gitlab/a/b.git", "https://corp.example/elsewhere"}, // not under the root
		{"https://corp.example/gitlab/a/b.git", "http://corp.example/gitlab"},     // http
		{"https://corp.example/a/-bad.git", ""},                                   // a segment GitLab refuses
		{"https://u:p@corp.example/a/b.git", ""},                                  // credentials
	} {
		if _, _, err := GitLabProject(bad[0], bad[1]); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestGitLabSources(t *testing.T) {
	mut := func(old, new string) string { return kubeConfig("16", strings.Replace(kubeVMSection, old, new, 1)) }
	minted := `"clone_mode":"minted","minter_secret":"gitlab-minter","writer_secret":"gitlab-writer"`
	pub := `,"publisher":{"image":"registry.corp.example/kete/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333","config_map":"kete-publisher"}`
	c, err := Parse([]byte(mut(`"clone_secret":"gitlab-payments-read"}]`, minted+`}]`+pub)))
	if err != nil {
		t.Fatal(err)
	}
	src := c.Kube.Sources["gitlab:payments/api"]
	if src.CloneMode != CloneMinted || src.WriterSecret != "gitlab-writer" || c.Kube.Publisher == nil || c.Kube.Publisher.TimeoutSeconds != 900 || c.Kube.Publisher.Memory != "512Mi" {
		t.Fatalf("%+v %+v", src, c.Kube.Publisher)
	}
	if c, err := Parse([]byte(mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"gitlab-payments-read"}]`))); err != nil || c.Kube.Sources["gitlab:payments/api"].CloneMode != CloneStatic || c.Kube.Publisher != nil {
		t.Fatalf("static default: %v", err)
	}
	for name, raw := range map[string]string{
		"writer without publisher":  mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"gitlab-payments-read","writer_secret":"w"}]`),
		"minted with clone secret":  mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"gitlab-payments-read","clone_mode":"minted","minter_secret":"m"}]`),
		"minted without minter":     mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_mode":"minted"}]`),
		"static without secret":     mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_mode":"static"}]`),
		"unknown mode":              mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"x","clone_mode":"oauth"}]`),
		"other provider":            mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"x","provider":"github"}]`),
		"publisher image by tag":    mut(`"clone_secret":"gitlab-payments-read"}]`, minted+`}]`+strings.Replace(pub, "@sha256:3333333333333333333333333333333333333333333333333333333333333333", ":latest", 1)),
		"bad no_proxy":              mut(`"clone_secret":"gitlab-payments-read"}]`, `"clone_secret":"x"}],"no_proxy":["Bad Host"]`),
		"publisher timeout too low": mut(`"clone_secret":"gitlab-payments-read"}]`, minted+`}]`+strings.Replace(pub, `"config_map":"kete-publisher"`, `"config_map":"kete-publisher","timeout_seconds":5`, 1)),
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if !MatchNoProxy("gitlab.corp.example", []string{".corp.example"}) || MatchNoProxy("corp.example.evil", []string{".corp.example"}) || !MatchNoProxy("git.x", []string{"git.x"}) {
		t.Error("MatchNoProxy")
	}
}
