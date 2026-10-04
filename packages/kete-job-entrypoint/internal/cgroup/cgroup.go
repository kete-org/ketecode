// Package cgroup builds the job's cgroup v2 layout (step 1f) and kills and inspects it (step 6a):
//
//	R/kete-job-init   every process that was in R (cgroup v2's "no internal processes" rule)
//	R/kete-job/system the entrypoint, the proxy and the helper
//	R/kete-job/kete   `kete` (memory.max 25% of MemTotal, pids.max 512)
//	R/kete-job/tool   the helper's per-spawn leaves (memory.max 60%, pids.max 4096)
//
// R is the entrypoint's own cgroup at start-up.
package cgroup

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Layout is the job's cgroup directories.
type Layout struct {
	Parent string
	Init   string
	Job    string
	System string
	Kete   string
	Tool   string
}

// For computes the layout under parent R.
func For(parent string) Layout {
	job := filepath.Join(parent, "kete-job")
	return Layout{
		Parent: parent,
		Init:   filepath.Join(parent, "kete-job-init"),
		Job:    job,
		System: filepath.Join(job, "system"),
		Kete:   filepath.Join(job, "kete"),
		Tool:   filepath.Join(job, "tool"),
	}
}

// Limits for the two job cgroups.
type Limits struct {
	KeteMemory, ToolMemory int64
	KetePids, ToolPids     int
}

// LimitsFor derives the limits from MemTotal (bytes).
func LimitsFor(memTotal int64) Limits {
	return Limits{KeteMemory: memTotal / 4, ToolMemory: memTotal * 6 / 10, KetePids: 512, ToolPids: 4096}
}

// ParseMemTotal reads MemTotal (bytes) from /proc/meminfo content.
func ParseMemTotal(r io.Reader) (int64, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 3 && f[0] == "MemTotal:" && f[2] == "kB" {
			kb, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil || kb <= 0 {
				return 0, errors.New("meminfo: bad MemTotal")
			}
			return kb * 1024, nil
		}
	}
	return 0, errors.New("meminfo: no MemTotal")
}

// ParseOwn returns the cgroup v2 path in /proc/self/cgroup content ("0::/path").
func ParseOwn(r io.Reader) (string, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if rel, ok := strings.CutPrefix(sc.Text(), "0::"); ok {
			if !strings.HasPrefix(rel, "/") {
				return "", errors.New("cgroup: relative path")
			}
			return rel, nil
		}
	}
	return "", errors.New("cgroup: no cgroup v2 (0::) line")
}

// ParseMount returns the cgroup2 mount point in /proc/self/mountinfo content.
func ParseMount(r io.Reader) (string, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		for i, f := range fields {
			if f == "-" && i+1 < len(fields) && len(fields) >= 5 {
				if fields[i+1] == "cgroup2" {
					return fields[4], nil
				}
				break
			}
		}
	}
	return "", errors.New("no cgroup2 mount")
}

// ParseProcs parses a cgroup.procs file.
func ParseProcs(data string) ([]int, error) {
	var out []int
	for _, line := range strings.Split(strings.TrimSpace(data), "\n") {
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("cgroup.procs: %q", line)
		}
		out = append(out, pid)
	}
	return out, nil
}

// ParsePopulated reads "populated" from cgroup.events content.
func ParsePopulated(data string) (bool, error) {
	for _, line := range strings.Split(data, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), " "); ok && k == "populated" {
			return v == "1", nil
		}
	}
	return false, errors.New("cgroup.events: no populated field")
}

func write(path, value string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(value)
	cerr := f.Close()
	if werr != nil {
		return fmt.Errorf("write %s: %w", path, werr)
	}
	return cerr
}

// Procs lists a cgroup's processes.
func Procs(dir string) ([]int, error) {
	b, err := os.ReadFile(filepath.Join(dir, "cgroup.procs"))
	if err != nil {
		return nil, err
	}
	return ParseProcs(string(b))
}

// Populated reports whether any process remains in dir or below.
func Populated(dir string) (bool, error) {
	b, err := os.ReadFile(filepath.Join(dir, "cgroup.events"))
	if err != nil {
		return false, err
	}
	return ParsePopulated(string(b))
}

// Kill SIGKILLs every process in dir and below (cgroup.kill, Linux ≥ 5.14).
func Kill(dir string) error { return write(filepath.Join(dir, "cgroup.kill"), "1") }

// Join moves pid into dir.
func Join(dir string, pid int) error {
	return write(filepath.Join(dir, "cgroup.procs"), strconv.Itoa(pid))
}

// Own returns the calling process's cgroup directory.
func Own() (string, error) {
	mi, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return "", err
	}
	defer mi.Close()
	mount, err := ParseMount(mi)
	if err != nil {
		return "", err
	}
	cg, err := os.Open("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	defer cg.Close()
	rel, err := ParseOwn(cg)
	if err != nil {
		return "", err
	}
	return filepath.Join(mount, rel), nil
}

// MemTotal reads /proc/meminfo.
func MemTotal() (int64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return ParseMemTotal(f)
}

// Setup creates the layout under parent, applies the limits and moves the calling process into
// System. Any existing kete-job directory aborts.
func Setup(parent string, lim Limits) (Layout, error) {
	l := For(parent)
	procs, err := Procs(parent)
	if err != nil {
		return l, err
	}
	if len(procs) > 0 {
		if err := os.Mkdir(l.Init, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return l, err
		}
		for _, pid := range procs {
			// Kernel threads in a true root cgroup can't move; the subtree_control write below is
			// the real check.
			_ = Join(l.Init, pid)
		}
	}
	if err := write(filepath.Join(parent, "cgroup.subtree_control"), "+pids +memory"); err != nil {
		return l, err
	}
	if err := os.Mkdir(l.Job, 0o755); err != nil {
		return l, err
	}
	if err := write(filepath.Join(l.Job, "cgroup.subtree_control"), "+pids +memory"); err != nil {
		return l, err
	}
	for _, d := range []string{l.System, l.Kete, l.Tool} {
		if err := os.Mkdir(d, 0o755); err != nil {
			return l, err
		}
	}
	for _, s := range []struct{ dir, file, value string }{
		{l.Kete, "memory.max", strconv.FormatInt(lim.KeteMemory, 10)},
		{l.Kete, "pids.max", strconv.Itoa(lim.KetePids)},
		{l.Tool, "memory.max", strconv.FormatInt(lim.ToolMemory, 10)},
		{l.Tool, "pids.max", strconv.Itoa(lim.ToolPids)},
		{l.Tool, "cgroup.subtree_control", "+pids +memory"},
	} {
		if err := write(filepath.Join(s.dir, s.file), s.value); err != nil {
			return l, err
		}
	}
	if err := Join(l.System, os.Getpid()); err != nil {
		return l, err
	}
	return l, nil
}
