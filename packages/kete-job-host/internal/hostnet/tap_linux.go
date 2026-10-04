//go:build linux

package hostnet

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// IP runs iproute2's ip.
type IP struct {
	// Bin is the ip binary (default /usr/sbin/ip, else /sbin/ip).
	Bin string
}

func (i IP) bin() string {
	if i.Bin != "" {
		return i.Bin
	}
	for _, b := range []string{"/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"} {
		if _, err := os.Stat(b); err == nil {
			return b
		}
	}
	return "/usr/sbin/ip"
}

func (i IP) run(ctx context.Context, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, i.bin(), args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 256 {
			msg = msg[:256]
		}
		return fmt.Errorf("ip %s: %v: %s", strings.Join(args, " "), err, msg)
	}
	return nil
}

// CreateTap creates slot s's tap owned by uid/gid (the VM's jail user, so the jailed Firecracker
// can attach it), without IPv6, with the gateway address of its /30, and brings it up. A leftover
// device of the same name is removed first.
func (i IP) CreateTap(ctx context.Context, s Slot, uid, gid int) error {
	if !strings.HasPrefix(s.Tap, TapPrefix) || !ValidIfName(s.Tap) {
		return errors.New("hostnet: invalid tap name")
	}
	if err := i.DeleteTap(ctx, s.Tap); err != nil {
		return err
	}
	if err := i.run(ctx, "tuntap", "add", "dev", s.Tap, "mode", "tap", "user", strconv.Itoa(uid), "group", strconv.Itoa(gid)); err != nil {
		return err
	}
	// No IPv6 on the guest's link (ADR 0023 rule 7): no link-local address, no router.
	if err := os.WriteFile(filepath.Join("/proc/sys/net/ipv6/conf", s.Tap, "disable_ipv6"), []byte("1"), 0o644); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("hostnet: disable IPv6 on %s: %w", s.Tap, err)
	}
	if err := i.run(ctx, "addr", "add", s.Gateway.String()+"/30", "dev", s.Tap); err != nil {
		return err
	}
	return i.run(ctx, "link", "set", "dev", s.Tap, "up")
}

// CreateVeth creates slot s's veth pair for the dedicated driver: the host side named like a tap
// (so the host table's kjh* rules apply unchanged), without IPv6, with the gateway address of its
// /30, up; the peer, named eth0, is created directly in the network namespace of process pid (the
// job's reaper, which configures it). A leftover device of the same name is removed first.
func (i IP) CreateVeth(ctx context.Context, s Slot, pid int) error {
	if !strings.HasPrefix(s.Tap, TapPrefix) || !ValidIfName(s.Tap) {
		return errors.New("hostnet: invalid veth name")
	}
	if pid <= 1 {
		return errors.New("hostnet: invalid namespace pid")
	}
	if err := i.DeleteTap(ctx, s.Tap); err != nil {
		return err
	}
	if err := i.run(ctx, "link", "add", s.Tap, "type", "veth", "peer", "name", "eth0", "netns", strconv.Itoa(pid)); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join("/proc/sys/net/ipv6/conf", s.Tap, "disable_ipv6"), []byte("1"), 0o644); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("hostnet: disable IPv6 on %s: %w", s.Tap, err)
	}
	if err := i.run(ctx, "addr", "add", s.Gateway.String()+"/30", "dev", s.Tap); err != nil {
		return err
	}
	return i.run(ctx, "link", "set", "dev", s.Tap, "up")
}

// Path is the ip binary this IP runs.
func (i IP) Path() string { return i.bin() }

// DeleteTap removes a tap; a missing one is not an error.
func (i IP) DeleteTap(ctx context.Context, name string) error {
	if !strings.HasPrefix(name, TapPrefix) || !ValidIfName(name) {
		return errors.New("hostnet: invalid tap name")
	}
	if _, err := os.Lstat(filepath.Join("/sys/class/net", name)); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return i.run(ctx, "link", "del", "dev", name)
}

// Taps lists the guest tap devices that exist.
func Taps() ([]string, error) {
	ents, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), TapPrefix) {
			if _, err := strconv.Atoi(strings.TrimPrefix(e.Name(), TapPrefix)); err == nil {
				out = append(out, e.Name())
			}
		}
	}
	return out, nil
}
