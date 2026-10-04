// Package launch starts every process the entrypoint runs under another identity or with fds it
// prepared: the proxy, the helper and `kete` (module README "Launching"). Go's os/exec can join a
// cgroup at clone time (CLONE_INTO_CGROUP) but can't set oom_score_adj, umask or no_new_privs
// for the child, so stage 1 re-executes the entrypoint itself (`<exe> __launch <n>`) as a
// short-lived stage 2 that does those with raw syscalls, drops privilege and execve's the target.
// The pid and the cgroup membership carry across that final execve.
//
// Fds in stage 2: 0-2 the target's stdio; 3..3+n-1 the fds the target keeps (the proxy's 3-7);
// 3+n the spec pipe (read end); 4+n the status pipe (write end). Every fd from 3+n up is marked
// close-on-exec before the final execve, so only 0..3+n-1 reach the target.
package launch

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Arg is argv[1] of stage 2.
const Arg = "__launch"

// StageEnv is stage 2's own environment (the target gets Spec.Env).
var StageEnv = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}

// Spec is what stage 1 sends stage 2.
type Spec struct {
	Path        string   `json:"path"`
	Argv        []string `json:"argv"`
	Env         []string `json:"env"`
	Dir         string   `json:"dir,omitempty"`
	KeepRoot    bool     `json:"keep_root,omitempty"`
	UID         uint32   `json:"uid"`
	GID         uint32   `json:"gid"`
	Groups      []uint32 `json:"groups"`
	OOMScoreAdj int      `json:"oom_score_adj"`
	Umask       int      `json:"umask"`
	NoNewPrivs  bool     `json:"no_new_privs"`
}

// Validate checks a spec before anything is started.
func (s Spec) Validate() error {
	if s.Path == "" || s.Path[0] != '/' {
		return errors.New("launch: path must be absolute")
	}
	if len(s.Argv) == 0 {
		return errors.New("launch: argv is empty")
	}
	if !s.KeepRoot && (s.UID == 0 || s.GID == 0) {
		return errors.New("launch: a dropped identity must not be root")
	}
	if s.KeepRoot && (s.UID != 0 || s.GID != 0) {
		return errors.New("launch: keep_root takes no uid or gid")
	}
	if s.OOMScoreAdj < -1000 || s.OOMScoreAdj > 1000 {
		return errors.New("launch: oom_score_adj out of range")
	}
	if s.Umask < 0 || s.Umask > 0o777 {
		return errors.New("launch: umask out of range")
	}
	return nil
}

// status is what stage 2 writes to the status pipe on a failure before the final execve. It
// never carries argv or env values.
type status struct {
	Code  string `json:"code"`
	Errno int    `json:"errno,omitempty"`
}

// Error is a stage-2 failure.
type Error struct {
	Code  string
	Errno int
}

func (e *Error) Error() string {
	return fmt.Sprintf("launch: stage 2 failed: %s (errno %d)", e.Code, e.Errno)
}

var launchClasses = map[string]bool{"internal": true, "oom": true, "identity": true, "nnp": true, "cwd": true, "exec": true, "timeout": true}

// ErrorClass is the fixed phase-log class ("launch_<code>").
func (e *Error) ErrorClass() (string, int) {
	if !launchClasses[e.Code] {
		return "launch", e.Errno
	}
	return "launch_" + e.Code, e.Errno
}

func decodeStatus(b []byte) error {
	var st status
	if err := json.Unmarshal(b, &st); err != nil || st.Code == "" {
		return &Error{Code: "internal"}
	}
	return &Error{Code: st.Code, Errno: st.Errno}
}
