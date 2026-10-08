//go:build linux

package outbox

import "golang.org/x/sys/unix"

const noFollow = unix.O_NOFOLLOW | unix.O_CLOEXEC
