# Architecture Decision Records

Significant decisions for the Kete Code runtime are recorded here (see
`docs/architecture.md` §87). Don't reverse an accepted ADR; write a new one that
supersedes it and set the old one's status to `Superseded by NNNN`.

## Index

| ADR                                         | Title                                           | Status   |
| ------------------------------------------- | ----------------------------------------------- | -------- |
| [0001](0001-opencode-upstream-strategy.md)  | OpenCode upstream strategy                      | Accepted |
| [0002](0002-runtime-platform-separation.md) | Runtime and platform separation                 | Accepted |
| [0003](0003-hosted-services-opt-in.md)      | Inherited hosted services are opt-in            | Accepted |
| [0004](0004-gateway-client.md)              | Gateway client uses the gateway's native routes | Accepted |
| [0005](0005-cloud-runtime-in-sandbox.md)    | The cloud runtime runs whole inside the sandbox | Accepted |
| [0006](0006-jobs-pulled-with-leases.md)     | Runtimes pull jobs, with leases                 | Accepted |
| [0007](0007-job-credentials.md)             | Jobs use short-lived, job-scoped credentials    | Accepted |
| [0008](0008-unattended-runs-fail-closed.md) | Unattended runs fail closed                     | Accepted |
| [0009](0009-public-cli-distribution.md)     | Public CLI distribution and verified self-update | Accepted |

## Not yet written

`docs/architecture.md` §87 also names these topics. Each gets an ADR when the decision
is actually made; until then the architecture reference describes direction only.

- Runtime authentication
- Agent architecture
- Skills architecture
- MCP security
- Sandbox architecture (the cloud shape is ADR 0005; local sandboxing is still open)

## Writing an ADR

Copy [`template.md`](template.md) to `NNNN-short-title.md` with the next number, fill it
in, and add it to the index in the same PR as the change it describes (or before it).
