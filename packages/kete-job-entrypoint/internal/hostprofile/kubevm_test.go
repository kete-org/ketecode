package hostprofile

import (
	"errors"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

const (
	podBoot  = "b45a25df-1c2d-4e3f-8a9b-0c1d2e3f4a5b"
	nodeBoot = "26ab45b9-0d3c-4c1e-9b8a-1f2e3d4c5b6a"
)

func refusal(err error) phaselog.Code {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Code
	}
	return ""
}

func TestKubeVMBootIDRule(t *testing.T) {
	ok := Signals{Source: SourceFile, BootID: podBoot, NodeBootID: nodeBoot}
	if err := Check(KubeVM, ok); err != nil {
		t.Fatalf("own kernel refused: %v", err)
	}
	cases := map[string]struct {
		s    Signals
		code phaselog.Code
	}{
		"the node's kernel (runc)": {Signals{Source: SourceFile, BootID: nodeBoot, NodeBootID: nodeBoot}, phaselog.CodeSharedKernel},
		"no node boot id":          {Signals{Source: SourceFile, BootID: podBoot}, phaselog.CodeSharedKernel},
		"unreadable own boot id":   {Signals{Source: SourceFile, NodeBootID: nodeBoot}, phaselog.CodeSharedKernel},
		"malformed node boot id":   {Signals{Source: SourceFile, BootID: podBoot, NodeBootID: "x"}, phaselog.CodeSharedKernel},
		"values from a pipe":       {Signals{Source: SourcePipe, BootID: podBoot, NodeBootID: nodeBoot}, phaselog.CodeSource},
		"fly signals":              {Signals{Source: SourceFile, FlyEnv: true, BootID: podBoot, NodeBootID: nodeBoot}, phaselog.CodeFlySignals},
	}
	for name, c := range cases {
		if got := refusal(Check(KubeVM, c.s)); got != c.code {
			t.Errorf("%s: %q, want %q", name, got, c.code)
		}
	}
	if SourceFor(KubeVM) != SourceFile {
		t.Error("kubevm's values come from the file")
	}
	if n, err := Parse("kubevm"); err != nil || n != KubeVM {
		t.Error("kubevm is not a profile")
	}
}

func TestKubeVMSharedKernelTestMode(t *testing.T) {
	same := Signals{Source: SourceFile, BootID: nodeBoot, NodeBootID: nodeBoot, SharedKernelTest: true}
	other := Signals{Source: SourceFile, BootID: podBoot, NodeBootID: nodeBoot, SharedKernelTest: true}
	if !SharedKernelTestBuild {
		// A release build refuses the test mode whatever the boot IDs say.
		for name, s := range map[string]Signals{"same": same, "different": other} {
			if refusal(Check(KubeVM, s)) != phaselog.CodeSharedKernel {
				t.Errorf("release build accepted the test mode (%s)", name)
			}
		}
		return
	}
	// The kete_testdriver build: the pod must be on exactly the node the runner named.
	if err := Check(KubeVM, same); err != nil {
		t.Errorf("test mode on the named node refused: %v", err)
	}
	if refusal(Check(KubeVM, other)) != phaselog.CodeSharedKernel {
		t.Error("test mode with a wrong node boot id accepted")
	}
}

func TestKubeTargets(t *testing.T) {
	ps := KubeTargets("10.96.0.1:443", []string{"10.0.0.7"})
	if len(ps) != 1+len(GatewayPorts) || ps[0].Target != "10.96.0.1:443" || ps[0].Reason != phaselog.CodeKubeAPI || ps[1].Reason != phaselog.CodeNode {
		t.Errorf("targets %+v", ps)
	}
	// The probe's request accepts them (an unknown reason would fail the whole check as `probe`).
	req := isolation.NewRequest(append(isolation.Controls("127.0.0.1:1", ""), ps...))
	if err := req.Validate(); err != nil {
		t.Errorf("request with the kubevm targets: %v", err)
	}
	if len(KubeTargets("", nil)) != 0 {
		t.Error("targets without inputs")
	}
}
