# S0 report: the job entrypoint in a Kata (VM-isolated) Kubernetes pod

- Spike S0 of `spec.md` §10 (ADR 0011, Proposed). Run 2026-10-07 on the `kvmtest` Colima VM.
- Scope: findings and throwaway files only. Nothing in the repository's code changed. A prototype
  `kubevm` patch was built from a scratch copy (`s0/kubevm-prototype.diff`).
- Throwaway manifests, scripts and raw outputs are in `s0/` next to this file.

## Verdict (short)

**Proceed with the VM-isolated design, with five adjustments** (detailed in §8):

1. **The released entrypoint runs, nearly unchanged, in a Kata pod with capabilities and without
   `privileged: true`.** It got past every pre-claim step (setup, sysctls, `hidepid=2`, host-boundary
   probe, nftables, egress proxy, root helper, cgroups, tool-user isolation check), then claimed.
   The `no-agent` job ran to `finish` against the fake platform. This held twice: once with the
   released binary plus a 3-line shell wrapper, once with the prototype `kubevm` entrypoint.
2. **Two real code changes are needed.** Making `/proc/sys` and `/sys/fs/cgroup` writable (CRI
   mounts both read-only in a non-privileged container) is about 10 lines and was prototyped. The
   other is a config-file source with Secret unmount (P2 already plans it).
3. **The capability set in spec §4.2 is not enough.** It also needs `SYS_RESOURCE`, `FOWNER` and
   `FSETID`, so 10 in total.
4. **The planned "VM signals" don't work, and the spec must drop them.** A `runc` pod on a node that
   is itself a VM (every managed cloud node) shows the same virtio devices, including vsock, and the
   same hypervisor DMI. The signal that works is "my boot ID ≠ the node's boot ID". The controller
   reads the node's boot ID from `Node.status.nodeInfo.bootID`. It was prototyped, and it refused
   `runc` pods (plain and `privileged`) before any write.
5. **The guest's clock and the NetworkPolicy timing need design changes** (§5.6, §5.7).

**Only partly proven:** the `lifecycle` scenario (real `kete` agent with a scripted model) inside
Kata. Run k5 shows these parts working in the guest:

- claim and clone;
- `kete` sync;
- the first model turn;
- the **shell tool running as `kete-tool` through the root helper** (`id -un` → `kete-tool`);
- the entrypoint's report path: result, bundle, three uploads, finish.

But `kete` then ended with `outcome: error`, `"message":"interrupted: user"`, after 20.4 min and
before the scripted second turn. So the README edit and symlink checks didn't run, and the cause is
not determined (§5.10).

The same image passes the whole lifecycle in 3 s under a `privileged` runc pod (r2). Everything in
the Kata guest is extremely slow on this host: `kete --version` takes about 27 s versus 0.16 s under
runc (§6). That is very likely an artefact of nested virtualization on Apple silicon, not of Kata,
but it is not proven.

Nothing here was run on AKS, OpenShift, EKS or GKE (§7).

## 1. Environment and versions

| Item | Version |
|---|---|
| Host | Apple M3 Pro, macOS 26.6.2, Colima 0.10.3, profile `kvmtest` (VZ, nested virtualization), 4 vCPU, 8 GiB |
| Node OS / kernel | Ubuntu 24.04.4, `6.8.0-117-generic` (aarch64), cgroup v2, AppArmor enabled |
| Kubernetes | k3s `v1.35.9+k3s1`, containerd `2.2.7-k3s1`, flannel, built-in kube-router NetworkPolicy controller; `--disable traefik,servicelb,metrics-server` |
| Kata | `4.2.0` static release `kata-static-4.2.0-arm64.tar.zst` (sha256 `5dd4e9f2…376b`). Rust runtime (`runtime-rs`) shim, QEMU `11.0.1 (kata-static)`, guest kernel `6.18.35`, default rootfs image, `shared_fs = virtio-fs` |
| Job image | `ghcr.io/kete-org/kete-job:kete-v0.2.5` = index `sha256:7c0c31d68d17cf8cd9d1ecbe9186b102ee6571c931bc072bd19b7739cf4a676a` (arm64 manifest `sha256:99f42930…d0bb`, amd64 `sha256:18cd4db8…51a6`). Job-package sources at `HEAD` are identical to the tag |
| Fake platform | `cmd/kete-job-fake-platform` built from `HEAD` (= tag) in the VM with Go `1.26.8` |
| Prototype image | `kete-job:s0-kubevm` = the released image + the patched entrypoint only (built and imported locally in the VM, never pushed) |

**Kata on this host needed two config changes.** Both are in a copy of the config,
`/etc/kata-containers/configuration-qemu-s0.toml`, so the shipped files are unchanged:

- `cpu_features = ""` instead of `"pmu=off"`. Nested KVM on Apple VZ exposes no PMU, and QEMU
  refused to start: `can't apply global host-arm-cpu.pmu=off: Property 'host-arm-cpu.pmu' not found`.
  On the runtime side this surfaced only as `timed out waiting for QMP ready: qmp.sock`.
- `reconnect_timeout_ms = 60000` instead of `3000`. The nested guest boots too slowly for the
  default agent dial budget: `vsock: failed to connect … within 10s … ECONNRESET`.

`enable_mem_prealloc = true` was also tried, to see whether it helped performance. The VM never
started within the QMP timeout, and a failed sandbox left a stuck shim with a defunct QEMU that only
`kill -9` and `crictl rmp` cleared. That change was reverted.

Firecracker was not tried: the arm64 static tarball ships no Firecracker binary. Dragonball and
Cloud Hypervisor were not tried for lack of time.

## 2. Reproducible steps

All commands run inside the VM (`colima ssh -p kvmtest -- …`). Files are in `s0/`.

1. **k3s:**
   ```sh
   curl -sfL https://get.k3s.io -o k3s-install.sh
   INSTALL_K3S_VERSION=v1.35.9+k3s1 \
     INSTALL_K3S_EXEC="--disable traefik --disable servicelb --disable metrics-server --write-kubeconfig-mode 644" \
     sh k3s-install.sh
   ```
2. **Kata:**
   ```sh
   tar --zstd -xf kata-static-4.2.0-arm64.tar.zst -C /
   ```
   Copy the QEMU runtime-rs config to `/etc/kata-containers/configuration-qemu-s0.toml` with the two
   edits in §1. Copy `s0/containerd-kata.toml` to
   `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/kata.toml` and run
   `systemctl restart k3s`. Then `kubectl apply -f s0/runtimeclasses.yaml` (`kata-qemu`, with
   `overhead`).
3. **Fake platform:**
   - Build `kete-job-fake-platform` (`CGO_ENABLED=0 go build ./cmd/kete-job-fake-platform`).
   - Give the node the fake's documentation-range address:
     `ip link add kete-fake type dummy; ip addr add 198.51.100.10/32 dev kete-fake; ip link set kete-fake up`.
   - The job pod reaches it through its default gateway (the node), and uses
     `dnsPolicy: None, nameservers: [198.51.100.10]`. The fake's CA is appended to the image's bundle
     and mounted over `/etc/ssl/certs/ca-certificates.crt` (as `e2e.sh` does).
4. **NetworkPolicy:** `kubectl apply -f s0/netpol.yaml`. Egress is allowed only to the fake (443,
   DNS) and to public `:443` outside the private and special ranges. All ingress is denied.
5. **One run:** `s0/run-job.sh <name> <scenario> <runtimeclass|runc> <secctx> <wrapper>` with the
   optional env `IMAGE`, `PROFILE=kubevm`, `NODE_BOOT_ID`, `FAKE_ARGS` and `WAIT_S`. It does this:
   - starts the fake, writes the Secret `kete-job-s0` with `config.json`;
   - renders `s0/job-pod.yaml.tmpl`, applies it, waits and prints the phase lines.

   The wrappers in `s0/wrappers/` are mounted from a ConfigMap. They exist only because there is no
   `--config-file` source yet.
6. **Other probes:** `s0/inspect-pods.yaml` (VM signals, Kata vs runc), `s0/clock-pods.yaml`,
   `s0/bench-pods.yaml`, `s0/secret-pod.yaml`, `s0/late-secret-pod.yaml`, `s0/idle-pod.yaml` and
   `s0/caps-matrix.sh`.

## 3. The pod spec that works

This is run `k1`: the prototype entrypoint with the `kubevm` profile. Run `j4` is the same except
for one line: the released entrypoint, `KETE_JOB_HOST_PROFILE=dedicated`, and `wrappers/remount.sh`
instead of the entrypoint's own remount.

```yaml
apiVersion: v1
kind: Pod
metadata: {name: kete-job-<machine>, namespace: kete-jobs, labels: {app: kete-job}}
spec:
  runtimeClassName: kata-qemu            # from the allowlist; admission rejects anything else
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  dnsPolicy: None                        # S0: the fake's resolver; production: the cluster/enterprise resolver
  dnsConfig: {nameservers: [198.51.100.10]}
  containers:
  - name: job
    image: ghcr.io/kete-org/kete-job@sha256:…   # by digest
    command: ["/bin/sh", "/s0/kubevm.sh"]       # S0 only: read Secret, umount it, pipe to --config-fd 0
    env: [{name: KETE_JOB_HOST_PROFILE, value: kubevm}]
    resources: {requests: {cpu: "1", memory: 2Gi}, limits: {cpu: "1", memory: 2Gi}}
    securityContext:
      privileged: false
      allowPrivilegeEscalation: false    # works: the entrypoint uses setres*id, not setuid binaries
      capabilities:
        drop: [ALL]
        add: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL, CHOWN, DAC_OVERRIDE, FOWNER, FSETID]
    volumeMounts:
    - {name: config, mountPath: /run/kete-config, readOnly: true}
  volumes:
  - {name: config, secret: {secretName: kete-job-<machine>, defaultMode: 0400}}
```

Further notes on this spec:

- **No annotations are needed.** Kata's `privileged_without_host_devices = true` is set in the
  containerd runtime entry, but it matters only if someone sets `privileged: true`. That setting is
  not needed and should stay forbidden by admission.
- **Seccomp:** none in the guest (Kata default `disable_guest_seccomp = true`; the guest showed
  `Seccomp: 0`). `seccompProfile: RuntimeDefault` on a Kata pod was not tested. Because seccomp
  applies inside the guest, it could block `mount` and must be tested before the chart sets it.
- **PSA:** the namespace must be `privileged`, because PSA `baseline` forbids adding `SYS_ADMIN`
  and `NET_ADMIN`. The `ValidatingAdmissionPolicy` must therefore carry the whole policy: the
  RuntimeClass allowlist, exactly this capability set, no `privileged`, no host namespaces, no
  `hostPath`.
- **Unprivileged ports:** the entrypoint binds ports 81-83 as root without `NET_BIND_SERVICE`. That
  worked only because containerd sets `net.ipv4.ip_unprivileged_port_start=0` in the pod (seen as `0`
  inside the Kata guest: `enable_unprivileged_ports = true`, the containerd ≥ 2.0 default). Add
  `NET_BIND_SERVICE` to the set, or have the controller check this setting.

## 4. Results per check

Phase lines are excerpts from the runs (full logs: `s0/inspect-*.txt`; job logs printed by
`run-job.sh`). Each run started a fresh fake job.

### 4.1 Unchanged entrypoint, Kata, capabilities, no privileged

| Run | Setup | Result |
|---|---|---|
| j1 | released entrypoint; only a pipe wrapper | `setup_sysctl failed errno 30` (EROFS). CRI mounts `/proc/sys` read-only |
| j2 | + wrapper remounts `/proc/sys` and `/sys/fs/cgroup` rw | sysctls and `hidepid=2` ok. `host_boundary failed code gateway`: no NetworkPolicy, and the node (10.42.0.1) answers on 22/6443/10250. **Correct refusal before claim** |
| j3 | + NetworkPolicy; caps without `FSETID` | `host_boundary ok`. `setup_dirs failed class other`: the setgid bit on `/srv/kete-job/work` doesn't stick without `CAP_FSETID` |
| **j4** | + `FSETID` | **Every step ok:** boot → setup_host → users → sysctl → proc → host_boundary → dirs → cgroup → egress (nft, proxy) → helper → isolation → **claim** → egress_restart → clone → verify → revoke → clone_done → agent_copy → agent → stop_agents → result → bundle → uploads → finish, `exit_code 0`. Fake: `finish accepted` |

`j4` excerpt:

```
{"step":"setup_sysctl","event":"ok"} {"step":"setup_proc","event":"ok"}
{"step":"host_boundary","event":"ok"} {"step":"setup_cgroup","event":"ok"}
{"step":"egress_nft","event":"ok"} {"step":"helper","event":"ok"} {"step":"isolation","event":"ok"}
{"step":"claim","event":"ok"} … {"step":"finish","event":"ok"} {"step":"job","event":"exit","exit_code":0}
```

### 4.2 Prototype `kubevm` entrypoint

| Run | Runtime | Result |
|---|---|---|
| **k1** | Kata, the §3 pod (APE false, 10 caps, Secret unmounted) | `setup_host ok`, `setup_kubevm ok` (the entrypoint's own remounts), then every step as in j4, `exit_code 0`, `finish accepted` |
| k2 | `runc`, same capabilities | `{"step":"setup_host","event":"failed","code":"shared_kernel"}`, exit 1, nothing written |
| k3 | `runc`, `privileged: true` | `{"step":"setup_host","event":"failed","code":"shared_kernel"}`, exit 1, nothing written |

### 4.3 Refusal under runc (what the released entrypoint does today)

| Run | runc pod | Result |
|---|---|---|
| r4 | caps, pipe wrapper | `setup_sysctl failed errno 30`. It refuses, but only by accident (read-only `/proc/sys`) |
| r3 | caps + the remount wrapper | Both remounts **succeeded** under runc. `setup_sysctl failed errno 13`: only the node's AppArmor `cri-containerd.apparmor.d` profile stopped writes to **host** sysctls. On a node without that LSM confinement, the same pod would change the node's sysctls |
| r1 | `privileged: true`, pipe | `host_boundary failed code gateway`, but only because the pod started before kube-router programmed the NetworkPolicy (§5.7) |
| r2 | `privileged: true`, 15 s delay | **The whole lifecycle job passed in a shared-kernel pod** (agent ran, `edit_ok`, `tool_user`, symlink reads and writes refused, uploads, finish). As a side effect it set the **node's** `user.max_user_namespaces` to 0. S0 restored it to the kernel default 31513 (= `threads-max/2` = `max_pid_namespaces`) |

So the released `dedicated` profile has no shared-kernel check. A `privileged` runc pod passes
everything and changes host-wide sysctls. The `kubevm` profile's boot-ID check (or an equivalent)
is required, and it must run before any write. In the prototype it is the first check after boot.

### 4.4 Capabilities

All runs below use the prototype entrypoint in Kata, the `no-agent` scenario, and
`allowPrivilegeEscalation: false`. Each run drops one capability from the 10.

| Dropped | Result | Why |
|---|---|---|
| — (all 10) | pass (k1) | |
| `SYS_RESOURCE` | `boot failed errno 13` | `oom_score_adj = -1000`. It is also needed for `user.max_user_namespaces` |
| `FSETID` | `setup_dirs` failed (j3) | the setgid worktree parent |
| `FOWNER` | `setup_dirs failed errno 1` | |
| `CHOWN` | `setup_dirs failed errno 1` | |
| `DAC_OVERRIDE` | `setup_dirs failed errno 13` | |
| `NET_ADMIN` | `egress_nft failed class exit` | nft |
| `SYS_ADMIN` | wrapper `umount` failed (exit 32) | it is also needed for the remounts and `hidepid` |
| `KILL` | **pass** in `no-agent` | `cgroup.kill` does the reaping; signals to job uids (SIGTERM at the time limit) were not exercised. Keep `KILL` until a lifecycle or timeout run proves otherwise |
| `SETUID`, `SETGID` | not tried | obviously required: helper, proxy and tool user |

### 4.5 VM detection

From `s0/inspect-kata.txt` and `s0/inspect-runc.txt` (same image, same capabilities):

| Signal | Kata pod | runc pod (node = a VM) | Usable? |
|---|---|---|---|
| boot ID | `b45a25df-…` (new per pod) | `26ab45b9-…` = `Node.status.nodeInfo.bootID` | **yes, primary** |
| `uname -r` | `6.18.35` | `6.8.0-117-generic` = `nodeInfo.kernelVersion` | secondary only: could match with a distro guest kernel |
| virtio devices, vsock (`0x0013`) | present | **present too** (the node is a VZ VM) | no |
| DMI | **absent** (`/sys/class/dmi` missing on arm64 Kata) | `Apple Inc.` / `Apple Virtualization Generic Platform` | no |
| `/proc/cmdline` | `… systemd.unit=kata-containers.target … agent.cdh_api_timeout=50 …` | node's cmdline | Kata-specific, defense in depth only |
| root mount | `virtiofs` | `overlay` | Kata-specific (and not with a block-device rootfs) |
| `MemTotal` / `nproc` | 2 GiB / 2 (the VM) | 8 GiB / 4 (the node) | not robust |

The spec's planned signals ("virtio devices, a hypervisor DMI vendor") would accept a runc pod on
every cloud VM node. Only "own kernel" proves isolation. The pod can't learn the node's boot ID
itself, since it has no API access. The controller supplies it, which requires knowing the node:

- **Tested** (`late-secret-pod.yaml`): create the pod first, wait for `spec.nodeName`, read the
  Node's `bootID`, then create the Secret. Kubelet logs `FailedMount … secret not found`, retries,
  and starts the pod once the Secret exists. Secret → pod done took 32 s, essentially the VM boot.
  Inside, the pod saw the node's ID `26ab45b9…` and its own `56fc7c72…`.
- **Cost:** the controller needs `get` on `nodes` (a ClusterRole), and the Secret is written after
  scheduling.

### 4.6 Secret volume

- **Inside the guest:** `umount /run/kete-config` (needs `SYS_ADMIN`) works. Afterwards the
  directory is empty and there is no mountinfo line for it. Kata 4.2 copies Secret volumes into a
  guest tmpfs (mount source `/sandbox-…-s`), so they don't come over virtio-fs. Root in the
  container could re-mount the sandbox's `kataShared` virtio-fs, but no copy of the Secret was found
  there. The tool user can't mount (`must be superuser`). The guest-side tmpfs copy is in the agent's
  mount namespace, which the container can't reach (separate PID namespace).
- **On the node:** kubelet's tmpfs copy
  `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~secret/…/config.json` stays (root-only) until
  the pod is deleted, **including after the Secret object is deleted** (kubelet then only logs
  `FailedMount … not found`). The spec's "Secret deleted at running" removes it from the API and
  etcd, not from the node. Keep the claim token's lifetime short, as planned.

### 4.7 Clock (adjtimex)

- **Node / runc pod:** `state=0 TIME_OK status=0x2001 unsync=false maxerror_us=3000`.
- **Kata guest:** always `state=5 TIME_ERROR status=0x40 (STA_UNSYNC) maxerror_us=16000000`. The
  guest kernel has no NTP discipline: no chrony in the guest, though `/sys/class/ptp/ptp0`
  (ptp_kvm) exists.
- **Offset:** guest vs node wall clock over 2 minutes stayed within ±0.3 s. The precision is limited
  by log timestamps; the clock starts from the host RTC at boot.

So an `adjtimex` check inside the job pod would always fail. It belongs in the controller (node
kernel, a read-only `adjtimex` needs no capability), and it covers only the controller's node.

### 4.8 Other observations

- **No exec into a running job pod.** After `setup_cgroup` enables controllers in the container's
  root cgroup, `kubectl exec` fails:
  `failed to add process into unit … EBUSY: Failed to attach processes to control group`. The
  cgroup v2 no-internal-processes rule causes this. Exec liveness probes and ephemeral debug
  containers won't work in job pods. That's acceptable, arguably desirable, and should be
  documented.
- **NetworkPolicy works for Kata pods:** kube-router enforced pod → node and pod → private ranges,
  and `host_boundary` passed only with the policy in place (j2 vs j3).

## 5. Feasibility answers

1. **Unchanged entrypoint in Kata without `privileged`?** Not quite unchanged. With the 10
   capabilities, the only blockers are the read-only `/proc/sys` and `/sys/fs/cgroup` that CRI
   creates. A remount (in a wrapper, or in the entrypoint as prototyped) fixes both, and then
   everything passes through `finish`. The nftables, cgroup v2, `hidepid=2` and sysctl requirements
   are all met by the guest kernel.
2. **Reach claim and refuse under runc?** Yes, via the prototype boot-ID check (k2, k3). The
   released entrypoint refuses unprivileged runc pods only by accident and passes privileged ones
   (r2).
3. **Reliable VM detection?** Only by comparing boot IDs with the node's, supplied by the
   controller (§4.5).
4. **Drop the job Secret?** Yes inside the guest (§4.6). The node keeps its copy until the pod is
   deleted.
5. **Clock?** Not from inside the guest (§4.7).
6. **Required pod settings?** §3.
7. **NetworkPolicy race.** kube-router programs a policy for a new pod's IP after the pod starts.
   A fast runc pod probed before enforcement (r1); Kata's slow boot hid the race here, which is
   luck, not design. The entrypoint failed closed, which is correct, but production should not
   depend on boot latency. Either:
   - require a CNI that enforces before the workload starts (Calico, Cilium: to verify per
     platform), or
   - make `host_boundary` in `kubevm` retry for a bounded window (e.g. 30 s) and pass only once
     every target is unreachable. Nothing secret exists before claim, so a retry costs nothing.
8. **Overheads and start time:** §6.
9. **Network for the fake.** The fake platform ran on the node at 198.51.100.10. The pod reached it
   through its default gateway, and the host-boundary targets (gateway ports, private samples) were
   blocked by the NetworkPolicy alone, with no node nftables table (unlike `e2e.sh`).
10. **Lifecycle (real `kete` + scripted model) in Kata:**
    - j5 (released binary + wrappers, `policy.timeout` 15): reached `agent`. `kete` synced at +40 s
      but made its first model request only at +15 min, so the driver stopped the fake before
      `finish`. It's slow, not broken: heartbeats, sync, `me` and `models` all succeeded.
    - k5 (prototype, the §3 pod, `policy.timeout` 45, deadline 70 min). Claim at 22:42:22, clone
      ok, `agent_copy` ok at 22:42:48. Then `kete`:
      - first sync at 22:43:53;
      - repeated `me`/`models` calls 22:55-23:02;
      - the first `messages` request at 23:03:34;
      - the shell tool `id -un` ran **as `kete-tool` through the helper** (audit:
        `"output":"kete-tool\n"`, `duration_ms: 158938`; the command took 159 s in this guest);
      - the model turn finished with `tool-calls` at 23:07:50.

      `kete` never sent the second turn. It exited at 23:09:30 with
      `{"outcome":"error","exit_code":1,…,"message":"interrupted: user"}` (`duration_ms` 1224701).
      `kete.stderr` says only
      `no run-ended line from the job's audit sink; reporting from the event stream instead`. The
      proxy log shows no denied or failed request.

      The entrypoint then did its part correctly: `stop_agents`, `result`, `bundle` (empty
      manifest), uploads (audit 1565 B, bundle 102 B, proxy log), `finish` (`exit_code 0`,
      `finish accepted`). The fake's `checks.json` is `{}`: no edit, no symlink checks.

      **The cause of the interruption is not determined.** The leading suspect is a timeout inside
      `kete` (client/server or session handling) under this host's 100× memory slowdown, but that is
      not proven. **This must be rerun on a non-nested or x86-nested KVM host before P2 acceptance.**

## 6. Overhead and start time (this host; not representative of production)

| Measure | runc | Kata (QEMU, nested on VZ) |
|---|---|---|
| Pod apply → Running | ~1 s | 18-37 s (idle pod 32.6 s; inspect pod 18-21 s to Completed) |
| Host memory, idle pod (`sleep`), 2 Gi limit | — | ~390 MB RSS: QEMU 360 MB, shim 26 MB, virtiofsd 7 MB; pod cgroup `memory.current` 368 MB |
| Guest size | — | 2 vCPU (1 default + 1 limit), `MemTotal` 2 GiB. The 2 Gi limit didn't raise guest memory beyond `default_memory`. P2 must size `default_memory` and `static_sandbox_resource_mgmt` so `cgroup.LimitsFor(MemTotal)` sees the job size |
| Shell loop (CPU) | 257-279 ms | 370-495 ms |
| `kete --version` | 52-561 ms | **24-28 s** |
| `dd` 200 MB to tmpfs | 47-355 ms | 5.9-7.2 s |
| `sha256sum` of `kete`, cached | 84-88 ms | 1.2-9.8 s |
| sqlite WAL, 300 commits, tmpfs | 16-24 ms | 1.2-1.5 s |

`s0/bench-results.txt` holds the two runs.

- **Why it's slow here:** pure CPU is less than 2× slower, but anything that touches memory is 15-100×
  slower, including tmpfs. That fits the cost of nested stage-2 memory virtualization on Apple VZ
  (QEMU in an L1 guest that runs on Apple's hypervisor). It doesn't measure Kata on bare metal or
  on x86 cloud nested virtualization.
- **Not measured here:** production start time and overhead. Measure them on the first real
  platform before setting the RuntimeClass `overhead`. The `160Mi/250m` in
  `s0/runtimeclasses.yaml` was a guess and is about 2× too low for QEMU.
- **Wall-clock gaps:** the Mac slept at least once (k1 shows a 15-minute wall-clock gap between
  `clone` and `verify`). Only within-run consistency was used for the numbers above.

## 7. What this proves and doesn't prove about managed offerings

**What it proves (k3s + containerd 2.2 + Kata 4.2 runtime-rs + QEMU, arm64, nested):**

- The isolation model works with a capability-only pod: root in the guest's own kernel, nft,
  cgroup v2, `hidepid`, sysctls, the tool user and the isolation probe.
- The fail-closed `host_boundary` probe sees cluster networking (gateway, private ranges) correctly.
- The boot-ID check tells Kata from runc.

**What it doesn't prove, per platform:**

| Platform | Unverified |
|---|---|
| **AKS Pod Sandboxing** | Kata on Azure Linux with Cloud Hypervisor/MSHV, x86. Microsoft's guest kernel and agent config: are nftables, cgroup v2 and `hidepid` available? Can a non-privileged container remount `/proc/sys`? Does it allow `SYS_ADMIN`/`NET_ADMIN`? Does `bootID` differ? Secret handling. Policy enforcement timing with Azure CNI + Cilium/Azure NPM. Overhead |
| **OpenShift sandboxed containers** | Kata/QEMU on RHCOS, bare metal or peer pods. SCC: the default `restricted-v2` forbids these capabilities, so a custom SCC is needed. Does SELinux in or around the guest block the remounts? Peer pods (a cloud VM per pod) change networking, the node boot-ID semantics and Secret delivery |
| **EKS** | Kata needs `.metal` instances (or nested-capable instance types, if offered: verify). Nothing managed; the customer runs kata-deploy. VPC CNI NetworkPolicy enforcement timing |
| **GKE** | nested-virtualization node pools only (Standard, not Autopilot); Kata via kata-deploy is unsupported by Google. gVisor (GKE Sandbox) stays excluded |
| **All** | x86_64 at all (only arm64 ran), Cloud Hypervisor, a real `lifecycle` job within normal time, `seccompProfile: RuntimeDefault` inside Kata, node rootfs/LSM differences (r3 showed AppArmor is what kept a runc pod off host sysctls) |

## 8. Recommendation and spec/ADR adjustments

**Proceed with the VM-isolated (Kata RuntimeClass) design.** Keep KubeVirt and the VM host agent as
the fallback for a platform where the one-each managed checks fail. Before ADR 0011 is accepted,
adjust the spec as follows:

1. **§4.2 capabilities:** the set is `NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL,
   CHOWN, DAC_OVERRIDE, FOWNER, FSETID` (+ `NET_BIND_SERVICE`, or a documented
   `ip_unprivileged_port_start=0` dependency). `allowPrivilegeEscalation: false` works. `privileged`
   is never needed. The admission policy pins this exact set.
2. **§4.2 VM signals:** replace "virtio devices, a hypervisor DMI vendor" with a boot-ID mismatch.
   - The `kubevm` config carries `node_boot_id` (the controller reads `Node.status.nodeInfo.bootID`
     after scheduling and writes the Secret then). The entrypoint compares it with
     `/proc/sys/kernel/random/boot_id` as the first check, with code `shared_kernel`, before any
     write.
   - Optionally also require `uname -r` ≠ `nodeInfo.kernelVersion` and a Kata cmdline marker, as
     non-authoritative extras.
   - Controller RBAC gains `get nodes`.
   - The `kubevm` profile allows a vsock device (Kata's agent uses one), unlike `microvm`.
3. **Entrypoint `kubevm` changes (P2), concretely:**
   - `hostprofile.KubeVM`;
   - `bootenv.Config.NodeBootID` (UUID, kubevm only);
   - a `Signals.BootID` read;
   - `Check`: refuse `shared_kernel` on a missing or equal boot ID;
   - a step `setup_kubevm`:
     `mount("", "/proc/sys", "", MS_REMOUNT|MS_BIND, "")` and
     `mount("", "/sys/fs/cgroup", "", MS_REMOUNT|MS_BIND|MS_NOSUID|MS_NODEV|MS_NOEXEC, "")`
     after `setup_host` and before `setup_users`;
   - `--config-file <path>`: read, validate, then `umount2(dir, 0)` of the Secret's mount, refusing
     if it is still mounted;
   - `host_boundary`: bounded retry (≤ 30 s) in `kubevm`;
   - isolation targets as for `dedicated`, minus the agent directories.

   About 70 lines prototyped (`s0/kubevm-prototype.diff`; `go vet` and the `bootenv`, `hostprofile`
   and `phaselog` tests pass). Still to do: tests, the config-file source, the retry and the README.
4. **§4.1 clock check:** the controller checks its own node with `adjtimex`. The job pod can't
   (`TIME_ERROR` always). If skew matters to the job (token expiry, deadline), the entrypoint should
   compare its clock with the platform's `Date` header at claim and refuse beyond a bound.
5. **§4.3 NetworkPolicy:** the chart documents a CNI that enforces policy before the pod runs, or
   the entrypoint retries (item 3).
6. **Appendix C and the runbook:**
   - no exec into job pods (EBUSY);
   - the RuntimeClass `overhead` is measured per platform;
   - Kata `default_memory` and resource management are tuned so the guest's `MemTotal` matches the
     job size;
   - the node keeps the Secret's tmpfs copy until pod deletion.
7. **Next S0 steps (needs real infra):** one short-lived cluster each on AKS Pod Sandboxing,
   OpenShift sandboxed containers, EKS metal and GKE nested. On each, run k1 (prototype, `no-agent`),
   k2 (runc refusal) and a `lifecycle` run with timings. Also run one bare-metal or x86 nested KVM
   host to get representative start and overhead numbers.

## 9. State left behind

- **On `kvmtest`:**
  - k3s and Kata are installed;
  - `/etc/kata-containers/configuration-qemu-s0*.toml`;
  - the `kete-fake` dummy interface;
  - the namespace `kete-s0`;
  - `/mnt/lima-colima-kvmtest/s0/` (fake binary, the prototype build, run state);
  - a Go toolchain in `/usr/local/go`;
  - the images `kete-job:kete-v0.2.5` (k3s containerd and the VM's Docker) and
    `kete-job:s0-kubevm`.
- **Restored:** the node's `user.max_user_namespaces`, changed by run r2, was set back to 31513.
- **Untouched:** the Mac's Docker context is still `colima`, and no other VM or profile was
  touched. Nothing was committed.
