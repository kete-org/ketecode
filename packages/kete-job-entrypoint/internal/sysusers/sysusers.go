// Package sysusers reads the job users from /etc/passwd and /etc/group (root-owned files the image
// writes at build time; no NSS) and checks the invariants the entrypoint relies on (step 1a): the
// kete, tool and proxy users and the shared group exist, every id is non-zero and distinct, kete
// and the tool user are members of the shared group, nobody else is, and the proxy user has no
// supplementary group at all (the proxy refuses to start with one).
package sysusers

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// User is one passwd entry.
type User struct {
	Name     string
	UID, GID uint32
}

// IDs are the validated job identities.
type IDs struct {
	Kete, Tool, Proxy User
	JobGID            uint32
}

// Names are the user and group names to look up.
type Names struct {
	Kete, Tool, Proxy, Group string
}

type group struct {
	name    string
	gid     uint32
	members []string
}

const maxFile = 1 << 20

func parsePasswd(r io.Reader) (map[string]User, []User, error) {
	byName := map[string]User{}
	var all []User
	sc := bufio.NewScanner(io.LimitReader(r, maxFile))
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Split(line, ":")
		if len(f) != 7 {
			return nil, nil, fmt.Errorf("passwd: malformed line")
		}
		uid, err1 := strconv.ParseUint(f[2], 10, 32)
		gid, err2 := strconv.ParseUint(f[3], 10, 32)
		if err1 != nil || err2 != nil {
			return nil, nil, fmt.Errorf("passwd: bad id for %q", f[0])
		}
		u := User{Name: f[0], UID: uint32(uid), GID: uint32(gid)}
		if _, dup := byName[u.Name]; dup {
			return nil, nil, fmt.Errorf("passwd: %q listed twice", u.Name)
		}
		byName[u.Name] = u
		all = append(all, u)
	}
	return byName, all, sc.Err()
}

func parseGroup(r io.Reader) ([]group, error) {
	var out []group
	sc := bufio.NewScanner(io.LimitReader(r, maxFile))
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Split(line, ":")
		if len(f) != 4 {
			return nil, fmt.Errorf("group: malformed line")
		}
		gid, err := strconv.ParseUint(f[2], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("group: bad gid for %q", f[0])
		}
		g := group{name: f[0], gid: uint32(gid)}
		if f[3] != "" {
			g.members = strings.Split(f[3], ",")
		}
		out = append(out, g)
	}
	return out, sc.Err()
}

// Resolve parses both files and checks the invariants.
func Resolve(passwd, groupFile io.Reader, n Names) (IDs, error) {
	users, all, err := parsePasswd(passwd)
	if err != nil {
		return IDs{}, err
	}
	groups, err := parseGroup(groupFile)
	if err != nil {
		return IDs{}, err
	}
	var ids IDs
	for _, p := range []struct {
		name string
		dst  *User
	}{{n.Kete, &ids.Kete}, {n.Tool, &ids.Tool}, {n.Proxy, &ids.Proxy}} {
		u, ok := users[p.name]
		if !ok {
			return IDs{}, fmt.Errorf("user %q does not exist", p.name)
		}
		if u.UID == 0 || u.GID == 0 {
			return IDs{}, fmt.Errorf("user %q must not have uid or gid 0", p.name)
		}
		*p.dst = u
	}
	if ids.Kete.UID == ids.Tool.UID || ids.Kete.UID == ids.Proxy.UID || ids.Tool.UID == ids.Proxy.UID {
		return IDs{}, errors.New("the kete, tool and proxy users must have distinct uids")
	}
	var job *group
	gidCount := map[uint32]int{}
	for i := range groups {
		gidCount[groups[i].gid]++
		if groups[i].name == n.Group {
			if job != nil {
				return IDs{}, fmt.Errorf("group %q listed twice", n.Group)
			}
			job = &groups[i]
		}
	}
	if job == nil {
		return IDs{}, fmt.Errorf("group %q does not exist", n.Group)
	}
	if job.gid == 0 || gidCount[job.gid] != 1 {
		return IDs{}, fmt.Errorf("group %q must have a unique, non-zero gid", n.Group)
	}
	members := map[string]bool{}
	for _, m := range job.members {
		members[m] = true
	}
	if len(members) != 2 || !members[n.Kete] || !members[n.Tool] {
		return IDs{}, fmt.Errorf("group %q must have exactly the members %s and %s", n.Group, n.Kete, n.Tool)
	}
	for _, u := range all {
		if u.GID == job.gid {
			return IDs{}, fmt.Errorf("user %q has %q as its primary group", u.Name, n.Group)
		}
	}
	for _, u := range []User{ids.Kete, ids.Tool, ids.Proxy} {
		if u.GID == job.gid {
			return IDs{}, fmt.Errorf("user %q must not have the job group as its primary group", u.Name)
		}
	}
	for _, g := range groups {
		for _, m := range g.members {
			if m == n.Proxy {
				return IDs{}, fmt.Errorf("user %q must have no supplementary group (it is in %q)", n.Proxy, g.name)
			}
		}
	}
	if ids.Proxy.GID == ids.Kete.GID || ids.Proxy.GID == ids.Tool.GID {
		return IDs{}, errors.New("the proxy user's primary group must not be shared with kete or the tool user")
	}
	ids.JobGID = job.gid
	return ids, nil
}
