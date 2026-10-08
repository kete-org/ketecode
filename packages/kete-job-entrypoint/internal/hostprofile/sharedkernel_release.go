//go:build !kete_testdriver

package hostprofile

// SharedKernelTestBuild is false in every release build: the kubevm profile's test-only
// shared-kernel mode (kind CI) is refused as a shared kernel (KubeVMKernel).
const SharedKernelTestBuild = false
