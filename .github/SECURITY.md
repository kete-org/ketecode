# Security policy

Kete Code runs commands, edits files and handles credentials on your machine, so we take
vulnerability reports seriously.

## Reporting a vulnerability

Please report privately; **never open a public issue for a security problem**.

- **GitHub:** [Report a vulnerability](https://github.com/kete-org/ketecode/security/advisories/new)
  (private vulnerability reporting), or
- **Email:** [security@ketecode.ai](mailto:security@ketecode.ai)

Include what you found, how to reproduce it, the affected version (`kete --version`) and platform,
and the impact you expect. We'll acknowledge your report, keep you updated until a fix is
released, and credit you in the advisory unless you'd rather we didn't.

## Scope

In scope: this repository: the `kete` CLI and terminal UI, the agent runtime and its permission
system, the VS Code extension, the install scripts and `kete upgrade`, and the cloud job runtime
(job image, entrypoint, egress proxy, self-hosted job host).

Examples: permission or workspace-boundary bypasses, path traversal, secrets reaching a model,
logs or telemetry, command injection, update or installer verification bypasses, and escapes from
a cloud job's sandbox.

The Kete platform (ketecode.ai, app.ketecode.ai, the model gateway) is operated separately; report
issues with it to the same address.

## Supported versions

Security fixes go into the latest release. Update with `kete upgrade` or your package manager.
