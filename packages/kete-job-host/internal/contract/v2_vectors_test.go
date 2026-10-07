package contract_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/vectors"
)

// decodeValidate is Decode (the schema's shape) then Validate (its value rules).
func decodeValidate[T interface{ Validate() error }](raw []byte) error {
	var v T
	if err := contract.Decode(raw, &v); err != nil {
		return err
	}
	return v.Validate()
}

// schemas maps each Zod export named in messages.json to its Go check.
var schemas = map[string]func([]byte) error{
	"JobHostV2Facts":         decodeValidate[contract.FactsV2],
	"JobHostV2EnrollRequest": decodeValidate[contract.EnrollRequestV2],
	"JobHostV2Report":        decodeValidate[contract.ReportV2],
	"JobHostPublishOutcome":  decodeValidate[contract.PublishOutcome],
	"JobHostV2RunMachine":    decodeValidate[contract.RunMachineV2],
	"JobHostV2KubernetesRunMachine": func(raw []byte) error {
		var m contract.RunMachineV2
		if err := contract.Decode(raw, &m); err != nil {
			return err
		}
		return m.ValidateKubernetes()
	},
	"JobMachineConfigV2": func(raw []byte) error {
		c, err := seal.ParseMachineConfig(raw)
		if err != nil {
			return err
		}
		return c.ValidateV2()
	},
	"JobHostV2PollResponse": func(raw []byte) error {
		_, err := contract.ParsePollResponseV2(raw)
		return err
	},
	"JobHostV2ErrorResponse": decodeValidate[contract.ErrorResponseV2],
}

// TestV2Messages: every case of messages.json is accepted or refused exactly as the platform's
// schema does.
func TestV2Messages(t *testing.T) {
	var v vectors.Messages
	if err := vectors.LoadV2("messages.json", &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) != 90 {
		t.Fatalf("%d cases, the contract has 90", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Schema+"/"+c.Name, func(t *testing.T) {
			check, ok := schemas[c.Schema]
			if !ok {
				t.Fatalf("no Go check for schema %s", c.Schema)
			}
			err := check(c.Value)
			if c.Valid && err != nil {
				t.Errorf("refused: %v", err)
			}
			if testing.Verbose() && err != nil {
				t.Log(err)
			}
			if !c.Valid && err == nil {
				t.Error("accepted")
			}
		})
	}
}

func messageValue(t *testing.T, schema, name string) []byte {
	t.Helper()
	var v vectors.Messages
	if err := vectors.LoadV2("messages.json", &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		if c.Schema == schema && c.Name == name {
			return c.Value
		}
	}
	t.Fatalf("no case %s/%s", schema, name)
	return nil
}

// TestV2PollResponseWithVersion: the vector's refused responses differ from a valid one only by
// `version`; with `version: 2` it is accepted, unknown fields included, and each run machine then
// passes the kubernetes host's own check.
func TestV2PollResponseWithVersion(t *testing.T) {
	raw := messageValue(t, "JobHostV2PollResponse", "a response with version 1")
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	obj["version"] = 2
	obj["future_field"] = true
	b, _ := json.Marshal(obj)
	p, err := contract.ParsePollResponseV2(b)
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if len(p.Desired.Run) == 0 {
		t.Fatal("no run machines")
	}
	for _, m := range p.Desired.Run {
		if err := m.ValidateKubernetes(); err != nil {
			t.Errorf("machine %s: %v", m.MachineID, err)
		}
	}
	// A null optional field is refused (Zod), not read as absent.
	for _, key := range []string{"publish", "repository", "config"} {
		var o map[string]any
		_ = json.Unmarshal(b, &o)
		o["desired"].(map[string]any)["run"].([]any)[0].(map[string]any)[key] = nil
		nb, _ := json.Marshal(o)
		if _, err := contract.ParsePollResponseV2(nb); err == nil {
			t.Errorf("%s: null accepted", key)
		}
	}
	// A bad image fails only its machine, not the response (v1's behaviour).
	var o map[string]any
	_ = json.Unmarshal(b, &o)
	o["desired"].(map[string]any)["run"].([]any)[0].(map[string]any)["image"] = "registry.corp.example/kete/kete-job:latest"
	nb, _ := json.Marshal(o)
	p, err = contract.ParsePollResponseV2(nb)
	if err != nil {
		t.Fatalf("a bad image discarded the response: %v", err)
	}
	if p.Desired.Run[0].Validate() == nil {
		t.Error("a tag image accepted for its machine")
	}
}

// TestV2ReportRoundTrip: the signed poll body of signatures.json decodes, validates and
// re-encodes byte for byte (field order is the contract's), and so does the enroll body.
func TestV2ReportRoundTrip(t *testing.T) {
	var v vectors.SignaturesV2
	if err := vectors.LoadV2("signatures.json", &v); err != nil {
		t.Fatal(err)
	}
	for _, r := range v.Requests {
		t.Run(r.Name, func(t *testing.T) {
			var body interface{ Validate() error }
			switch r.Name {
			case "poll":
				var rep contract.ReportV2
				if err := contract.Decode([]byte(r.Body), &rep); err != nil {
					t.Fatal(err)
				}
				body = rep
			case "enroll":
				var er contract.EnrollRequestV2
				if err := contract.Decode([]byte(r.Body), &er); err != nil {
					t.Fatal(err)
				}
				body = er
			default:
				t.Fatalf("unknown request %s", r.Name)
			}
			if err := body.Validate(); err != nil {
				t.Fatal(err)
			}
			if out, _ := json.Marshal(body); string(out) != r.Body {
				t.Errorf("re-encoding differs:\n%s\nwant\n%s", out, r.Body)
			}
		})
	}
}

// TestV2Boundary: narrowing takes the stricter setting each time and never widens.
func TestV2Boundary(t *testing.T) {
	full := contract.DataBoundary{Summary: "full", Denials: "full", PublishRefs: "send"}
	if got := full.Narrow(contract.DefaultDataBoundary); got != contract.DefaultDataBoundary {
		t.Errorf("narrow(full, default) = %+v", got)
	}
	mixed := contract.DataBoundary{Summary: "redacted", Denials: "count", PublishRefs: "send"}
	want := contract.DataBoundary{Summary: "none", Denials: "count", PublishRefs: "send"}
	if got := mixed.Narrow(contract.DefaultDataBoundary); got != want {
		t.Errorf("narrow = %+v, want %+v", got, want)
	}
	if contract.DefaultDataBoundary.Validate() != nil || (contract.DataBoundary{Summary: "all", Denials: "full", PublishRefs: "send"}).Validate() == nil {
		t.Error("boundary validation")
	}
}

// TestV1BodiesUnderV2: a v1 enroll body (no version, v1 facts) is not a v2 body.
func TestV1BodiesUnderV2(t *testing.T) {
	enroll := `{"enrollment_token":"kete_jhe_6VYcQvAovMFvzajh-0vmcx7RWhVSTIIG3X0p3qtdzHk","signing_key":"aqvKk_cQiwy0qZqDflMnLRaTOhufBkHzqORXp6BveqU","sealing_key":"9sT08dK32cQC5495pwlgLlwyRS1Im9elh8UkfgJxpnE","facts":{"arch":"amd64","driver":"firecracker","slots":4,"kvm":true,"reset":"none","generation":"g-2026-10-03.1","versions":{"agent":"0.9.0","firecracker":"1.13.1","guest_kernel":"6.1.141-kete.1","host_kernel":"6.8.0-45-generic"}}}`
	if decodeValidate[contract.EnrollRequestV2]([]byte(enroll)) == nil {
		t.Error("a v1 enroll body accepted under v2")
	}
	if decodeValidate[contract.EnrollRequestV2]([]byte(strings.Replace(enroll, `{"enrollment_token"`, `{"version":2,"enrollment_token"`, 1))) != nil {
		t.Error("the same body with version 2 refused")
	}
	if _, err := contract.ParseEnrollResponseV2([]byte(`{"host_id":"c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c","status":"pending","fingerprint":"03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a","next_poll_after":10}`)); err == nil {
		t.Error("an enroll response without version accepted")
	}
}
