//go:build linux

package launch

import "syscall"

// signalByName maps the protocol's fixed signal name set (protocol.ValidSignal) to a
// syscall.Signal. Callers must validate the name first; an unknown name returns ok=false.
func signalByName(name string) (syscall.Signal, bool) {
	switch name {
	case "SIGTERM":
		return syscall.SIGTERM, true
	case "SIGKILL":
		return syscall.SIGKILL, true
	case "SIGINT":
		return syscall.SIGINT, true
	case "SIGHUP":
		return syscall.SIGHUP, true
	case "SIGQUIT":
		return syscall.SIGQUIT, true
	case "SIGUSR1":
		return syscall.SIGUSR1, true
	case "SIGUSR2":
		return syscall.SIGUSR2, true
	default:
		return 0, false
	}
}
