package helper

import (
	"strings"
	"testing"
)

func TestArgs(t *testing.T) {
	got := strings.Join(Flags{
		Socket: "/run/kete-helper/helper.sock", KeteUID: 996, ToolUID: 995, ToolGID: 995,
		WorktreeRoot: "/srv/kete-job/work", ToolCgroup: "/sys/fs/cgroup/kete-job/tool",
		EnvAllow: []string{"TERM", "CI"}, EnvSet: map[string]string{"PATH": "/usr/bin", "HOME": "/h"},
	}.Args(), " ")
	want := "--socket /run/kete-helper/helper.sock --kete-uid 996 --tool-uid 995 --tool-gid 995 --worktree-root /srv/kete-job/work --tool-cgroup /sys/fs/cgroup/kete-job/tool --env-allow TERM,CI --env-set HOME=/h --env-set PATH=/usr/bin"
	if got != want {
		t.Errorf("args =\n%s\nwant\n%s", got, want)
	}
}
