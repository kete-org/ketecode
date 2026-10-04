// Package policy validates a SPAWN request before any syscall runs (module README "Spawn
// sequence", step 1). It is pure: no filesystem or process state, so every rule here is a
// syntactic one on the request and the helper's fixed configuration. The authoritative cwd check
// — resolving symlinks and refusing an escape at the moment of use — happens later, as the tool
// user, with an openat2 call anchored to an O_PATH root fd (internal/launch); ValidateCwd here is
// only the early, friendly rejection.
package policy

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

// ValidationError carries the protocol error code a rejected request is reported with.
type ValidationError struct {
	Code    protocol.ErrorCode
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func badRequest(format string, args ...any) error {
	return &ValidationError{Code: protocol.ErrorBadRequest, Message: fmt.Sprintf(format, args...)}
}

// ValidateArgv checks argv non-empty, within the entry limit, free of NUL bytes, and that
// argv[0] is either an absolute path or a bare name with no "/" — a relative path with a "/"
// (e.g. "./x", "bin/x") is refused as "relative executable" rather than resolved, since a bare
// name is looked up on PATH by stage 2 as the tool user (D5) while a relative path segment would
// require resolving against a directory the helper doesn't control as root.
func ValidateArgv(argv []string) error {
	if len(argv) == 0 {
		return badRequest("argv must not be empty")
	}
	if len(argv) > protocol.MaxArgv {
		return badRequest("argv must have at most %d entries", protocol.MaxArgv)
	}
	for _, arg := range argv {
		if strings.ContainsRune(arg, 0) {
			return badRequest("argv entries must not contain a NUL byte")
		}
	}
	first := argv[0]
	if first == "" {
		return &ValidationError{Code: protocol.ErrorExec, Message: "argv[0] must not be empty"}
	}
	if filepath.IsAbs(first) {
		return nil
	}
	if strings.ContainsRune(first, '/') {
		return &ValidationError{Code: protocol.ErrorExec, Message: "relative executable"}
	}
	return nil
}

// ValidateEnv checks env is within the entry limit, free of NUL bytes and duplicate names, and
// that every name is in allow.
func ValidateEnv(env []protocol.EnvPair, allow []string) error {
	if len(env) > protocol.MaxEnvEntries {
		return badRequest("env must have at most %d entries", protocol.MaxEnvEntries)
	}
	allowed := make(map[string]bool, len(allow))
	for _, name := range allow {
		allowed[name] = true
	}
	seen := make(map[string]bool, len(env))
	for _, pair := range env {
		name, value := pair[0], pair[1]
		if name == "" || strings.ContainsRune(name, 0) {
			return badRequest("env name must not be empty or contain a NUL byte")
		}
		if strings.ContainsRune(value, 0) {
			return badRequest("env value for %q must not contain a NUL byte", name)
		}
		if seen[name] {
			return badRequest("duplicate env name %q", name)
		}
		seen[name] = true
		if !allowed[name] {
			return &ValidationError{Code: protocol.ErrorEnv, Message: fmt.Sprintf("env name %q is not allowed", name)}
		}
	}
	return nil
}

// ValidateCwd checks cwd is an absolute, lexically clean path equal to or beneath root. It does
// not touch the filesystem and does not resolve symlinks — see the package comment.
func ValidateCwd(cwd, root string) error {
	if !filepath.IsAbs(cwd) {
		return &ValidationError{Code: protocol.ErrorCwd, Message: "cwd must be an absolute path"}
	}
	if filepath.Clean(cwd) != cwd {
		return &ValidationError{Code: protocol.ErrorCwd, Message: "cwd must be a lexically clean path"}
	}
	if cwd != root && !strings.HasPrefix(cwd, root+"/") {
		return &ValidationError{Code: protocol.ErrorCwd, Message: "cwd must be beneath the worktree root"}
	}
	return nil
}

// RelativeCwd returns cwd's path relative to root ("." for the root itself), for the openat2
// RESOLVE_BENEATH calls both the root pre-check and the authoritative stage-2 check make.
// Callers must run ValidateCwd first.
func RelativeCwd(cwd, root string) string {
	if cwd == root {
		return "."
	}
	return strings.TrimPrefix(cwd, root+"/")
}

// ValidateSignal checks a KILL request's signal name against the fixed set the helper accepts.
func ValidateSignal(signal string) error {
	if !protocol.ValidSignal(signal) {
		return badRequest("unsupported signal %q", signal)
	}
	return nil
}

// ValidateKillScope checks a KILL request's scope.
func ValidateKillScope(scope string) error {
	if !protocol.ValidKillScope(scope) {
		return badRequest("unsupported kill scope %q", scope)
	}
	return nil
}
