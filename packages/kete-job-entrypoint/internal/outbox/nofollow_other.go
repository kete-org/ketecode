//go:build !linux

package outbox

import "syscall"

const noFollow = syscall.O_NOFOLLOW
