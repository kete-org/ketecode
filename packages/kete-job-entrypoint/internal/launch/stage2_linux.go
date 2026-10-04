//go:build linux

package launch

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

const specMax = 1 << 20

// RunStage2 is entered from main when os.Args[1] == Arg, before anything else. It never returns.
func RunStage2() {
	runtime.LockOSThread()
	n := -1
	if len(os.Args) == 3 {
		if v, err := strconv.Atoi(os.Args[2]); err == nil && v >= 0 && v <= 64 {
			n = v
		}
	}
	if n < 0 {
		os.Exit(125)
	}
	specFD, statusFD := 3+n, 4+n
	fail := func(code string, cause error) {
		st := status{Code: code}
		if errno, ok := cause.(syscall.Errno); ok {
			st.Errno = int(errno)
		}
		if b, err := json.Marshal(st); err == nil {
			_, _ = unix.Write(statusFD, b)
		}
		os.Exit(126)
	}

	f := os.NewFile(uintptr(specFD), "spec")
	raw, err := io.ReadAll(io.LimitReader(f, specMax+1))
	if err != nil || len(raw) > specMax {
		fail("internal", err)
	}
	_ = f.Close()
	var s Spec
	if err := json.Unmarshal(raw, &s); err != nil {
		fail("internal", err)
	}
	if err := s.Validate(); err != nil {
		fail("internal", nil)
	}
	unix.CloseOnExec(statusFD)

	if err := writeOOM(s.OOMScoreAdj); err != nil {
		fail("oom", err)
	}
	unix.Umask(s.Umask)

	groups := make([]int, len(s.Groups))
	for i, g := range s.Groups {
		groups[i] = int(g)
	}
	if err := syscall.Setgroups(groups); err != nil {
		fail("identity", err)
	}
	if !s.KeepRoot {
		if err := syscall.Setgid(int(s.GID)); err != nil {
			fail("identity", err)
		}
		if err := syscall.Setuid(int(s.UID)); err != nil {
			fail("identity", err)
		}
		if r, e, sv := unix.Getresuid(); r != int(s.UID) || e != int(s.UID) || sv != int(s.UID) {
			fail("identity", nil)
		}
		if r, e, sv := unix.Getresgid(); r != int(s.GID) || e != int(s.GID) || sv != int(s.GID) {
			fail("identity", nil)
		}
	}
	got, err := syscall.Getgroups()
	if err != nil || !sameGroups(got, groups) {
		fail("identity", err)
	}
	if s.NoNewPrivs {
		if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
			fail("nnp", err)
		}
		if v, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); err != nil || v != 1 {
			fail("nnp", err)
		}
	}
	if s.Dir != "" {
		if err := unix.Chdir(s.Dir); err != nil {
			fail("cwd", err)
		}
	}
	if err := unix.CloseRange(uint(specFD), ^uint(0), unix.CLOSE_RANGE_CLOEXEC); err != nil {
		fail("internal", err)
	}
	if err := syscall.Exec(s.Path, s.Argv, s.Env); err != nil {
		fail("exec", err)
	}
}

func writeOOM(v int) error {
	fd, err := unix.Open("/proc/self/oom_score_adj", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	want := strconv.Itoa(v)
	if _, err := unix.Write(fd, []byte(want)); err != nil {
		return err
	}
	buf := make([]byte, 16)
	n, err := unix.Pread(fd, buf, 0)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(buf[:n])) != want {
		return fmt.Errorf("oom_score_adj reads back %q", buf[:n])
	}
	return nil
}

func sameGroups(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	seen := map[int]bool{}
	for _, g := range want {
		seen[g] = true
	}
	for _, g := range got {
		if !seen[g] {
			return false
		}
	}
	return true
}
