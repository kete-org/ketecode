// Package helper starts and stops kete-root-helper (its README is the contract) with the fixed
// flags step 2d needs, and waits for its socket.
package helper

import (
	"sort"
	"strconv"
	"strings"
)

// Flags are the helper's start-up flags.
type Flags struct {
	Socket       string
	KeteUID      uint32
	ToolUID      uint32
	ToolGID      uint32
	WorktreeRoot string
	ToolCgroup   string
	EnvAllow     []string
	EnvSet       map[string]string
}

// Args renders the flags in a stable order.
func (f Flags) Args() []string {
	args := []string{
		"--socket", f.Socket,
		"--kete-uid", strconv.FormatUint(uint64(f.KeteUID), 10),
		"--tool-uid", strconv.FormatUint(uint64(f.ToolUID), 10),
		"--tool-gid", strconv.FormatUint(uint64(f.ToolGID), 10),
		"--worktree-root", f.WorktreeRoot,
		"--tool-cgroup", f.ToolCgroup,
		"--env-allow", strings.Join(f.EnvAllow, ","),
	}
	names := make([]string, 0, len(f.EnvSet))
	for k := range f.EnvSet {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		args = append(args, "--env-set", k+"="+f.EnvSet[k])
	}
	return args
}
