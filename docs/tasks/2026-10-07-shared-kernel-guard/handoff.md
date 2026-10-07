# Handoff: shared-kernel guard for the job entrypoint

## 2026-10-07 claude (subagent)
- Done: spec (approved under the standing Phase 8 security-fix approval), plan, build, docs.
- Decisions: `dedicated` runs in the host's own kernel by design, so it gets a "set up by the
  dedicated reaper" guard (namespaces + PID 1 argv + no container-runtime marks) instead of a
  boot-ID check; microvm/cloudvm get the initial-namespace proof (kete-job-init is the kernel's
  init), which needs no host input and no contract change. `fly` unchanged. `setup_host` moved
  before `boot`. The image e2e now runs under a test-only stand-in reaper.
- Open: run `kete-job-host scripts/kvm-test.sh` (real dedicated + Firecracker with the real image)
  to confirm the guard passes on real hosts; decide whether `fly` should also require the initial
  PID namespace once it can be verified on a Fly machine.
