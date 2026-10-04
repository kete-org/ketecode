//go:build linux

package proxy

import (
	"fmt"
	"net"
	"os"
	"strconv"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
)

// The inherited fd layout (module README "File descriptors"). Root prepares all of them; the
// proxy never binds, creates or opens anything privileged itself.
const (
	FDKete    = 3 // listener, 127.0.0.1:<ports.kete> (port A)
	FDTool    = 4 // listener, 127.0.0.1:<ports.tool> (port B)
	FDRoot    = 5 // listener, 127.0.0.1:<ports.root> (port R)
	FDLog     = 6 // request log, root-owned, O_WRONLY|O_APPEND
	FDControl = 7 // control socketpair end
	fdMax     = FDControl
)

var portFD = map[config.Port]int{config.PortKete: FDKete, config.PortTool: FDTool, config.PortRoot: FDRoot}

// CheckNoExtraFDs refuses any inherited fd above 7. It lists /proc/self/fd with raw syscalls so
// the check itself opens nothing the Go runtime keeps, and must run before anything else in main
// opens a file.
func CheckNoExtraFDs() error {
	dfd, err := unix.Open("/proc/self/fd", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("list /proc/self/fd: %w", err)
	}
	defer unix.Close(dfd)
	buf := make([]byte, 8192)
	for {
		n, err := unix.ReadDirent(dfd, buf)
		if err != nil {
			return fmt.Errorf("list /proc/self/fd: %w", err)
		}
		if n == 0 {
			return nil
		}
		_, _, names := unix.ParseDirent(buf[:n], -1, nil)
		for _, name := range names {
			fd, err := strconv.Atoi(name)
			if err != nil || fd == dfd {
				continue
			}
			if fd <= fdMax {
				continue
			}
			// Every fd that survived execve lacks FD_CLOEXEC; one with it set was opened by this
			// process since (the Go runtime keeps e.g. /sys/fs/cgroup/cpu.max open for its
			// container-aware GOMAXPROCS), so it wasn't inherited.
			if fl, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); err == nil && fl&unix.FD_CLOEXEC != 0 {
				continue
			}
			target, _ := os.Readlink("/proc/self/fd/" + name)
			return fmt.Errorf("unexpected inherited fd %d (%s; only 0-%d may be open)", fd, target, fdMax)
		}
	}
}

// CheckIdentity refuses to run unless every uid is the configured proxy uid (never root), no gid
// is 0, there are no supplementary groups, no_new_privs is set and the permitted, effective and
// ambient capability sets are empty (read from /proc/self/status).
func CheckIdentity(cfg *config.Config) error {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return err
	}
	return checkStatus(string(status), cfg.UIDs.Proxy)
}

// Inherited is what root handed over on fds 3-7, checked.
type Inherited struct {
	Listeners map[config.Port]net.Listener
	Log       *os.File
	LogStart  int64
	Control   *net.UnixConn
}

// Inherit checks fds 3-7 against the fd table and the configuration, and wraps them.
func Inherit(cfg *config.Config) (*Inherited, error) {
	inh := &Inherited{Listeners: map[config.Port]net.Listener{}}
	for _, port := range config.Ports {
		fd := portFD[port]
		if err := checkListener(fd, cfg.Ports[port]); err != nil {
			return nil, fmt.Errorf("fd %d (port %s): %w", fd, port, err)
		}
		f := os.NewFile(uintptr(fd), "listener-"+port.String())
		ln, err := net.FileListener(f)
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("fd %d (port %s): %w", fd, port, err)
		}
		inh.Listeners[port] = ln
	}

	size, err := checkLog(FDLog)
	if err != nil {
		return nil, fmt.Errorf("fd %d (request log): %w", FDLog, err)
	}
	inh.Log = os.NewFile(FDLog, "request-log")
	inh.LogStart = size

	if err := checkControl(FDControl); err != nil {
		return nil, fmt.Errorf("fd %d (control): %w", FDControl, err)
	}
	cf := os.NewFile(FDControl, "control")
	c, err := net.FileConn(cf)
	_ = cf.Close()
	if err != nil {
		return nil, fmt.Errorf("fd %d (control): %w", FDControl, err)
	}
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("fd %d (control): not a unix socket", FDControl)
	}
	inh.Control = uc
	return inh, nil
}

func sockopt(fd, opt int) (int, error) { return unix.GetsockoptInt(fd, unix.SOL_SOCKET, opt) }

func checkListener(fd int, port uint16) error {
	if typ, err := sockopt(fd, unix.SO_TYPE); err != nil || typ != unix.SOCK_STREAM {
		return fmt.Errorf("not a stream socket (%v)", err)
	}
	if dom, err := sockopt(fd, unix.SO_DOMAIN); err != nil || dom != unix.AF_INET {
		return fmt.Errorf("not an IPv4 socket (%v)", err)
	}
	if acc, err := sockopt(fd, unix.SO_ACCEPTCONN); err != nil || acc != 1 {
		return fmt.Errorf("not listening (%v)", err)
	}
	sa, err := unix.Getsockname(fd)
	if err != nil {
		return err
	}
	in4, ok := sa.(*unix.SockaddrInet4)
	if !ok || in4.Addr != [4]byte{127, 0, 0, 1} {
		return fmt.Errorf("not bound to 127.0.0.1")
	}
	if in4.Port != int(port) || in4.Port >= 1024 {
		return fmt.Errorf("bound to port %d, want privileged port %d", in4.Port, port)
	}
	return nil
}

func checkLog(fd int) (int64, error) {
	fl, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		return 0, err
	}
	if fl&unix.O_ACCMODE != unix.O_WRONLY || fl&unix.O_APPEND == 0 {
		return 0, fmt.Errorf("must be opened write-only with O_APPEND")
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return 0, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return 0, fmt.Errorf("not a regular file")
	}
	if st.Uid != 0 {
		return 0, fmt.Errorf("owned by uid %d, must be root-owned", st.Uid)
	}
	return st.Size, nil
}

func checkControl(fd int) error {
	if dom, err := sockopt(fd, unix.SO_DOMAIN); err != nil || dom != unix.AF_UNIX {
		return fmt.Errorf("not a unix socket (%v)", err)
	}
	if typ, err := sockopt(fd, unix.SO_TYPE); err != nil || typ != unix.SOCK_STREAM {
		return fmt.Errorf("not a stream socket (%v)", err)
	}
	// Only root may hold the other end: the peer's credentials (for a socketpair, its creator's)
	// must be uid 0.
	cred, err := unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		return fmt.Errorf("SO_PEERCRED: %w", err)
	}
	if cred.Uid != 0 {
		return fmt.Errorf("the peer is uid %d, must be root", cred.Uid)
	}
	return nil
}

// SetNotDumpable stops other processes of the proxy uid from ptracing it or reading its memory
// (the CA key lives only there).
func SetNotDumpable() error {
	return unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0)
}
