//go:build linux

package peeruid

import (
	"errors"
	"net/netip"
	"os"
)

// Lookup reads this network namespace's socket tables and returns the uid owning the client end
// of the connection client → listener.
func Lookup(client, listener netip.AddrPort) (uint32, error) {
	var all []Entry
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		f, err := os.Open(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) && path == "/proc/net/tcp6" {
				continue // IPv6 disabled in this kernel
			}
			return 0, err
		}
		entries, err := Parse(f)
		_ = f.Close()
		if err != nil {
			return 0, err
		}
		all = append(all, entries...)
	}
	return Find(all, client, listener)
}
