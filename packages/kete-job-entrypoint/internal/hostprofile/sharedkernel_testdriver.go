//go:build kete_testdriver

package hostprofile

// SharedKernelTestBuild: this is a test build (-tags kete_testdriver, kind CI only, never
// released). The kubevm profile accepts its test-only shared-kernel mode, in which the pod must run
// its node's own kernel (runc behind the CI-only `kete-test` RuntimeClass).
const SharedKernelTestBuild = true
