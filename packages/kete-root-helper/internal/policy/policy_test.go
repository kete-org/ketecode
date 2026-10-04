package policy

import (
	"errors"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

func code(t *testing.T, err error) protocol.ErrorCode {
	t.Helper()
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("expected a *ValidationError, got %v (%T)", err, err)
	}
	return ve.Code
}

func TestValidateArgvEmpty(t *testing.T) {
	if err := ValidateArgv(nil); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateArgvTooMany(t *testing.T) {
	argv := make([]string, protocol.MaxArgv+1)
	for i := range argv {
		argv[i] = "x"
	}
	if err := ValidateArgv(argv); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateArgvNul(t *testing.T) {
	if err := ValidateArgv([]string{"git", "a\x00b"}); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateArgvAbsoluteOK(t *testing.T) {
	if err := ValidateArgv([]string{"/usr/bin/git", "status"}); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateArgvBareNameOK(t *testing.T) {
	if err := ValidateArgv([]string{"git", "status"}); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateArgvRelativeRefused(t *testing.T) {
	for _, first := range []string{"./x", "bin/x", "../x"} {
		err := ValidateArgv([]string{first})
		if code(t, err) != protocol.ErrorExec {
			t.Errorf("%q: expected exec code, got %v", first, err)
		}
	}
}

func TestValidateArgvEmptyFirstRefused(t *testing.T) {
	if err := ValidateArgv([]string{""}); code(t, err) != protocol.ErrorExec {
		t.Errorf("expected exec code, got %v", err)
	}
}

func TestValidateEnvOK(t *testing.T) {
	env := []protocol.EnvPair{{"PATH", "/usr/bin"}, {"HOME", "/srv/wt"}}
	if err := ValidateEnv(env, []string{"PATH", "HOME"}); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateEnvOutsideAllowlist(t *testing.T) {
	env := []protocol.EnvPair{{"LD_PRELOAD", "/evil.so"}}
	if err := ValidateEnv(env, []string{"PATH"}); code(t, err) != protocol.ErrorEnv {
		t.Errorf("expected env code, got %v", err)
	}
}

func TestValidateEnvDuplicate(t *testing.T) {
	env := []protocol.EnvPair{{"PATH", "/a"}, {"PATH", "/b"}}
	if err := ValidateEnv(env, []string{"PATH"}); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateEnvNul(t *testing.T) {
	env := []protocol.EnvPair{{"PATH", "/a\x00b"}}
	if err := ValidateEnv(env, []string{"PATH"}); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateEnvTooMany(t *testing.T) {
	env := make([]protocol.EnvPair, protocol.MaxEnvEntries+1)
	allow := make([]string, 0, len(env))
	for i := range env {
		name := "V" + string(rune('A'+i%26)) + string(rune('0'+i%10))
		env[i] = protocol.EnvPair{name, "x"}
	}
	if err := ValidateEnv(env, allow); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateCwdRoot(t *testing.T) {
	if err := ValidateCwd("/srv/wt", "/srv/wt"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateCwdBeneathRoot(t *testing.T) {
	if err := ValidateCwd("/srv/wt/sub/dir", "/srv/wt"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateCwdOutsideRoot(t *testing.T) {
	cases := []string{
		"/srv/other",
		"/srv/wt/../escape",
		"/srv/wt/../../etc",
		"/root/../x",
		"/srv/wtsibling",
	}
	for _, cwd := range cases {
		err := ValidateCwd(cwd, "/srv/wt")
		if err == nil {
			t.Errorf("%q: expected an error", cwd)
			continue
		}
		if c := code(t, err); c != protocol.ErrorCwd {
			t.Errorf("%q: expected cwd code, got %v", cwd, c)
		}
	}
}

func TestValidateCwdNotClean(t *testing.T) {
	cases := []string{"/srv/wt/", "/srv//wt", "/srv/wt/./sub", "/srv/wt/sub/../sub"}
	for _, cwd := range cases {
		if err := ValidateCwd(cwd, "/srv/wt"); code(t, err) != protocol.ErrorCwd {
			t.Errorf("%q: expected cwd code, got %v", cwd, err)
		}
	}
}

func TestValidateCwdRelative(t *testing.T) {
	if err := ValidateCwd("relative/path", "/srv/wt"); code(t, err) != protocol.ErrorCwd {
		t.Errorf("expected cwd code, got %v", err)
	}
}

func TestRelativeCwd(t *testing.T) {
	if got := RelativeCwd("/srv/wt", "/srv/wt"); got != "." {
		t.Errorf("root cwd: got %q", got)
	}
	if got := RelativeCwd("/srv/wt/sub/dir", "/srv/wt"); got != "sub/dir" {
		t.Errorf("nested cwd: got %q", got)
	}
}

func TestValidateSignal(t *testing.T) {
	if err := ValidateSignal("SIGTERM"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := ValidateSignal("SIGSTOP"); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}

func TestValidateKillScope(t *testing.T) {
	if err := ValidateKillScope("group"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := ValidateKillScope("all"); code(t, err) != protocol.ErrorBadRequest {
		t.Errorf("expected bad_request, got %v", err)
	}
}
