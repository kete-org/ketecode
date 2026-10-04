package bootenv

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func goodConfig() Config {
	return Config{
		JobID: "0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c", PlatformURL: "https://platform.kete.test", ClaimToken: goodToken,
		StorageHost: "storage.kete.test", HostProfile: "dedicated", HostGeneration: "gen-1",
	}
}

func marshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseConfig(t *testing.T) {
	for _, c := range []Config{
		goodConfig(),
		{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "microvm"},
		{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "cloudvm", HostProvider: "oci"},
	} {
		got, err := ParseConfig(marshal(t, c))
		if err != nil || got != c {
			t.Errorf("%s: %+v, %v", c.HostProfile, got, err)
		}
	}
	bad := map[string]string{
		"unknown field":            `{"job_id":"0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c","platform_url":"https://platform.kete.test","claim_token":"` + goodToken + `","storage_host":"storage.kete.test","host_profile":"microvm","on_fly":true}`,
		"wrong type":               `{"job_id":1,"platform_url":"https://platform.kete.test","claim_token":"` + goodToken + `","storage_host":"storage.kete.test","host_profile":"microvm"}`,
		"trailing data":            string(marshal(t, goodConfig())) + `{}`,
		"not an object":            `[]`,
		"empty":                    ``,
		"bad json":                 `{"job_id":`,
		"oversize":                 `{"job_id":"` + strings.Repeat("a", MaxConfig) + `"}`,
		"fly from a pipe":          string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "fly"})),
		"unknown profile":          string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "kvm"})),
		"no profile":               string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test"})),
		"cloudvm, no provider":     string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "cloudvm"})),
		"cloudvm, bad provider":    string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "cloudvm", HostProvider: "aws"})),
		"microvm with provider":    string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "microvm", HostProvider: "gcp"})),
		"dedicated, no generation": string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "dedicated"})),
		"microvm with generation":  string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "microvm", HostGeneration: "g"})),
		"bad token":                string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "https://platform.kete.test", ClaimToken: "short", StorageHost: "storage.kete.test", HostProfile: "microvm"})),
		"http platform":            string(marshal(t, Config{JobID: goodConfig().JobID, PlatformURL: "http://platform.kete.test", ClaimToken: goodToken, StorageHost: "storage.kete.test", HostProfile: "microvm"})),
	}
	for name, raw := range bad {
		if _, err := DecodeConfig(strings.NewReader(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestFromEnv: the environment path is fly's only (ADR 0023 rule 16).
func TestFromEnv(t *testing.T) {
	v, err := FromEnv(env(good()), true)
	if err != nil || v.Profile != "fly" || v.Source != "env" {
		t.Errorf("unset, /.fly: %+v %v", v, err)
	}
	m := good()
	m["FLY_MACHINE_ID"] = "x"
	if v, err := FromEnv(env(m), false); err != nil || v.Profile != "fly" || !v.OnFly {
		t.Errorf("unset, Fly variable: %+v %v", v, err)
	}
	if _, err := FromEnv(env(good()), false); err == nil {
		t.Error("unset without a Fly signal accepted")
	}
	m = good()
	m["KETE_JOB_HOST_PROFILE"] = "fly"
	if v, err := FromEnv(env(m), false); err != nil || v.Profile != "fly" {
		t.Errorf("explicit fly: %+v %v (setup refuses it without a signal)", v, err)
	}
	for _, p := range []string{"microvm", "dedicated", "cloudvm", "unknown"} {
		m := good()
		m["KETE_JOB_HOST_PROFILE"] = p
		if _, err := FromEnv(env(m), true); err == nil {
			t.Errorf("%s from the environment accepted", p)
		}
	}
	bad := good()
	bad[VarClaimToken] = "short"
	if _, err := FromEnv(env(bad), true); err == nil {
		t.Error("invalid values accepted")
	}
}

func TestFromConfig(t *testing.T) {
	c := goodConfig()
	v, err := FromConfig(c, env(map[string]string{"KETE_JOB_HOST_PROFILE": "dedicated"}))
	if err != nil || v.Profile != "dedicated" || v.Source != "pipe" || v.Generation != "gen-1" || v.ClaimToken != goodToken || v.OnFly {
		t.Fatalf("dedicated: %+v %v", v, err)
	}
	if _, err := FromConfig(c, env(nil)); err != nil {
		t.Errorf("no profile in the environment: %v", err)
	}
	if v, err := FromConfig(c, env(map[string]string{"FLY_REGION": "ams"})); err != nil || !v.OnFly {
		t.Errorf("Fly variable not noted: %+v %v", v, err)
	}
	if _, err := FromConfig(c, env(map[string]string{"KETE_JOB_HOST_PROFILE": "microvm"})); err == nil {
		t.Error("profile mismatch accepted")
	}
	for _, k := range []string{VarJobID, VarPlatformURL, VarClaimToken, VarStorageHost} {
		if _, err := FromConfig(c, env(map[string]string{k: good()[k]})); err == nil {
			t.Errorf("%s in both places accepted", k)
		}
	}
	// Round trip through the handover keeps the profile fields, and Decode re-validates them.
	b, _ := Encode(v)
	got, err := Decode(bytes.NewReader(b))
	if err != nil || got != v {
		t.Errorf("handover: %+v %v", got, err)
	}
	tampered := v
	tampered.Source = "env"
	b, _ = Encode(tampered)
	if _, err := Decode(bytes.NewReader(b)); err == nil {
		t.Error("handover with dedicated from the environment accepted")
	}
	tampered = v
	tampered.Generation = ""
	b, _ = Encode(tampered)
	if _, err := Decode(bytes.NewReader(b)); err == nil {
		t.Error("handover without a generation accepted")
	}
}
