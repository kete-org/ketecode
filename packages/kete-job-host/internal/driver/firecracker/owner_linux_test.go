//go:build linux

package firecracker

import (
	"os"
	"syscall"
)

func ownerUID(fi os.FileInfo) int { return int(fi.Sys().(*syscall.Stat_t).Uid) }
