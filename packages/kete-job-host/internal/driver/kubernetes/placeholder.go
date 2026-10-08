//go:build kete_testdriver

package kubernetes

import (
	"strconv"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
)

// PlaceholderAvailable reports whether this build has the placeholder pod driver.
const PlaceholderAvailable = true

// TestBuild: a kete_testdriver build (kind CI only, never released). It accepts the CI-only
// SharedKernelTestClass RuntimeClass.
const TestBuild = true

// Placeholder is the test-only PodFunc (build tag kete_testdriver; config pod_driver
// "placeholder"): each machine is a pod running its allowlisted image's `sleep` under the first
// configured RuntimeClass, as an unprivileged user with every capability dropped, so the
// controller's whole loop — enroll, poll, pods, boot-ID Secret, stop, deadline and orphan kill,
// the admission policy — runs on kind without Kata. It never receives the machine configuration
// (the generic driver writes only the node's boot ID). Machines of an image listed in exitAfter
// exit by themselves after that many seconds; the others sleep past their deadline, so only the
// controller ends them.
func Placeholder(runtimeClass string, exitAfter map[string]int, now func() time.Time) PodFunc {
	return func(s driver.Spec) (kube.Pod, error) {
		secs, ok := exitAfter[s.Image]
		if !ok {
			secs = int(max(60, s.Deadline.Add(contract.DeadlineGrace+10*time.Minute).Sub(now()).Seconds()))
		}
		nobody := int64(65534)
		grace := int64(2)
		res := map[string]string{"cpu": "10m", "memory": "16Mi"}
		return kube.Pod{Spec: kube.PodSpec{
			RuntimeClassName:              runtimeClass,
			TerminationGracePeriodSeconds: &grace,
			SecurityContext: &kube.PodSecurityContext{
				RunAsNonRoot: ptr(true), RunAsUser: &nobody, RunAsGroup: &nobody,
				SeccompProfile: &kube.SeccompProfile{Type: "RuntimeDefault"},
			},
			Containers: []kube.Container{{
				Name: "job", Image: s.Image, ImagePullPolicy: "IfNotPresent",
				Command:   []string{"sleep", strconv.Itoa(secs)},
				Resources: &kube.Resources{Requests: res, Limits: res},
				SecurityContext: &kube.SecurityContext{
					AllowPrivilegeEscalation: ptr(false), ReadOnlyRootFilesystem: ptr(true), Privileged: ptr(false),
					Capabilities: &kube.Capabilities{Drop: []string{"ALL"}},
				},
			}},
		}}, nil
	}
}
