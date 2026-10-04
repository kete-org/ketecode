// Package cgroup manages the helper's cgroup v2 layout: a start-up check that the configured tool
// cgroup is usable, and a per-spawn leaf cgroup under it (module README "Spawn sequence", D2).
// Every tool process lives only inside its own leaf, which is how "group kill" can be scoped to
// one connection's process tree without a pid field ever naming another connection's processes.
package cgroup

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// StartupCheck verifies toolCgroup is a cgroup v2 directory with pids.max and memory.max already
// bounded by the entrypoint, and holds no processes directly (every tool process lives in a leaf
// beneath it). Fails closed: any problem is a start-up error, never a warning.
func StartupCheck(toolCgroup string) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(toolCgroup, &stat); err != nil {
		return fmt.Errorf("--tool-cgroup %q: statfs: %w", toolCgroup, err)
	}
	if int64(stat.Type) != unix.CGROUP2_SUPER_MAGIC {
		return fmt.Errorf("--tool-cgroup %q is not a cgroup v2 directory", toolCgroup)
	}

	for _, controller := range []string{"pids.max", "memory.max"} {
		value, err := readTrim(filepath.Join(toolCgroup, controller))
		if err != nil {
			return fmt.Errorf("--tool-cgroup %q: read %s: %w", toolCgroup, controller, err)
		}
		if value == "max" || value == "" {
			return fmt.Errorf("--tool-cgroup %q: %s must be bounded by the entrypoint (got %q)", toolCgroup, controller, value)
		}
	}

	procs, err := readTrim(filepath.Join(toolCgroup, "cgroup.procs"))
	if err != nil {
		return fmt.Errorf("--tool-cgroup %q: read cgroup.procs: %w", toolCgroup, err)
	}
	if procs != "" {
		return fmt.Errorf("--tool-cgroup %q must hold no processes directly (every tool process lives in a per-spawn leaf)", toolCgroup)
	}

	return nil
}

// CreateLeaf creates a new leaf directory <toolCgroup>/<name>, root-owned mode 0700, and opens it
// O_DIRECTORY|O_CLOEXEC for use as a clone3 CLONE_INTO_CGROUP target. Callers must RemoveLeaf when
// the leaf is empty.
func CreateLeaf(toolCgroup, name string) (dirFD int, path string, err error) {
	path = filepath.Join(toolCgroup, name)
	if err = os.Mkdir(path, 0o700); err != nil {
		return -1, "", err
	}
	dirFD, err = unix.Open(path, unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		_ = os.Remove(path)
		return -1, "", err
	}
	return dirFD, path, nil
}

// RemoveLeaf removes a leaf directory. The leaf must already be empty (no live processes); the
// kernel refuses to rmdir a populated cgroup.
func RemoveLeaf(path string) error {
	return os.Remove(path)
}

// Procs returns the pids currently in the leaf's cgroup.procs.
func Procs(path string) ([]int, error) {
	data, err := os.ReadFile(filepath.Join(path, "cgroup.procs"))
	if err != nil {
		return nil, err
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("cgroup.procs: unexpected line %q: %w", line, err)
		}
		pids = append(pids, pid)
	}
	return pids, nil
}

// Freeze writes to the leaf's cgroup.freeze (used before a group SIGKILL so processes can't fork
// away between the procs listing and the signal).
func Freeze(path string, freeze bool) error {
	value := "0"
	if freeze {
		value = "1"
	}
	return os.WriteFile(filepath.Join(path, "cgroup.freeze"), []byte(value), 0o200)
}

// Populated reports the leaf's cgroup.events "populated" field: whether any process remains.
func Populated(path string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(path, "cgroup.events"))
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		name, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok && name == "populated" {
			return value == "1", nil
		}
	}
	return false, fmt.Errorf("cgroup.events: no populated field")
}

// OwnCgroup returns the absolute filesystem path of the cgroup v2 directory pid currently belongs
// to (mount point + the relative path /proc/<pid>/cgroup reports) — used to verify a pid found in
// a leaf's cgroup.procs still belongs to that leaf before signalling it (pid reuse can't redirect
// a kill: the pid is re-checked, not trusted, between listing and signalling).
func OwnCgroup(pid int) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		// cgroup v2: a single line "0::<path>".
		if rel, ok := strings.CutPrefix(line, "0::"); ok {
			mount, err := cgroupMountPoint()
			if err != nil {
				return "", err
			}
			return filepath.Join(mount, rel), nil
		}
	}
	return "", fmt.Errorf("/proc/%d/cgroup: no cgroup v2 (0::) line", pid)
}

var (
	mountPointOnce sync.Once
	mountPointPath string
	mountPointErr  error
)

// cgroupMountPoint finds the cgroup v2 unified hierarchy's mount point from /proc/self/mountinfo
// (usually /sys/fs/cgroup, but not assumed).
func cgroupMountPoint() (string, error) {
	mountPointOnce.Do(func() {
		f, err := os.Open("/proc/self/mountinfo")
		if err != nil {
			mountPointErr = err
			return
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			// mountinfo fields: ID parentID major:minor root mountPoint options... "-" fsType source superOptions
			dashIdx := -1
			for i, field := range fields {
				if field == "-" {
					dashIdx = i
					break
				}
			}
			if dashIdx < 0 || dashIdx+1 >= len(fields) || len(fields) < 5 {
				continue
			}
			if fields[dashIdx+1] == "cgroup2" {
				mountPointPath = fields[4]
				return
			}
		}
		if err := scanner.Err(); err != nil {
			mountPointErr = err
			return
		}
		mountPointErr = fmt.Errorf("no cgroup2 mount found in /proc/self/mountinfo")
	})
	return mountPointPath, mountPointErr
}

func readTrim(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}
