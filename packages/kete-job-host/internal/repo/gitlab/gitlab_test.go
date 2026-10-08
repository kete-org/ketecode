package gitlab

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBranchProtection(t *testing.T) {
	b := func(p, c *bool) Branch { return Branch{Protected: p, CanPush: c} }
	yes, no := true, false
	for _, tc := range []struct {
		b    Branch
		want Protection
	}{
		{b(&yes, &no), Protected},
		{b(&yes, &yes), Unprotected}, // a Maintainer writer where Maintainers may push
		{b(&no, &no), Unprotected},
		{b(nil, &no), Unknown},
		{b(&yes, nil), Unknown},
	} {
		if got := BranchProtection(tc.b); got != tc.want {
			t.Errorf("%+v: %s, want %s", tc.b, got, tc.want)
		}
	}
}

func TestClientCodesAndHeaders(t *testing.T) {
	var gotPath, gotToken string
	status := http.StatusOK
	body := `{"id":7,"path_with_namespace":"group/sub/proj","default_branch":"main"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotToken = r.URL.EscapedPath(), r.Header.Get("PRIVATE-TOKEN")
		if strings.HasPrefix(r.URL.Path, "/redirect/") {
			http.Redirect(w, r, "https://elsewhere.example/", http.StatusFound)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	c := New(srv.URL, "group/sub/proj", "glpat-secret-token-value", nil)
	p, err := c.GetProject(context.Background())
	if err != nil || p.ID != 7 || gotPath != "/api/v4/projects/group%2Fsub%2Fproj" || gotToken != "glpat-secret-token-value" {
		t.Fatalf("%+v %v %s", p, err, gotPath)
	}
	body = `{"id":7,"path_with_namespace":"other/proj","default_branch":"main"}`
	if _, err := c.GetProject(context.Background()); !IsCode(err, CodeInvalidResponse) {
		t.Errorf("a renamed project: %v", err)
	}
	for s, code := range map[int]string{401: CodeUnauthorized, 403: CodeForbidden, 404: CodeNotFound, 409: CodeConflict, 429: CodeUnavailable, 502: CodeUnavailable, 422: CodeRefused} {
		status = s
		_, err := c.GetBranch(context.Background(), "kete/job/x")
		if !IsCode(err, code) || strings.Contains(err.Error(), "glpat-") {
			t.Errorf("%d: %v", s, err)
		}
	}
	if !strings.Contains(gotPath, "/repository/branches/kete%2Fjob%2Fx") {
		t.Errorf("branch path %s", gotPath)
	}
	c.Base = srv.URL + "/redirect"
	c.Timeout = time.Second
	if _, err := c.GetProject(context.Background()); !IsCode(err, CodeUnavailable) {
		t.Errorf("a redirect was followed: %v", err)
	}
}

func TestRedact(t *testing.T) {
	in := "token glpat-AbCdEf0123456789xyz and gldt-ZZZZZZZZZZZZ and plain"
	out := Redact(in)
	if strings.Contains(out, "AbCdEf") || strings.Contains(out, "ZZZZ") || !strings.Contains(out, "plain") {
		t.Fatal(out)
	}
}
