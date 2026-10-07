package hostguard

import (
	"errors"
	"testing"
)

func TestCheck(t *testing.T) {
	host := Facts{UserNS: InitUserNSIno, PIDNS: InitPIDNSIno}
	if err := Check(host); err != nil {
		t.Fatalf("host: %v", err)
	}
	for name, f := range map[string]Facts{
		"privileged docker":  {UserNS: InitUserNSIno, PIDNS: 0xF0000123, Markers: []string{"/.dockerenv"}},
		"daemonset, hostPID": {UserNS: InitUserNSIno, PIDNS: InitPIDNSIno, Markers: []string{"/run/.containerenv"}},
		"rootless podman":    {UserNS: 0xF0000001, PIDNS: 0xF0000002},
		"nspawn":             {UserNS: InitUserNSIno, PIDNS: 0xF0000003, ContainerEnv: true},
		"systemd marker":     {UserNS: InitUserNSIno, PIDNS: InitPIDNSIno, Markers: []string{"/run/systemd/container"}},
		"hostPID, env only":  {UserNS: InitUserNSIno, PIDNS: InitPIDNSIno, ContainerEnv: true},
		"pid ns only":        {UserNS: InitUserNSIno, PIDNS: 0xF0000004},
	} {
		if err := Check(f); !errors.Is(err, ErrContainer) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestContainerEnv(t *testing.T) {
	for in, want := range map[string]bool{
		"":                                  false,
		"PATH=/bin\x00HOME=/\x00":           false,
		"PATH=/bin\x00container=docker\x00": true,
		"container=lxc":                     true,
		"container=\x00":                    false,
		"mycontainer=x\x00":                 false,
	} {
		if got := ContainerEnv([]byte(in)); got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
}
