package proxy

import (
	"fmt"
	"strconv"
	"strings"
)

// checkStatus checks the process identity in a /proc/self/status text: every uid (real,
// effective, saved, filesystem) is the proxy uid, no gid is 0, there are no supplementary groups,
// no_new_privs is set, and the permitted, effective and ambient capability sets are empty.
func checkStatus(status string, proxyUID uint32) error {
	fields := map[string]string{}
	for _, line := range strings.Split(status, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok {
			fields[k] = strings.TrimSpace(v)
		}
	}
	need := func(k string) (string, error) {
		v, ok := fields[k]
		if !ok {
			return "", fmt.Errorf("/proc/self/status has no %s line", k)
		}
		return v, nil
	}
	uids, err := need("Uid")
	if err != nil {
		return err
	}
	for _, u := range strings.Fields(uids) {
		if u == "0" {
			return fmt.Errorf("kete-egress serve must not run as root")
		}
		if u != strconv.FormatUint(uint64(proxyUID), 10) {
			return fmt.Errorf("running with uids %q, but uids.proxy is %d", uids, proxyUID)
		}
	}
	if len(strings.Fields(uids)) != 4 {
		return fmt.Errorf("unexpected Uid line %q", uids)
	}
	gids, err := need("Gid")
	if err != nil {
		return err
	}
	if len(strings.Fields(gids)) != 4 {
		return fmt.Errorf("unexpected Gid line %q", gids)
	}
	for _, g := range strings.Fields(gids) {
		if g == "0" {
			return fmt.Errorf("running with gid 0 (%q)", gids)
		}
	}
	groups, err := need("Groups")
	if err != nil {
		return err
	}
	if groups != "" {
		return fmt.Errorf("supplementary groups %q must be empty (setgroups([]))", groups)
	}
	nnp, err := need("NoNewPrivs")
	if err != nil {
		return err
	}
	if nnp != "1" {
		return fmt.Errorf("no_new_privs is not set")
	}
	for _, k := range []string{"CapPrm", "CapEff", "CapAmb"} {
		v, err := need(k)
		if err != nil {
			return err
		}
		n, err := strconv.ParseUint(v, 16, 64)
		if err != nil || n != 0 {
			return fmt.Errorf("%s is %s, must be empty", k, v)
		}
	}
	return nil
}
