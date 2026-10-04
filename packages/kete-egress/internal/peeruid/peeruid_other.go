//go:build !linux

package peeruid

import (
	"errors"
	"net/netip"
)

// Lookup is Linux-only; elsewhere it always fails, so the proxy refuses every connection.
func Lookup(client, listener netip.AddrPort) (uint32, error) {
	return 0, errors.New("peeruid: only supported on Linux")
}
