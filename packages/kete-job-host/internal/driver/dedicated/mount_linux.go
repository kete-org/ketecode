//go:build linux

package dedicated

import (
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// mountLoop attaches file to a free loop device (auto-clearing: it detaches once nothing holds it
// any more, i.e. at the last unmount) and mounts its ext4 file system at target. Read-only loops
// get a read-only device and mount.
func mountLoop(file, target string, readOnly bool, flags uintptr) error {
	oflag := os.O_RDWR
	if readOnly {
		oflag = os.O_RDONLY
	}
	backing, err := os.OpenFile(file, oflag|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer backing.Close()
	ctl, err := os.OpenFile("/dev/loop-control", os.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("dedicated: loop-control: %w", err)
	}
	defer ctl.Close()
	var lo uint32 = unix.LO_FLAGS_AUTOCLEAR
	if readOnly {
		lo |= unix.LO_FLAGS_READ_ONLY
		flags |= unix.MS_RDONLY
	}
	// LOOP_CTL_GET_FREE races with other users of loop devices: a device taken in between
	// answers EBUSY to LOOP_CONFIGURE, so ask again.
	for attempt := 0; attempt < 16; attempt++ {
		n, err := unix.IoctlRetInt(int(ctl.Fd()), unix.LOOP_CTL_GET_FREE)
		if err != nil {
			return fmt.Errorf("dedicated: no free loop device: %w", err)
		}
		dev := fmt.Sprintf("/dev/loop%d", n)
		lf, err := openLoop(dev, oflag)
		if err != nil {
			return err
		}
		cfg := unix.LoopConfig{Fd: uint32(backing.Fd()), Info: unix.LoopInfo64{Flags: lo}}
		err = unix.IoctlLoopConfigure(int(lf.Fd()), &cfg)
		if errors.Is(err, unix.EBUSY) {
			lf.Close()
			continue
		}
		if err != nil {
			lf.Close()
			return fmt.Errorf("dedicated: configure %s: %w", dev, err)
		}
		// The mount holds the device; closing our descriptor then leaves it to auto-clear.
		err = unix.Mount(dev, target, "ext4", flags, "")
		lf.Close()
		if err != nil {
			return fmt.Errorf("dedicated: mount %s at %s: %w", dev, target, err)
		}
		return nil
	}
	return errors.New("dedicated: no loop device could be configured")
}

// openLoop opens a loop device node, waiting briefly for udev-less hosts where LOOP_CTL_GET_FREE
// has just created it.
func openLoop(dev string, oflag int) (*os.File, error) {
	var err error
	for i := 0; i < 50; i++ {
		var f *os.File
		if f, err = os.OpenFile(dev, oflag|unix.O_CLOEXEC, 0); err == nil {
			return f, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, fmt.Errorf("dedicated: open %s: %w", dev, err)
}

// isMountPoint reports a directory on another device than its parent: true for every mount this
// driver makes (loop-mounted ext4, overlay, tmpfs each have their own device).
func isMountPoint(dir string) (bool, error) {
	var st, parent unix.Stat_t
	if err := unix.Lstat(dir, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return false, nil
		}
		return false, err
	}
	if err := unix.Lstat(dir+"/..", &parent); err != nil {
		return false, err
	}
	return st.Dev != parent.Dev, nil
}

// unmount detaches the mount at dir if there is one (MNT_DETACH: the job's own mount namespace
// may still hold its copy until its last process is gone). "Not mounted" is not an error.
func unmount(dir string) error {
	for i := 0; i < 8; i++ {
		mp, err := isMountPoint(dir)
		if err != nil || !mp {
			return err
		}
		err = unix.Unmount(dir, unix.MNT_DETACH|unix.UMOUNT_NOFOLLOW)
		if err != nil && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("dedicated: unmount %s: %w", dir, err)
		}
	}
	return fmt.Errorf("dedicated: %s is still a mount point", dir)
}
