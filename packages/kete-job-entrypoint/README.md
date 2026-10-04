# kete-job-entrypoint

The cloud job container's root entrypoint (kete-code-platform `docs/jobs.md` §8 items 1-2; ADRs
0018-0021). As root, it sets up the machine, guards the network with
[`kete-egress`](../kete-egress/README.md), starts [`kete-root-helper`](../kete-root-helper/README.md),
claims the job, clones the repository, runs `kete job run` as the `kete` user (its tools run as the
tool user through the helper), and reports the result, the audit log, the proxy log and a safe
change bundle. Linux-only; it ships in the job image (piece D) and never with the `kete` CLI or the
VS Code extension. Everything below is a contract: the machine configuration, the layout, the
callbacks it makes, the bundle format and `kete job run`'s job-mode behaviour.

It is the most privileged code in the job: it holds every credential and runs as root. It is kept
small, shells out only to `nft`, `git`, the helper, the proxy and `kete`, and is tested like the
helper.

The same module builds `kete-job-init` (`cmd/kete-job-init`, "kete-job-init" below): PID 1 of the
microvm and cloudvm guests of self-hosted job hosts (kete-code-platform ADR 0023). It ships in the
image and is unused on Fly.

## Building

```sh
CGO_ENABLED=0 go build -trimpath -ldflags=-s -o dist/kete-job-entrypoint ./cmd/kete-job-entrypoint
CGO_ENABLED=0 go build -trimpath -ldflags=-s -o dist/kete-job-init ./cmd/kete-job-init
```

Its own module (`go.mod` pins `go 1.26.0`, `toolchain go1.26.8`, `golang.org/x/sys v0.48.0`,
`golang.org/x/net v0.59.0`: the same pins as the helper and the proxy; bump all three together).

## Machine configuration

Four values configure a job, plus the host profile ("Host profiles"). On Fly the platform sets
them as environment variables in the machine's config (decision D3); on every other host they
arrive on a **config pipe** (`kete-job-entrypoint --config-fd <n>`), written by `kete-job-init`
(microvm, cloudvm) or the host agent (dedicated). Any other variable is ignored, except that the
boot stage notes whether one of Fly's own machine variables (`FLY_MACHINE_ID`, `FLY_ALLOC_ID`,
`FLY_APP_NAME`, `FLY_REGION`, `FLY_PRIVATE_IP`) is set: that one bit (`on_fly`, never a value)
crosses the re-exec and is a Fly signal ("Host profiles").

| Variable | Value |
|---|---|
| `KETE_JOB_ID` | the job's UUID |
| `KETE_JOB_PLATFORM_URL` | `https://<plain DNS host>`, port 443 or none, no userinfo, query, fragment or path |
| `KETE_JOB_CLAIM_TOKEN` | the single-use claim token, printable ASCII, 32-512 bytes |
| `KETE_JOB_STORAGE_HOST` | a plain DNS host: the **only** host signed upload URLs may name (`https`, port 443). The claim is refused (`invalid claim response: storage_host`) if it equals the gateway, clone or clone-API host, so no job user or clone ever reaches it |

| `KETE_JOB_HOST_PROFILE` | optional: `fly`, `microvm`, `dedicated` or `cloudvm` ("Host profiles"). Unset means `fly` when a Fly signal is present, else exit 2. Today's Fly adapter doesn't set it; it sets `fly` once an image that knows it is pinned |

**Config pipe** (`--config-fd <n>`, any fd that is a pipe; a file, socket or terminal is refused):
one JSON object, at most 4096 bytes, no other field, nothing after it:

| Field | Value |
|---|---|
| `job_id`, `platform_url`, `claim_token`, `storage_host` | the four values above, validated the same way |
| `host_profile` | `microvm`, `dedicated` or `cloudvm` (`fly` takes its values from the environment only) |
| `host_provider` | cloudvm only, required: `gcp`, `digitalocean`, `hetzner` or `oci` |
| `host_generation` | dedicated only, required: the host's reset generation, 1-64 of `[A-Za-z0-9._-]`, starting with a letter or digit |

With the pipe, none of the four `KETE_JOB_*` variables may also be set, and `KETE_JOB_HOST_PROFILE`,
if set (the dedicated agent sets it), must equal `host_profile`. The microvm config disk carries
the same object after the line `kete-job-config v1` ("kete-job-init"); cloudvm user data is the
object itself. This is the shape the host-agent contract (program phase P2.0) adopts.

The boot stage validates them, writes them to a pipe and re-executes itself (`/proc/self/exe __run
<fd>`) with only `PATH` in its environment: `unsetenv` can't clear the kernel's copy of the initial
environment (`/proc/<pid>/environ`), `execve` can. From then on the claim token lives only in
memory until `claim` returns. Every process the entrypoint starts gets an explicit environment,
never an inherited one. An invalid configuration exits 2 with no callback.

## Layout

Fixed paths (`internal/layout`); the image creates none of the directories at build time. Every
directory is created through fds opened `O_NOFOLLOW`; a pre-existing one with the wrong type or
owner aborts.

| Path | Owner / mode | Holds |
|---|---|---|
| `/run/kete-job/` | root 0700 | `egress.json` (the first proxy configuration) |
| `/run/kete-egress/ca.pem` | root 0644 | the running proxy instance's CA (egress README "Clients") |
| `/run/kete-helper/helper.sock` | dir root 0755; socket kete 0600 | the helper's socket |
| `/var/lib/kete-root/` | root 0700 | `pristine.git`, `home/` (root's git HOME), `tmp/` (bundle and index) |
| `/var/log/kete-job/` | root 0700 | `proxy.jsonl` (the request log), `proxy.stderr`, `helper.stderr`, `kete.stdout`, `kete.stderr`, `kete.audit.jsonl` (0600, the copy of kete's audit pipe) |
| `/var/lib/kete-job/kete/` | kete 0700 | kete's `HOME`, XDG directories, `tmp/`, `spec.json` (0600) |
| `/var/lib/kete-job/tool/` | tool 0700 | the tool user's `HOME` and `tmp/` |
| `/srv/kete-job/work/` | root:kete-job 2750 | the worktree parent (the helper's `--worktree-root`) |
| `/srv/kete-job/work/repo/` | tool:kete-job, dirs 2775, files g+w | the agent's working copy, where `kete job run` runs |

Users (created by the image, verified at boot): `kete`, `kete-tool` and `kete-proxy`, all with
their own primary groups, and the group `kete-job` with exactly `kete` and `kete-tool` as members.
`kete-proxy` has no supplementary group. Binaries: `/usr/local/bin/kete`, and
`/usr/local/libexec/kete/{kete-job-entrypoint,kete-root-helper,kete-egress}`.

Cgroups (R = the entrypoint's own cgroup at start): every process already in R moves to
`R/kete-job-init`; `R/kete-job/system` holds the entrypoint, the proxy and the helper;
`R/kete-job/kete` holds `kete` (`memory.max` 25% of `MemTotal`, `pids.max` 512);
`R/kete-job/tool` is the helper's `--tool-cgroup` (`memory.max` 60%, `pids.max` 4096).

## Steps

Phase lines on stdout are JSON, `{"ts","step","event":"start|ok|failed|note|exit","code"?,"class"?,"errno"?,"exit_code"?}`,
with fixed step names and codes only: never a message from git, `kete`, the platform, or a
credential. A `failed` line with an error carries its fixed `class` and a number, never its text:
`errno` (the errno), `http` (the status), `git` and `exit` (the exit code), `launch_<code>` (a
launch stage-2 failure, plus its errno), `timeout`, `cancelled`, or `other`.

1. **Boot:** the re-exec above; not dumpable; `oom_score_adj` −1000; umask 022; SIGTERM or SIGINT
   aborts the job (the same kill as the hard deadline, phase line `abort`/`signal`, exit 1) and
   never reaches a job process. Then **`setup_host`**: the host profile against the machine's
   signals ("Host profiles"); a mismatch exits 1 **before claim**.
2. **Machine:** the users; `fs.protected_hardlinks` = `fs.protected_symlinks` = 1 and
   `user.max_user_namespaces` = 0 (written and read back); `/proc` remounted `hidepid=2`; on Fly
   the **Fly guard** (below: `/.fly` root 0700 and `/.fly/api` root 0600, failing closed on Fly
   when they're missing, then checked as the tool user), on every other profile the
   **host-boundary probe** (step `host_boundary`, below, as root before any in-guest rule); the
   layout; the cgroups.
3. **Network guard:** the ruleset from `kete-egress nft` applied with `nft -f -` and checked;
   ports 81 (kete), 82 (tool), 83 (root) bound and the request log opened once, then kept across
   proxy instances; the proxy started as `kete-proxy` (no groups, `no_new_privs`, −1000, cgroup
   `system`, an empty environment). The resolvers are `/etc/resolv.conf`'s nameservers (a loopback
   one is refused). Any failure exits 1 **before claim**.
4. **Helper:** started as root (−1000, umask 002, cgroup `system`) with `--kete-uid kete`,
   `--tool-uid kete-tool`, `--tool-gid kete-job` (so the tool user can enter the 2750 worktree
   parent), `--worktree-root /srv/kete-job/work`, `--tool-cgroup R/kete-job/tool`, `--env-allow`
   (terminal and pager names only, never `KETE_*`) and `--env-set` (the tool user's environment,
   below). Its socket must appear (owner kete, 0600) within 10 s, else exit 1 **before claim**.
   Then the **isolation check** (below), as the tool user; any failure exits 1 **before claim**.
5. **Claim** through port R, trusting only the proxy's CA. Retried (≤ 5 tries in 2 minutes) only
   while no byte of the request was written: a second claim fails the job. Every field of the
   response is validated (below). An invalid response with a usable callback token reports
   `error` "invalid claim response: <field>"; without one, exit 1. The claim's `deadline` is the
   **hard deadline** of every later step.
6. **Proxy instance 2** (decision D2: hosts arrive after the proxy has to run, and config v1 can't
   change them, so the proxy is restarted between phases, only while no job-user process exists,
   with the same listeners and log): clone root → platform, clone host, its API host; agent kete →
   gateway, platform; agent tool → the built-in registry hosts (D7); agent and report root →
   platform.
7. **Clone** (proxy phase `clone`, an `events {phase:"clone"}` first): `git clone --bare
   --depth=1 --single-branch --no-tags --branch <ref>` into `/var/lib/kete-root/pristine.git`, the
   token only in an `http.extraHeader` (never in the URL, argv or on disk); then `refs/heads/<ref>`
   must equal `base_sha` (SHA-1, no alternates, no other shallow boundary), else `refused` (2);
   then the token is revoked (`DELETE https://api.github.com/installation/token`, or
   `https://<host>/api/v3/installation/token` for any other host; a failure is an events message,
   D8) and dropped; then the agent copy (`git clone --no-hardlinks --no-checkout`, branch
   `spec.branch` at `base_sha`, no remote), handed to the tool user and the job group.
8. **Agent** (proxy phase `agent`): effective timeout = floor(min(`policy.timeout`, (deadline −
   now − 5 min) / 1 min)); below 1 → `deadline` (1) without starting `kete`. The claim's spec, with
   `policy.timeout` replaced by that value, is written to `spec.json`; `kete job run --json
   spec.json` starts as `kete` (groups `[kete-job]`, `no_new_privs`, `oom_score_adj` 0, umask 002,
   cgroup `kete`, cwd the working copy), stdout and stderr to root-owned files. The first `agent`
   event carries `effective_timeout_minutes`; heartbeats (`events`, every 30 s from claim to
   `done`) carry `kete_cgroup_extra` in the agent phase (processes in the `kete` cgroup that aren't
   `/usr/local/bin/kete`). Supervised: `kete`'s exit ends the phase; an unplanned proxy exit →
   `proxy_failed`; a helper exit → an events message; at effective timeout + 3 min, SIGTERM, then
   `cgroup.kill` 10 s later → `time_limit` (3) if `kete` wrote no result.
9. **Report:** proxy phase `report`; the helper SIGTERMed; `cgroup.kill` on both job cgroups until
   both are empty and no process has any uid of `kete` or the tool user (≤ 30 s), else
   `processes_alive`: then the proxy is **not** restarted (D2: only with no job process alive),
   `result`, the events and `finish {push_error:"processes_alive"}` go through the instance already
   in the report phase (root → platform only) and nothing is uploaded; with no such instance (the
   proxy died too), nothing is reported and the entrypoint exits 1 (the sweeper marks it lost). `result` sends `kete`'s stdout result verbatim (the whole trimmed output, or
   its last line, that is a v1 object), else `error` with `kete`'s exit code. Then `events
   {report}`, the bundle (below), `uploads`, **proxy instance 3** (report root → platform and the
   upload host), the PUTs (the audit log, the bundle, a snapshot of the proxy log), `events
   {done}`, `finish`, then the proxy is closed. Exit 0, or 1 if `result` or `finish` wasn't
   accepted.

**Any 404 from a callback** (cancelled, timed out or terminal): kill everything, no more callbacks,
exit 0. **The hard deadline:** SIGKILL the helper first (so it starts nothing more), then
`cgroup.kill` both job cgroups (ADR 0021 rule 5's order), close the proxy, exit 1, no more
callbacks. **Proxy failure** after claim: kill, restart the proxy straight into
`report`, `result {proxy_failed}`, uploads without a bundle, `finish {push_error:"proxy_failed"}`.

Phase codes added by the Fly guard and the isolation check: `setup_fly` failed `missing`,
`fly_api`, `control` or `probe`; `isolation` failed with any code of the table above.

Outcomes the entrypoint reports itself (result v1): `error` (1), `refused` (2, clone at the wrong
commit), `deadline` (1), `proxy_failed` (1), `time_limit` (3). `push_error`: `processes_alive`,
`symlink`, `unreadable`, `proxy_failed` (an over-limit bundle is `unreadable` until the platform
adds a value for it, D10).

### Host profiles

Jobs run on Fly Machines or on self-hosted hosts (kete-code-platform ADR 0023 rule 16). The host
profile says which, which signals the machine must and must not show, and which guard proves the
host's own control surfaces are out of the job's reach. Step `setup_host` checks the signals
(`internal/hostprofile`); every refusal is before claim, with a fixed code.

| Profile | Host | Must be present | Must be absent | Values from | Guard (before claim) |
|---|---|---|---|---|---|
| `fly` | Fly Machines | a Fly variable or `/.fly` (`missing`) | — | environment (`source`) | the Fly guard (below), the isolation check with Fly's probes |
| `microvm` | host agent, firecracker driver | PID 1 is `/usr/local/libexec/kete/kete-job-init` (`init`) | Fly signals (`fly_signals`), a virtio vsock device (`vsock`) | config pipe from init (`source`), read from the config disk | host-boundary probe; the config disk gone (`config_disk`) |
| `dedicated` | host agent, dedicated driver | a reset generation (`generation`) | Fly signals | config pipe from the agent | host-boundary probe |
| `cloudvm` | a provider VM per job | PID 1 is kete-job-init; the firmware (DMI) names `host_provider` (`dmi`: gcp `product_name` "Google Compute Engine", digitalocean and hetzner `sys_vendor` "DigitalOcean"/"Hetzner", oci `chassis_asset_tag` "OracleCloud.com") | Fly signals | config pipe from init, read from the provider's user data | init's metadata drop present (`metadata_drop`); host-boundary probe |

Fail closed: Fly signals with any other profile is `fly_signals`; an unknown profile exits 2 at
boot; unset is `fly` only with a Fly signal, else exit 2. The four values, their validation, the
claim and every later step are the same in every profile.

**Host-boundary probe** (step `host_boundary`, every profile but `fly`). As root, before the
network guard installs the in-guest rules, so it proves the host's own isolation (the host
agent's table, the provider's network) independently of the guest's: the probe (the isolation
check's code run in-process, with a root TCP control on loopback) must reach nothing among the
IPv4 default gateways (`/proc/net/route`) on TCP 22, 25, 53, 80, 111, 443, 2375, 2376, 3000, 4280,
5000, 6443, 8000, 8080, 8443, 9100, 10250 and DNS 53 (`gateway`); `169.254.169.254` on 80, 443 and
DNS 53, `169.254.169.253:53`, `[fd00:ec2::254]:80`, `[fd20:ce::254]:80` (`metadata`); RFC 1918,
CGNAT and ULA samples (`10.0.0.1`, `10.0.0.2`, `10.128.0.1`, `10.255.255.254`, `172.16.0.1`,
`172.17.0.1`, `172.31.1.1`, `192.168.0.1`, `192.168.1.1`, `100.64.0.1`, `100.100.100.100`,
`fd00::1`) on 22, 53, 80, 443 (`private_range`); and public IPv6 addresses
(`[2606:4700:4700::1111]:443`, `[2001:4860:4860::8888]:443`, `ipv6`). Before the probe, no block
device may start with the config disk's header (`config_disk`: init must have removed it) and, on
cloudvm, `nft -j list table inet kete_job_init` must show exactly init's chain and drop rules
(`metadata_drop`; a table that exists but was emptied or given an `accept` is refused). With no
IPv4 default gateway at all the step fails `probe` (nothing to prove, and no egress). A probe that can't
run is `probe`.

**Isolation check per profile.** `fly` probes exactly the list below. Every other profile drops
Fly's socket, `[fdaa::3]` and the `fdaa::/16` probes, and adds, as the tool user, the
host-boundary targets above, every block device node (open for reading: `guarded_path`), and on
dedicated the host agent's `/var/lib/kete-job-host` and `/etc/kete-job-host` (`guarded_path`).

### Fly guard and isolation check

The tool user runs whatever the model asks for, so before the claim the entrypoint makes sure, as
that user, that nothing outside the job is reachable. Unix sockets bypass the firewall, and Fly's
machine API socket (`/.fly/api`, the Machines API authenticated as the machine) could otherwise
delete or exec into other machines of the shared jobs app.

**Fly guard** (step `setup_fly`, profile `fly` only). "On Fly" means one of Fly's machine variables was set at boot,
or `/.fly` exists. On Fly, `/.fly` must be a directory (not a symlink) holding a socket `api`;
anything missing fails the step with code `missing` (fail closed: the socket could be somewhere the
guard doesn't cover). The directory becomes root 0700 and the socket root 0600, both read back.
Off Fly (no variable, no directory) the lock is a no-op. Then the probe below runs with only Fly's
socket and the control: a reachable socket is code `fly_api`. `/.fly/api` is the only API socket
Fly documents (`setup.FlyAPISockets`); one anywhere else is caught by the isolation check's sweep.

**Isolation check** (step `isolation`, after the helper, before claim). The entrypoint launches
itself (`__isolation_probe`) as the tool user the way the helper runs a tool (uid `kete-tool`, gid
`kete-job`, no supplementary groups, `no_new_privs`, a leaf `isolation` of the tool cgroup, only
`PATH` in its environment) with a list of probes on fd 3, and reads one code back on stdout. (The
Fly guard's probe is the same, except that it runs before the cgroups exist, in the entrypoint's
own.) The probe
tries, each attempt bounded by 300 ms, 64 at a time, all of them by 10 s (the whole launch by 20 s,
`ProbeTimeout`), and reports the first failing reason in this order:

| Code | Reachable by the tool user |
|---|---|
| `control` | (inverted) a positive control failed, so the probe proves nothing: a root TCP listener on an unprivileged loopback port, a root abstract unix listener, and opening `/` must all succeed (the DNS probe has no control: a silent resolver looks like a refusal) |
| `fly_api` | `/.fly/api` |
| `helper_socket` | the helper's socket |
| `unix_socket` | any other listening unix socket (stream or seqpacket) in `/proc/net/unix`, by path or `@abstract` name |
| `kete_dir` | `kete`'s home or `TMPDIR` (its server socket's parent) opens for reading |
| `guarded_path` | (off Fly) a block device node, or the dedicated agent's directories, opens for reading |
| `metadata` | `169.254.169.254` ports 80, 443 (off Fly also the host-boundary metadata targets) |
| `sixpn` | (fly) Fly's private network: `[fdaa::3]` ports 80, 443, 4280, and every one of the machine's own `fdaa::/16` addresses on ports 1-1023 and 4280 |
| `gateway`, `private_range`, `ipv6` | (off Fly) the host-boundary probe's targets |
| `resolver` | a resolver over TCP or UDP (a DNS reply comes back): `resolv.conf`'s nameservers and (fly) `[fdaa::3]:53` |
| `loopback` | `127.0.0.1` or `::1`, TCP ports 1-1023 except port B (82) |
| `probe` | the probe didn't launch, finish in time, exit 0 or answer with a known code (a `class` and number on the phase line say why) |

An attempt counts as reaching its target when it connects (or, for a resolver, gets a datagram
back; for a unix socket, also `EAGAIN`: the kernel checks permission before the backlog); a
refusal, a timeout or another error passes, except that resource errors (`EMFILE`, `ENFILE`,
`ENOBUFS`, `ENOMEM`) and an attempt cut off by the 10 s budget make the answer `probe`: an
incomplete check never passes. The check is a snapshot taken before claim: the socket list is
read just before the probe runs, and the tool user's firewall rules don't change after it (later
proxy restarts change only the proxy's host allowlists). The probe is a sample: the structural
guarantees are the nft ruleset (checked when applied), the file modes and the Fly guard; the check
catches a guard that didn't take on the real machine, a socket in an unexpected place, and
regressions. It takes well under a second when the firewall rejects (every refusal in the ruleset
is a reject).

### Claim response checks

`callback_token` printable; `platform_url` equal to the machine configuration's; `deadline` RFC 3339
in the future; `gateway_key` printable; `gateway_url` and `clone.url` `https://` with a plain DNS
host and port 443; `clone.ref` a branch name; `clone.base_sha` 40 lowercase hex; `spec` an object
with `version` 1, an integer `policy.timeout` ≥ 1, and a `branch` (also checked with `git
check-ref-format --branch`).

### Environments

- **`kete`** (port A): `HOME`, `XDG_{CONFIG,DATA,CACHE,STATE}_HOME`, `TMPDIR` under
  `/var/lib/kete-job/kete`; `PATH=/usr/local/bin:/usr/bin:/bin`; `LANG=C.UTF-8`;
  `HTTPS_PROXY`/`https_proxy=http://127.0.0.1:81` (no `HTTP_PROXY` or `NO_PROXY`);
  `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` = the CA; `KETE_JOB_MODE=1`,
  `KETE_JOB_TOOL_SOCKET`, `KETE_JOB_MAX_OUTPUT_TOKENS=32000` (D14), `KETE_RUNTIME_TYPE=kete_cloud`,
  `KETE_GATEWAY_URL`, `KETE_PLATFORM_URL`, `KETE_JOB_GATEWAY_KEY_FD=3` (the gateway key is on
  that descriptor, never in the environment), `KETE_JOB_AUDIT_FD=4` (the audit pipe's write end;
  kete writes its audit log only there), `KETE_DISABLE_MODELS_FETCH=1` (port A never allows
  the models.dev catalog host, so `kete serve` doesn't try; a job's model catalog is the binary's
  bundled snapshot, so a model newer than that snapshot can't run in a job). `kete`'s own server is a unix socket in a 0700
  directory under its `TMPDIR`, so the firewall needs no exception for it.
- **Tool user** (port B, the helper's `--env-set`): `HOME`, `TMPDIR` under
  `/var/lib/kete-job/tool`; `PATH`; `LANG`; `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`,
  `http_proxy` = `http://127.0.0.1:82`; `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`,
  `NPM_CONFIG_CAFILE`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`,
  `CURL_CA_BUNDLE` = the CA; `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`,
  `NPM_CONFIG_UPDATE_NOTIFIER=false`, `PIP_DISABLE_PIP_VERSION_CHECK=1`, `UV_NATIVE_TLS=1`.
- **Root** (port R): git through `http.proxy` and `http.sslCAInfo`; the Go client through an
  explicit proxy and a pool holding only the CA. The job CA never enters the system store.

### Hardened git

Every root git call: `/usr/bin/git` with an environment built from scratch (`PATH=/usr/bin:/bin`,
root's own `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`,
`GIT_TERMINAL_PROMPT=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_LFS_SKIP_SMUDGE=1`,
`GIT_PROTOCOL_FROM_USER=0`, `LC_ALL=C`) and `GIT_CONFIG_*` = `core.hooksPath=/dev/null`,
`core.fsmonitor=false`, `core.untrackedCache=false`, `core.quotePath=false`, `protocol.allow=never`,
`protocol.https.allow=always` (plus `protocol.file.allow=always` for the agent copy only),
`submodule.recurse=false`, `http.proxy`, `http.sslCAInfo`, and for the clone only
`http.extraHeader`. `GIT_INDEX_FILE` is set only for the bundle's listing (a fresh file); the agent
copy uses its own index. A timeout per call (10 min for the clone, 60 s otherwise), killed as a
process group; stdout ≤ 64 MiB, stderr ≤ 64 KiB, and stderr reaches a message only scrubbed of the
token and any `Authorization` line, cut to 300 bytes.

### Credentials

| Credential | Arrives | Lives | Never |
|---|---|---|---|
| Claim token | the boot environment | the handover pipe → memory until `claim` returns | a child's environment, a file, argv, a log |
| Callback token | `claim` | memory (a Bearer header per request) | `kete`, the tool user, files, logs, argv |
| Clone token | `claim` | memory → the clone's `GIT_CONFIG_VALUE_n` (root-only: `hidepid`, ptrace) → dropped after the revoke | disk, a URL, argv, logs, `kete` |
| Gateway key | `claim` | memory → a pipe that is `kete`'s fd 3 (`KETE_JOB_GATEWAY_KEY_FD=3`; `kete` reads it once and closes it, then holds it in memory and hands it to its server child the same way; both are non-dumpable) | any environment (`kete`'s included), the tool user, the helper, files, argv |
| Signed URLs | `uploads` | memory | logs (a failed PUT never reports its URL) |

## Bundle

Built only after every job process is gone (ADR 0021 rules 5-6), and still written as if something
could race it:

1. Anchor: `/srv/kete-job/work` opened one component at a time with `O_PATH|O_NOFOLLOW` and
   checked root-owned and not group- or other-writable; then `repo` beneath it (a symlink →
   `symlink`).
2. List with git against the pristine git-dir only (`--git-dir=pristine.git --work-tree=repo`,
   a fresh `GIT_INDEX_FILE`): `read-tree <base_sha>`, `ls-tree -r -z -l --full-tree <base_sha>`,
   `ls-files -z --others --exclude-standard`. Git never reads the agent's `.git`, hooks or
   fsmonitor. A nested repository (`dir/`) is skipped and named in an events message (D9). FIFOs,
   sockets and devices are invisible to `ls-files` and so never bundled; one in place of a tracked
   file is refused.
3. Paths: valid UTF-8, no NUL or other control character, no backslash, relative, no empty, `.`
   or `..` component, ≤ 4,096 bytes with components ≤ 255, else `unreadable`.
4. Open: every directory component `O_PATH|O_DIRECTORY|O_NOFOLLOW`, the leaf
   `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` then `fstat`: a symlink anywhere → `symlink`; not a regular
   file → `unreadable`; a missing tracked path (or a non-directory where its parent was) → a
   deletion.
5. Per base entry: a regular file whose size, blob hash and mode (`S_IXUSR` → `100755`) match is
   unchanged and skipped (large unchanged files are hashed in full as a stream that checks the
   deadline on every read, never loaded); a base symlink
   must still be a symlink with the same target, anything else (a deletion included) →
   `symlink`; gitlinks are skipped. Untracked files are always included.
6. Limits, all decimal and so conservative whichever way the platform reads "MB": a file >
   1,000,000 bytes, a binary file (a NUL in the first 8,000 bytes) > 256,000 bytes, more than 50
   binary files, more than 1,000 entries, more than 20,000,000 bytes of tar or 10,000,000 bytes of
   gzip → `unreadable`, plus an events message naming the limit. Upload caps use the same
   convention (audit 20,000,000, proxy log 10,000,000).
7. Format: one gzip member (`BestCompression`) of a tar whose first entry is `manifest.json`, a
   JSON array sorted by path bytes of `{"path","mode"}` or `{"path","deleted":true}` (D11), then
   `files/<path>` per non-deleted entry in manifest order. Every header: a regular file, mode 0644,
   uid/gid 0, no user or group names, mtime 0, USTAR when the name fits, else PAX with only a
   `path` record. No changes → an empty array, still uploaded (D12).

The audit log uploaded is what `kete` wrote to its audit pipe (piece A3): `StartKete` creates a
pipe, passes the write end as `kete`'s fd 4 (`KETE_JOB_AUDIT_FD=4`) and closes its own copy once
`kete` has it, and a reader goroutine copies the read end into `/var/log/kete-job/kete.audit.jsonl`
(root 0600). `kete` can only append to it, never seek, truncate or rewrite what it sent; nothing in
`kete`'s data dir is read. Past 20,000,000 bytes the reader stops and closes the pipe, so `kete`'s
next write fails (EPIPE) and it interrupts the run. After the agents are reaped, the upload step
waits up to 10 s for the reader (EOF once every `kete` process is gone) and opens the file
`O_NOFOLLOW`: empty (`kete` refused before any session) → no upload, events message "audit log not
uploaded: empty"; over the limit → "… too large"; a reader that didn't finish → "… reader stuck";
missing → "… missing or refused". Uploads are `PUT` (D15): `application/x-ndjson` for the logs,
`application/gzip` for the bundle; the proxy log upload is a snapshot of its size when the upload
starts.

## kete-job-init

`/usr/local/libexec/kete/kete-job-init` (`cmd/kete-job-init`, `internal/guestinit`) is PID 1 of a
microvm or cloudvm guest (ADR 0023 rule 15); no systemd, SSH server, cloud-init or provider guest
agent runs in the guest. It refuses to run as anything but PID 1 (exit 2). Phase lines only on the
console (steps `init_mount`, `init_root`, `init_network`, `init_config`, `init_metadata_drop`,
`init_entrypoint` with the entrypoint's `exit_code`, `init_poweroff`); never a value.

1. **Stage 1** (the read-only image root): mount `/proc`, `/sys`, `/dev` (devtmpfs) unless already
   there, make the root mount private, make `/dev/console` its stdio if the kernel couldn't. When a
   block device or partition (`/sys/class/block`) holds an ext4 file system labelled `kete-scratch`
   (the host agent's per-job scratch disk; partition 4 of a cloudvm image's disk), mount it, overlay the image root with it as the upper layer, move `/proc`, `/sys`, `/dev`
   in, `pivot_root` and re-execute itself as `kete-job-init __guest` from the overlay (so PID 1's
   executable is the path the entrypoint checks). Two scratch disks are refused.
2. **Mounts**: `cgroup2` at `/sys/fs/cgroup`, `/run` and `/dev/shm` tmpfs.
3. **Network**: `lo` up, then the uplink (addresses aren't secret; the kernel command line never
   carries a credential):
   - **microvm**: the kernel's own `ip=` configuration (static, from the host agent's boot
     arguments); `/etc/resolv.conf` from `/proc/net/pnp` (the `ip=` dns0/dns1) without link-local,
     loopback or unspecified resolvers; none left fails.
   - **cloudvm** (the image's command line carries `kete.net=dhcp kete.dns=<ip>[,<ip>]`,
     `ParseCmdline`): init's own DHCPv4 client (`internal/dhcp`), because the kernel's `ip=dhcp`
     refuses a gateway outside the leased subnet, and GCP (a /32 with option 121 classless routes)
     and Hetzner (a /32 with the off-link router 172.31.1.1) lease exactly that. The client needs
     exactly one Ethernet interface, brings it up, waits up to 10 s for carrier, runs
     DISCOVER/OFFER/REQUEST/ACK over a packet socket (4 s per reply, 4 attempts, 45 s overall,
     broadcast replies requested), and accepts only a strictly valid ACK from the offering server
     (same server id, required in both) for the offered address: an address and next hops outside
     0/8, 127/8, 224/4, 240/4 and link-local, a router or next hop that isn't the leased address,
     classless-route destinations overlapping none of 0/8 (except the default route), 127/8, 224/4,
     240/4, a contiguous mask, no option overload; an MTU outside 576-9216 is ignored. It sets the MTU, adds the address and
     installs option 121's routes (RFC 3442: they replace option 3) or an on-link host route to an
     off-link router plus the default route through it, over netlink. The lease is never renewed
     (every supported provider binds the address to the VM; a job lives at most its deadline).
     `/etc/resolv.conf` lists `kete.dns`, which must be one or two public IPv4 addresses (not 0/8,
     private, CGNAT, loopback, link-local, multicast or 240/4)
     (the provider's resolver is the metadata address, dropped below).
   Either way init then waits up to 20 s for an interface with an IPv4 address and a default
   route.
4. **Configuration**, read once as root:
   - **microvm** (a block device starts with `kete-job-config v1\n`): read at most 64 KiB; after
     the header one JSON object (the config pipe's, `host_profile` `microvm`) ending at the first
     NUL byte, then only NUL bytes; anything else is refused (bad header, oversize, bad JSON, an
     unknown field, a wrong type, data after it). Then the device's driver is unbound (the block
     device and its node leave the guest; the agent also unlinks the backing file) and its absence
     confirmed.
   - **cloudvm** (no config disk): the provider from the firmware (the DMI table above), its user
     data fetched once (`http://169.254.169.254`, no proxy, no redirect, 5 s per attempt, 3
     attempts on 5xx or network errors, at most 4096 bytes): gcp
     `/computeMetadata/v1/instance/attributes/user-data` with `Metadata-Flavor: Google` (and the
     same header required back), digitalocean `/metadata/v1/user-data`, hetzner
     `/hetzner/v1/userdata`, oci `/opc/v2/instance/metadata/user_data` with
     `Authorization: Bearer Oracle` (base64). It must be the config object with `host_profile`
     `cloudvm` and `host_provider` equal to the firmware's. Then the **metadata drop**: table
     `inet kete_job_init` (`hook output priority -150`: drop `169.254.0.0/16`,
     `fd00:ec2::254`, `fd20:ce::254` for every user, root included) applied with `nft -f -`, listed
     back as JSON and checked to hold exactly those rules and that chain (`hostprofile.VerifyMetadataDrop`),
     and `169.254.169.254:80` confirmed unreachable, all before the entrypoint starts. The
     entrypoint's own ruleset (`inet kete_egress`) never touches this table.
5. **Entrypoint**: `kete-job-entrypoint --config-fd 3` with only `PATH`, stdin `/dev/null`,
   stdout and stderr on the console, the config on a pipe (init's copy is cleared). SIGTERM and
   SIGINT (ctrl-alt-del is turned into SIGINT) are forwarded to it; every child, orphans included,
   is reaped.
6. **Panics**: both stages and `Run` recover a panic and power off (never a live machine with a
   dead PID 1, never the entrypoint after an unfinished step). A panic in another goroutine still
   kills PID 1, so **the guest kernel command line must carry `panic=1`** (a host-agent/P4
   requirement, and the cloudvm images' — `packages/kete-job-image/packer`): the kernel then
   reboots, which ends a Firecracker VM; on a cloud VM the second boot finds the overlay's
   directories already on `kete-scratch`, so stage 1 fails and powers off (and the claim token is
   single-use anyway).
7. **End**: on the entrypoint's exit or any earlier failure: kill everything, reap, `sync`, then
   reboot on a microvm (Firecracker treats a guest reboot as the VM exiting) or power off on a
   cloudvm and on any failure before the mode is known (a cloud VM never boot-loops). The
   entrypoint never starts unless every step before it succeeded.

## Launching

Go can join a cgroup at clone time but can't set `oom_score_adj`, umask or `no_new_privs` for a
child, so each launch re-executes the entrypoint as a short stage 2 (`__launch <n>`, dispatched
before anything else in `main`): it writes `oom_score_adj`, sets the umask, `setgroups`/`setgid`/
`setuid` (verified with `getres[ug]id`), `PR_SET_NO_NEW_PRIVS`, `chdir`, marks every fd from 3+n
close-on-exec (`close_range`) and `execve`s the target. Fds 3..3+n-1 pass through (the proxy's
3-7; `kete`'s gateway-key pipe, fd 3, and its audit pipe, fd 4). A failure before the `execve` is reported on a status pipe
and fails the launch.

## How to test

No Go toolchain is needed on macOS; every command runs in the official `golang` image (Colima:
`docker info --format '{{.CgroupVersion}}'` must print `2`).

```sh
# Unit tests: gofmt, vet (also with the integration tag), tests with the race detector.
docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm \
  sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'

# Integration suite: root, the real helper and proxy, real users, cgroups, nftables and /proc
# remount, the in-process fake platform and a fake kete. Needs a privileged container.
docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" \
  -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh
# Append a Go test flag for a subset, e.g.:
#   bash scripts/integration.sh -test.run TestLifecycle
```

`scripts/integration.sh` builds the helper, the proxy, the entrypoint and `internal/itest/fakekete`,
installs them at the image's paths, creates the users as the image does, points
`/etc/resolv.conf` at the fake DNS, and runs the tests in a fresh network namespace with the fake
platform on `198.51.100.10` and its DNS on `198.51.100.53`. It restores
`user.max_user_namespaces` on exit (a host-wide value in Colima's VM). CI:
`.github/workflows/kete-job-entrypoint.yml`.

The integration tests: `TestLifecycle` (AC1 with the fake `kete`: a tool call through the real
helper as the tool user, an edit, the bundle holds exactly that edit), `TestRefuseClaimWithout
{Firewall,Proxy,Helper}`, `TestCloneWrongCommit`, `TestProcessesAlive`, `TestProxyFailed`,
`TestHardDeadline`, `TestCancelled`, `TestDeadlineTooShort`, `TestBundleRefusals`,
`TestCredentials` (a 10 ms `/proc` poller over every cmdline and non-root environment, then a
search of the disk, the logs and stdout for the tokens), `TestBinaryBoot` (the built binary: no
claim token in its environment after the re-exec, and a complete job), and the Fly guard and
isolation check: `TestIsolationProbeDetects` (the real probe as the tool user with no firewall
against a privileged loopback listener, an open directory, a world-connectable socket by path and
by abstract name, the fake DNS, and a dead control: each its own code), `TestFlyGuardMissingAPISocket`
(on Fly without `/.fly`, and a `/.fly` without `api`: `missing`, no claim), `TestFlyGuardLocks` (a
world-open fake `/.fly/api` is reachable before the guard, root 0700/0600 after it, and the job
runs), `TestIsolationStraySocket` (the review finding: a world-connectable socket elsewhere, by
path or abstract name: `unix_socket`, no claim), `TestIsolationReadableKeteDir`,
`TestIsolationFirewallRefuses` (root listeners on `127.0.0.1:700` and `[::1]:700` are refused once
the firewall is up) and `TestBinaryBootOnFly` (the binary with `FLY_MACHINE_ID` and no `/.fly`).
`TestBinaryBoot` runs the binary on the environment path with a world-open `/.fly/api` (unset
profile + a Fly signal = `fly`). Host profiles (`itest/profiles_test.go`): `TestProfileMismatch`
(each contradicting signal: `fly_signals`, `missing`, `init`, `vsock`, `dmi`, `source`,
`generation`; no claim), `TestHostBoundaryMicrovm` (a reachable gateway port, RFC 1918, CGNAT,
metadata and IPv6 sample and a present config disk each refused at `host_boundary`; with nothing
reachable the job runs), `TestCloudvmMetadataDrop` (without init's table `metadata_drop`; with it,
applied by `guestinit.ApplyMetadataDrop`, a local `169.254.169.254:80` listener is dropped for root
and the job runs), `TestBinaryBootDedicated` (the binary with `KETE_JOB_HOST_PROFILE=dedicated`
and the config on fd 3 runs a whole job), `TestBinaryBootDedicatedStdin` (the same with the
config on fd 0, as `docker run -i` delivers it) and `TestBinaryBootRefusals` (exit 2 and no claim: no
profile and no Fly signal, an unknown profile, dedicated from the environment, the config in a
file, the values in both places, a profile mismatch, no generation, fly from a pipe). In-process
runs that name no profile get the one the boot stage would resolve: `fly` with a Fly signal, else
`dedicated` (the suite's netns has no host route, so the host-boundary probe reaches nothing).
`kete-job-init`'s units (`internal/guestinit`): config-disk parsing, each provider's user-data
reader against a fake metadata server, the order of `Run` (metadata drop before the entrypoint,
nothing started after a failure, reboot/power-off on exit) and reaping as a subreaper.

The same fake platform also runs as a container (`cmd/kete-job-fake-platform`) for the image's
end-to-end test with the real `kete`: it adds the platform's sync, skill-file, models and `me`
routes (Bearer = the job's gateway key), a scripted fake gateway (`/anthropic/v1/messages`, which
checks `x-api-key` and the `x-kete-agent-id`/`x-kete-agent-version` headers), and forwards DNS
outside `*.kete.test` to its own resolver so the AC5 package installs reach the real registries.
`internal/e2e` (build tag `e2e`) asserts the recorded state; see `packages/kete-job-image/README.md`.

## Not verified without a real host

The microvm path ran on Firecracker in P4 (`kete-job-host` KVM tests). The cloudvm path ran under
QEMU only (P7, `packages/kete-job-image/packer/test/boot-test.sh`: firmware, GRUB, the cloudvm
kernel, stage 1 on the disk's partitions, the DHCP client against provider-shaped dnsmasq leases,
DMI, a fake metadata service, the metadata drop, the entrypoint's `setup_host`). Still unverified
until a real VM per provider (kete-code-platform runbook `cloud-jobs-staging.md` R0-R2): each
provider's real DMI fields, user-data endpoint and DHCP server (GCP, DigitalOcean — whether its
Droplets answer DHCP at all without cloud-init's metadata network configuration — Hetzner, OCI),
and whether a provider's gateway answers a host-boundary sample port.

## Not verified without a real Fly machine

Whether Fly's guest kernel has `nf_tables` inet with the needed features, and IPv6 egress; the
resolver address (`fdaa::3`) and NAT64; whether `/proc` can be remounted with `hidepid`; the cgroup
v2 mount and delegation in the guest, and whether Fly's init owns the root cgroup; `/.fly/api`'s
real path and permissions, and whether Fly exposes any other socket or API path in the guest
(staging runbook below); the machine-config variables reaching the entrypoint; the entrypoint's
exit stopping the machine; Fly's init keeping the claim token in its own memory; the real GitHub
`DELETE /installation/token` and a shallow `--branch` clone from github.com; Supabase's signed
upload method (PUT assumed, D15); the real platform's callback behaviour. The real `kete` runs only in the image's end-to-end
test (`packages/kete-job-image`, piece D), against this module's fake platform
(`cmd/kete-job-fake-platform`, `internal/e2e`).

## Staging runbook: confirming the Fly guard and the isolation check

Run once on a real Fly machine of the staging jobs app before production traffic, and again after
a Fly platform change or an image change to the guard. Use a staging job (a staging claim token
and platform), never a production one.

1. **Start a job machine from the image** with the staging machine configuration. Watch its logs
   (`fly logs -a <jobs app>`): the phase lines must show `setup_fly` `ok` and `isolation` `ok`
   before `claim` `start`. A `setup_fly` `missing` means Fly's variables are set but `/.fly/api`
   isn't there: stop and find where the socket went (step 3) before changing anything.
2. **Inspect the machine** from a second machine on the same image whose entrypoint is
   overridden to `sleep 3600` (`fly machine run --entrypoint`; no `KETE_*` variables, so the
   entrypoint never runs) and `fly ssh console -s` into it, then as root:
   `ls -la /.fly /.fly/api` (before the guard: note the real owner and mode),
   `env | grep ^FLY_` (the variables the boot stage detects).
3. **Look for other API paths:** `cat /proc/net/unix` (every listening socket has flags `00010000`;
   names starting `@` are abstract), `ss -xlp` and `ss -tlnp`/`ss -ulnp` (listeners on the 6PN
   address, e.g. `hallpass` on port 22), `ls -la /.fly`, and `ip -6 addr` (the machine's
   `fdaa:` addresses). Any listening unix socket other than Fly's own `/.fly/api` would fail the
   job with `unix_socket`; record what it is.
4. **Confirm the socket lock as the tool user** on that machine, after applying the guard by hand
   (`chmod 0700 /.fly; chmod 0600 /.fly/api`, what the entrypoint does):
   `setpriv --reuid kete-tool --regid kete-job --clear-groups -- curl -sS --unix-socket /.fly/api
   http://flaps/v1/apps` must fail with permission denied (and, run as root, succeed: the socket
   is the real API). The network targets (`169.254.169.254`, `[fdaa::3]`, loopback) are blocked by
   the job's firewall, which this machine doesn't have; step 1's `isolation` `ok` is their check.
5. **Prove the check fails closed on the real machine** (staging only): on the step 2 machine,
   start a world-connectable listener somewhere unexpected (any tool that can, e.g.
   `python3 -c 'import socket,os;s=socket.socket(socket.AF_UNIX);s.bind("/run/stray.sock");os.chmod("/run/stray.sock",0o666);s.listen();input()'`
   in one shell), then run `/usr/local/libexec/kete/kete-job-entrypoint` as root with a staging
   machine configuration in its environment: it must stop at `isolation` `unix_socket` with no
   claim (the claim token stays unused).
6. Record the outcome (date, image digest, Fly region, what step 3 listed) in the task that ships
   the jobs app, and update "Not verified without a real Fly machine" above.
