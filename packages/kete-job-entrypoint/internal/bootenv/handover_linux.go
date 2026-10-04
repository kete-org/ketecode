//go:build linux

package bootenv

import (
	"fmt"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// RunArg is argv[1] of the re-executed stage; argv[2] is the handover fd.
const RunArg = "__run"

// ScrubbedEnv is the only environment the re-executed stage gets.
var ScrubbedEnv = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}

// Handover writes v to a pipe and execs `exe __run <fd>` with ScrubbedEnv: os.Unsetenv can't clear
// the kernel's copy of the initial environment (/proc/self/environ), but execve replaces it. Only
// returns on error.
func Handover(exe string, v Values) error {
	payload, err := Encode(v)
	if err != nil {
		return err
	}
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	fd := int(r.Fd())
	// __run takes fd 3 or above: with stdio closed (the config came on fd 0) the pipe may have
	// landed below, so move it up.
	if fd < 3 {
		if fd, err = unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 3); err != nil {
			return err
		}
	}
	// Keep only the read end across the exec.
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
		return err
	}
	return unix.Exec(exe, []string{exe, RunArg, strconv.Itoa(fd)}, ScrubbedEnv)
}

// Receive reads the values from the fd named by argv[2] and closes it.
func Receive(fdArg string) (Values, error) {
	fd, err := strconv.Atoi(fdArg)
	if err != nil || fd < 3 {
		return Values{}, fmt.Errorf("bad handover fd %q", fdArg)
	}
	f := os.NewFile(uintptr(fd), "handover")
	defer f.Close()
	return Decode(f)
}

// ConfigFDArg is the flag naming the config pipe: `kete-job-entrypoint --config-fd <n>`.
const ConfigFDArg = "--config-fd"

// ReadConfigFD reads the config pipe named by fdArg (a decimal fd, 0 or more) and closes it. The fd
// must be a pipe (FIFO): values handed over on a file, a socket or a terminal are refused, so they
// never rest on a disk the entrypoint didn't choose (ADR 0023 rule 13).
func ReadConfigFD(fdArg string) (Config, error) {
	fd, err := strconv.Atoi(fdArg)
	if err != nil || fd < 0 || strconv.Itoa(fd) != fdArg {
		return Config{}, fmt.Errorf("bad config fd %q", fdArg)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return Config{}, err
	}
	f := os.NewFile(uintptr(fd), "config")
	defer func() {
		f.Close()
		// A closed stdio fd would be reused by the next open or pipe; park /dev/null there.
		if fd <= 2 {
			if n, err := unix.Open("/dev/null", unix.O_RDWR, 0); err == nil && n != fd {
				_ = unix.Dup3(n, fd, 0)
				unix.Close(n)
			}
		}
	}()
	if st.Mode&unix.S_IFMT != unix.S_IFIFO {
		return Config{}, fmt.Errorf("config fd %d is not a pipe", fd)
	}
	return DecodeConfig(f)
}
