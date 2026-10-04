package guestinit

import (
	"reflect"
	"testing"
)

func TestParseCmdline(t *testing.T) {
	nc, err := ParseCmdline("root=PARTLABEL=kete-root ro console=ttyS0 kete.net=dhcp kete.dns=1.1.1.1,8.8.8.8 panic=1\n")
	if err != nil || !nc.DHCP || !reflect.DeepEqual(nc.Resolvers, []string{"1.1.1.1", "8.8.8.8"}) {
		t.Errorf("cloudvm: %+v %v", nc, err)
	}
	nc, err = ParseCmdline("console=ttyS0 ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off:1.1.1.1 panic=1")
	if err != nil || nc.DHCP || nc.Resolvers != nil {
		t.Errorf("microvm: %+v %v", nc, err)
	}
	for _, bad := range []string{
		"kete.net=static kete.dns=1.1.1.1",
		"kete.net=dhcp",
		"kete.dns=1.1.1.1",
		"kete.net=dhcp kete.net=dhcp kete.dns=1.1.1.1",
		"kete.net=dhcp kete.dns=1.1.1.1 kete.dns=8.8.8.8",
		"kete.net=dhcp kete.dns=1.1.1.1,8.8.8.8,9.9.9.9",
		"kete.net=dhcp kete.dns=10.0.0.2",
		"kete.net=dhcp kete.dns=169.254.169.254",
		"kete.net=dhcp kete.dns=100.100.100.100",
		"kete.net=dhcp kete.dns=127.0.0.1",
		"kete.net=dhcp kete.dns=0.1.2.3",
		"kete.net=dhcp kete.dns=240.0.0.1",
		"kete.net=dhcp kete.dns=255.255.255.255",
		"kete.net=dhcp kete.dns=172.20.0.1",
		"kete.net=dhcp kete.dns=192.168.1.1",
		"kete.net=dhcp kete.dns=224.0.0.251",
		"kete.net=dhcp kete.dns=2606:4700:4700::1111",
		"kete.net=dhcp kete.dns=",
		"kete.net=dhcp kete.dns=1.1.1.1,",
	} {
		if _, err := ParseCmdline(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
