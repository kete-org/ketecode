package cgroup

import (
	"strings"
	"testing"
)

func TestParsers(t *testing.T) {
	mem, err := ParseMemTotal(strings.NewReader("MemTotal:        2000000 kB\nMemFree: 1 kB\n"))
	if err != nil || mem != 2000000*1024 {
		t.Fatalf("memtotal = %d, %v", mem, err)
	}
	if _, err := ParseMemTotal(strings.NewReader("MemFree: 1 kB\n")); err == nil {
		t.Error("missing MemTotal accepted")
	}
	own, err := ParseOwn(strings.NewReader("0::/system.slice/x\n"))
	if err != nil || own != "/system.slice/x" {
		t.Fatalf("own = %q, %v", own, err)
	}
	if _, err := ParseOwn(strings.NewReader("1:name=systemd:/\n")); err == nil {
		t.Error("v1-only accepted")
	}
	mnt, err := ParseMount(strings.NewReader("30 24 0:26 / /proc rw - proc proc rw\n35 24 0:30 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n"))
	if err != nil || mnt != "/sys/fs/cgroup" {
		t.Fatalf("mount = %q, %v", mnt, err)
	}
	pids, err := ParseProcs("1\n23\n")
	if err != nil || len(pids) != 2 || pids[1] != 23 {
		t.Fatalf("procs = %v, %v", pids, err)
	}
	if _, err := ParseProcs("x\n"); err == nil {
		t.Error("bad procs accepted")
	}
	pop, err := ParsePopulated("populated 1\nfrozen 0\n")
	if err != nil || !pop {
		t.Fatalf("populated = %v, %v", pop, err)
	}
	lim := LimitsFor(1000)
	if lim.KeteMemory != 250 || lim.ToolMemory != 600 || lim.KetePids != 512 || lim.ToolPids != 4096 {
		t.Errorf("limits = %+v", lim)
	}
	l := For("/sys/fs/cgroup")
	if l.Tool != "/sys/fs/cgroup/kete-job/tool" || l.Init != "/sys/fs/cgroup/kete-job-init" {
		t.Errorf("layout = %+v", l)
	}
}
