package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidators(t *testing.T) {
	ok := map[string]bool{
		"uuid":   ValidUUID("7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f") && !ValidUUID("7D0F3C2E-5B1A-4C8E-9F60-2A4B6C8D0E1F"),
		"b64":    ValidBase64Url32("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") && !ValidBase64Url32("aqvKk_cQiwy0qZqDflMnLRaTOhufBkHzqORXp6BveqV"),
		"gen":    ValidGeneration("g-2026-10-03.1") && !ValidGeneration("-g") && !ValidGeneration(strings.Repeat("g", 65)),
		"ts":     ValidTimestamp("2026-10-03T01:59:40.125Z") && ValidTimestamp("2026-10-03T01:59:40+02:00") && !ValidTimestamp("2026-10-03T01:59:40") && !ValidTimestamp("2026-13-03T01:59:40Z"),
		"image":  ValidImageRef("ghcr.io/kete-org/kete-job@sha256:"+strings.Repeat("a", 64)) && ValidImageRef("localhost:5000/a/b@sha256:"+strings.Repeat("a", 64)) && !ValidImageRef("ghcr.io/kete-org/kete-job:latest"),
		"token":  ValidEnrollmentToken("kete_jhe_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") && !ValidEnrollmentToken("kete_jhe_short"),
		"reason": FailedReason(ReasonNoFreeSlot) && !FailedReason(ReasonExited) && DestroyedReason(ReasonMaxAge) && !DestroyedReason(ReasonDriverFailed),
	}
	for name, v := range ok {
		if !v {
			t.Errorf("%s", name)
		}
	}
	if MaxCiphertextChars != 5483 {
		t.Errorf("max ciphertext chars %d, want ceil(4112*4/3) = 5483", MaxCiphertextChars)
	}
}

// TestContractExamples decodes the contract's own example bodies (docs/platform/job-host-v1.md
// "Examples") and validates them.
func TestContractExamples(t *testing.T) {
	enroll := `{"enrollment_token":"kete_jhe_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","signing_key":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","sealing_key":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","facts":{"arch":"amd64","driver":"firecracker","slots":4,"kvm":true,"reset":"none","generation":"g-2026-10-03.1","versions":{"agent":"0.9.0","firecracker":"1.13.1","guest_kernel":"6.1.141-kete.1","host_kernel":"6.8.0-45-generic"}}}`
	var er EnrollRequest
	if json.Unmarshal([]byte(enroll), &er) != nil || er.Validate() != nil {
		t.Fatal("enroll example")
	}
	if b, _ := json.Marshal(er); string(b) != enroll {
		t.Fatalf("enroll re-encoding differs:\n%s", b)
	}
	report := `{"generation":"g-2026-10-03.1","versions":{"agent":"0.9.0","firecracker":"1.13.1","guest_kernel":"6.1.141-kete.1","host_kernel":"6.8.0-45-generic"},"slots":{"total":4,"free":2},"starts_blocked":null,"applied_revision":7,"machines":[{"machine_id":"c4d5e6f7-0a1b-4c2d-8e3f-405162738495","job_id":"e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7","state":"destroyed","since":"2026-10-03T01:58:02Z","reason":"exited","phase_lines":[{"ts":"2026-10-03T01:58:01.500Z","step":"job","event":"exit","exit_code":0}],"phase_lines_dropped":0},{"machine_id":"0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f","job_id":"5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d","state":"failed","since":"2026-10-03T01:59:55Z","reason":"image_not_allowed","phase_lines":[],"phase_lines_dropped":0}]}`
	var r Report
	if json.Unmarshal([]byte(report), &r) != nil || r.Validate() != nil {
		t.Fatal("report example")
	}
	if b, _ := json.Marshal(r); string(b) != report {
		t.Fatalf("report re-encoding differs:\n%s", b)
	}
	poll := `{"in_reply_to":"f0e1d2c3b4a5968778695a4b3c2d1e0f","host_id":"7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f","status":"active","next_poll_after":10,"future_field":true,"desired":{"revision":8,"run":[{"machine_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","job_id":"6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f","image":"ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f","deadline":"2026-10-03T02:31:00Z","resources":{"vcpus":4,"memory_mib":4096,"scratch_gib":20}}],"destroy":["f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b"]}}`
	var p PollResponse
	if json.Unmarshal([]byte(poll), &p) != nil || p.Validate() != nil {
		t.Fatal("poll example (with an unknown field) refused")
	}
	for name, bad := range map[string]string{
		"missing revision": strings.Replace(poll, `"revision":8,`, "", 1),
		"missing destroy":  strings.Replace(poll, `,"destroy":["f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b"]`, "", 1),
		"next_poll_after":  strings.Replace(poll, `"next_poll_after":10`, `"next_poll_after":61`, 1),
		"status":           strings.Replace(poll, `"status":"active"`, `"status":"pending"`, 1),
		"vcpus":            strings.Replace(poll, `"vcpus":4`, `"vcpus":17`, 1),
	} {
		var q PollResponse
		if json.Unmarshal([]byte(bad), &q) == nil && q.Validate() == nil {
			t.Errorf("%s accepted", name)
		}
	}
	f := er.Facts
	f.Slots = 2
	f.Driver = DriverDedicated
	f.Reset = ResetProviderRebuild
	if f.Validate() == nil {
		t.Error("dedicated with 2 slots and firecracker versions accepted")
	}
}
