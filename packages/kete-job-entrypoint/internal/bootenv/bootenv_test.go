package bootenv

import (
	"bytes"
	"strings"
	"testing"
)

const goodToken = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func good() map[string]string {
	return map[string]string{
		VarJobID:       "0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c",
		VarPlatformURL: "https://platform.kete.test/",
		VarClaimToken:  goodToken,
		VarStorageHost: "storage.kete.test",
	}
}

func TestReadValid(t *testing.T) {
	v, err := Read(env(good()))
	if err != nil {
		t.Fatal(err)
	}
	if v.PlatformURL != "https://platform.kete.test" || v.PlatformHost() != "platform.kete.test" {
		t.Errorf("url = %q host = %q", v.PlatformURL, v.PlatformHost())
	}
}

func TestReadRefusals(t *testing.T) {
	cases := map[string]map[string]string{
		"no id":           {VarJobID: ""},
		"bad id":          {VarJobID: "not-a-uuid"},
		"http":            {VarPlatformURL: "http://platform.kete.test"},
		"port":            {VarPlatformURL: "https://platform.kete.test:8443"},
		"userinfo":        {VarPlatformURL: "https://u:p@platform.kete.test"},
		"query":           {VarPlatformURL: "https://platform.kete.test/?a=b"},
		"fragment":        {VarPlatformURL: "https://platform.kete.test/#x"},
		"path":            {VarPlatformURL: "https://platform.kete.test/api"},
		"ip":              {VarPlatformURL: "https://10.0.0.1"},
		"single label":    {VarPlatformURL: "https://localhost"},
		"upper":           {VarPlatformURL: "https://Platform.kete.test"},
		"short token":     {VarClaimToken: "short"},
		"long token":      {VarClaimToken: strings.Repeat("a", 513)},
		"space in token":  {VarClaimToken: goodToken + " x"},
		"non-ascii token": {VarClaimToken: goodToken + "é"},
		"no storage host": {VarStorageHost: ""},
		"storage url":     {VarStorageHost: "https://storage.kete.test"},
		"storage ip":      {VarStorageHost: "10.0.0.1"},
	}
	for name, override := range cases {
		m := good()
		for k, v := range override {
			m[k] = v
		}
		if _, err := Read(env(m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestEncodeDecode(t *testing.T) {
	v, _ := Read(env(good()))
	b, err := Encode(v)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(bytes.NewReader(b))
	if err != nil || got != v {
		t.Fatalf("decode = %+v, %v", got, err)
	}
	if _, err := Decode(bytes.NewReader([]byte(`{"job_id":"x"}`))); err == nil {
		t.Error("invalid payload accepted")
	}
	if _, err := Decode(bytes.NewReader(bytes.Repeat([]byte("a"), maxPayload+2))); err == nil {
		t.Error("oversized payload accepted")
	}
}

func TestOnFly(t *testing.T) {
	v, _ := Read(env(good()))
	if v.OnFly {
		t.Error("OnFly without a Fly variable")
	}
	for _, k := range FlyVars {
		m := good()
		m[k] = "x"
		v, err := Read(env(m))
		if err != nil || !v.OnFly {
			t.Errorf("%s: OnFly = %v, %v", k, v.OnFly, err)
		}
		b, _ := Encode(v)
		got, err := Decode(bytes.NewReader(b))
		if err != nil || !got.OnFly {
			t.Errorf("%s: OnFly lost across the handover: %+v, %v", k, got, err)
		}
	}
}

func TestNormalizeHTTPSURLWithPath(t *testing.T) {
	got, err := NormalizeHTTPSURL("https://github.com/org/repo.git", true)
	if err != nil || got != "https://github.com/org/repo.git" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := NormalizeHTTPSURL("https://github.com/org/../x", true); err == nil {
		t.Error(".. accepted")
	}
}
