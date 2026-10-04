package clock

import "golang.org/x/sys/unix"

// System reads the kernel's NTP status with adjtimex(2): synchronised unless the call reports
// TIME_ERROR or STA_UNSYNC is set (what systemd-timedated's NTPSynchronized reads).
func System() Checker { return system{} }

type system struct{}

func (system) Synced() (bool, error) {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return false, err
	}
	return state != unix.TIME_ERROR && tx.Status&unix.STA_UNSYNC == 0, nil
}
