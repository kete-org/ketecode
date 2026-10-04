package guestinit

import (
	"bytes"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"

const microvmJSON = `{"job_id":"0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c","platform_url":"https://platform.kete.test","claim_token":"` + token + `","storage_host":"storage.kete.test","host_profile":"microvm"}`

func disk(body string, pad int) []byte {
	return append([]byte(hostprofile.ConfigDiskHeader+body), make([]byte, pad)...)
}

func TestParseConfigDisk(t *testing.T) {
	for name, d := range map[string][]byte{
		"padded":           disk(microvmJSON, 4096-len(hostprofile.ConfigDiskHeader)-len(microvmJSON)),
		"no padding":       disk(microvmJSON, 0),
		"trailing newline": disk(microvmJSON+"\n", 512),
	} {
		cfg, err := ParseConfigDisk(bytes.NewReader(d))
		if err != nil || cfg.HostProfile != "microvm" || cfg.ClaimToken != token {
			t.Errorf("%s: %+v %v", name, cfg, err)
		}
	}
	bad := map[string][]byte{
		"bad header":       append([]byte("kete-job-config v2\n"+microvmJSON), make([]byte, 64)...),
		"no header":        []byte(microvmJSON),
		"empty":            {},
		"oversize":         disk(strings.Repeat(" ", MaxDiskRead), 0),
		"json too long":    disk(`{"job_id":"`+strings.Repeat("a", bootenv.MaxConfig)+`"}`, 16),
		"bad json":         disk(`{"job_id":`, 16),
		"wrong field type": disk(`{"job_id":7,"platform_url":"https://platform.kete.test","claim_token":"`+token+`","storage_host":"storage.kete.test","host_profile":"microvm"}`, 16),
		"unknown field":    disk(strings.Replace(microvmJSON, `"host_profile"`, `"network":{},"host_profile"`, 1), 16),
		"garbage after":    append(disk(microvmJSON, 8), 'x'),
		"two objects":      disk(microvmJSON+microvmJSON, 16),
		"cloudvm profile":  disk(strings.Replace(microvmJSON, `"microvm"`, `"cloudvm","host_provider":"gcp"`, 1), 16),
		"dedicated":        disk(strings.Replace(microvmJSON, `"microvm"`, `"dedicated","host_generation":"g"`, 1), 16),
		"invalid token":    disk(strings.Replace(microvmJSON, token, "short", 1), 16),
	}
	for name, d := range bad {
		if _, err := ParseConfigDisk(bytes.NewReader(d)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
