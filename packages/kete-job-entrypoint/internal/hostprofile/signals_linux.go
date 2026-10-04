//go:build linux

package hostprofile

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/unix"
)

// Paths are where the signals are read (layout.Config's fields; tests point them elsewhere).
type Paths struct {
	FlyDir      string
	InitBin     string
	Proc1Exe    string
	VirtioDir   string
	DMIDir      string
	SysBlockDir string
	DevDir      string
}

// virtioVsockID is the virtio device id of a vsock device (virtio spec: 19).
const virtioVsockID = "0x0013"

// Gather reads the machine's signals. Values that came with the configuration (FlyEnv, Source,
// Provider, Generation) are the caller's. An unreadable signal fails (never a silent default).
func Gather(p Paths, s Signals) (Signals, error) {
	if _, err := os.Lstat(p.FlyDir); err == nil {
		s.FlyDir = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return Signals{}, err
	}
	exe, err := os.Readlink(p.Proc1Exe)
	switch {
	case err == nil:
		s.Init = exe == p.InitBin
	case errors.Is(err, os.ErrNotExist), errors.Is(err, os.ErrPermission):
		s.Init = false // not ours to read, or gone: not kete-job-init
	default:
		return Signals{}, err
	}
	ents, err := os.ReadDir(p.VirtioDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Signals{}, err
	}
	for _, e := range ents {
		id, err := os.ReadFile(filepath.Join(p.VirtioDir, e.Name(), "device"))
		if err != nil {
			return Signals{}, err
		}
		if strings.TrimSpace(string(id)) == virtioVsockID {
			s.Vsock = true
		}
	}
	s.DMI = ProviderForDMI(func(field string) (string, error) {
		b, err := os.ReadFile(filepath.Join(p.DMIDir, field))
		return string(b), err
	})
	return s, nil
}

// BlockDevices lists the device node of every block device with a non-zero size
// (SysBlockDir/<name>/size; DevDir/<name>), sorted.
func BlockDevices(sysBlock, devDir string) ([]string, error) {
	ents, err := os.ReadDir(sysBlock)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, e := range ents {
		size, err := os.ReadFile(filepath.Join(sysBlock, e.Name(), "size"))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue // a test tree without sizes, or a device that just left
			}
			return nil, err
		}
		if strings.TrimSpace(string(size)) == "0" {
			continue
		}
		out = append(out, filepath.Join(devDir, e.Name()))
	}
	sort.Strings(out)
	return out, nil
}

// ErrNotConfigDisk: the device doesn't start with ConfigDiskHeader.
var ErrNotConfigDisk = errors.New("not a config disk")

// OpenConfigDisk opens a device read-only and checks it starts with ConfigDiskHeader. It returns
// the open file positioned after the header, or ErrNotConfigDisk (the file is then closed); a
// device that isn't there or holds no medium is ErrNotConfigDisk too.
func OpenConfigDisk(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENXIO) || errors.Is(err, unix.ENOMEDIUM) || errors.Is(err, unix.ENODEV) {
			return nil, ErrNotConfigDisk
		}
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	head := make([]byte, len(ConfigDiskHeader))
	if _, err := io.ReadFull(f, head); err != nil {
		f.Close()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, unix.ENXIO) || errors.Is(err, unix.ENOMEDIUM) || errors.Is(err, unix.EIO) {
			return nil, ErrNotConfigDisk
		}
		return nil, err
	}
	if !bytes.Equal(head, []byte(ConfigDiskHeader)) {
		f.Close()
		return nil, ErrNotConfigDisk
	}
	return f, nil
}

// FindConfigDisk returns the first block device holding the config disk header, or "" when none
// does. Any other error is returned (the caller fails closed).
func FindConfigDisk(sysBlock, devDir string) (string, error) {
	devs, err := BlockDevices(sysBlock, devDir)
	if err != nil {
		return "", err
	}
	for _, d := range devs {
		f, err := OpenConfigDisk(d)
		if errors.Is(err, ErrNotConfigDisk) {
			continue
		}
		if err != nil {
			return "", err
		}
		f.Close()
		return d, nil
	}
	return "", nil
}
