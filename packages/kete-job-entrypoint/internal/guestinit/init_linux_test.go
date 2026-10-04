//go:build linux

package guestinit

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// TestReap: as a subreaper (PID 1 is one by nature), Reap returns the watched child's exit code
// while reaping an orphaned grandchild, and ReapRemaining collects the rest.
func TestReap(t *testing.T) {
	if err := unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0); err != nil {
		t.Skip("no subreaper:", err)
	}
	defer unix.Prctl(unix.PR_SET_CHILD_SUBREAPER, 0, 0, 0, 0)
	// The shell leaves an orphan (sleep) that re-parents to this process, then exits 3.
	cmd := exec.Command("/bin/sh", "-c", "sleep 0.3 & exit 3")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if code := Reap(cmd.Process.Pid); code != 3 {
		t.Errorf("exit code %d", code)
	}
	ReapRemaining(3 * time.Second)
	var ws unix.WaitStatus
	if _, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil); !errors.Is(err, unix.ECHILD) {
		t.Errorf("a child is left: %v", err)
	}
	// A signal-ended child reports 128+n.
	cmd = exec.Command("/bin/sh", "-c", "kill -TERM $$")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if code := Reap(cmd.Process.Pid); code != 128+int(unix.SIGTERM) {
		t.Errorf("signalled exit code %d", code)
	}
}

func TestNameservers(t *testing.T) {
	pnp := "#PROTO: DHCP\ndomain c.example.internal\nnameserver 169.254.169.254\nnameserver 1.1.1.1\nnameserver 8.8.8.8\nbootserver 0.0.0.0\n"
	got, err := Nameservers(strings.NewReader(pnp))
	if err != nil || strings.Join(got, ",") != "1.1.1.1,8.8.8.8" {
		t.Errorf("nameservers = %v %v", got, err)
	}
	if _, err := Nameservers(strings.NewReader("#PROTO: DHCP\nnameserver 169.254.169.254\nnameserver 0.0.0.0\n")); err == nil {
		t.Error("only link-local resolvers accepted")
	}
}

func TestExt4Label(t *testing.T) {
	img := make([]byte, 4096)
	binary.LittleEndian.PutUint16(img[1024+56:], 0xEF53)
	copy(img[1024+120:], ScratchLabel)
	if l, ok := ext4Label(bytes.NewReader(img)); !ok || l != ScratchLabel {
		t.Errorf("label %q %v", l, ok)
	}
	binary.LittleEndian.PutUint16(img[1024+56:], 0x1234)
	if _, ok := ext4Label(bytes.NewReader(img)); ok {
		t.Error("non-ext4 accepted")
	}
	if _, ok := ext4Label(bytes.NewReader(img[:100])); ok {
		t.Error("short device accepted")
	}
}
