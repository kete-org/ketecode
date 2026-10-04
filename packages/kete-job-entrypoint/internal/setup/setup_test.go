package setup

import "testing"

func TestHidepidMounted(t *testing.T) {
	on := "22 1 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw,hidepid=invisible\n"
	off := "22 1 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n"
	two := "22 1 0:5 / /proc rw - proc proc rw,hidepid=2\n"
	other := "22 1 0:5 / /other rw - proc proc rw,hidepid=2\n"
	if !HidepidMounted(on, "/proc") || !HidepidMounted(two, "/proc") {
		t.Error("hidepid not detected")
	}
	if HidepidMounted(off, "/proc") || HidepidMounted(other, "/proc") {
		t.Error("hidepid wrongly detected")
	}
}

func TestSysctls(t *testing.T) {
	s := Sysctls("/proc")
	if len(s) != 3 || s[2].Path != "/proc/sys/user/max_user_namespaces" || s[2].Value != "0" {
		t.Errorf("sysctls = %+v", s)
	}
}
