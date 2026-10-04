# Spec: Job mode: runtime request shape matches the gateway's job-key allowlist; item 11 audit

- Task: `docs/tasks/2026-10-02-job-gateway-allowlist` · Size: medium · Created: 2026-10-02
- Status: built <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
A cloud job never sends the gateway a model request a job key may not make: the runtime refuses it
locally with a clear error (or conforms it, as it already does for the output limit), so a job fails
with a readable local message instead of a gateway 400. And an audit of the platform's build item 11
(what the runtime image must provide, kete-code-platform `docs/jobs.md` §8, §10 item 11) against
what kete-code built, with the small gaps closed.

## Scope
- `job-mode` card: `packages/core/src/kete/job-request.ts` and `job-request/*` — mirror the
  gateway's job-key checks (platform `apps/gateway/src/jobs/{request-shape,output-limit}.ts`,
  `schemas/*.ts`, `docs/gateway.md` §2.8): the six job routes only (no deepseek, no token counting);
  `anthropic-beta`/`openai-beta` and query allowlists; `background`, provider-tool history, hosted
  `tool_choice`; the thinking-budget rule; the strict schemas (copied as zod, field for field).
- Gemini replayed history: never an explicit `null` for `functionCall.id`, `thought`,
  `thoughtSignature` (omit instead).
- `docs/platform/jobs-v1.md`: copy of the platform contract, with the copy-provenance header the
  other mirrors use.
- `job-entrypoint` card: the heartbeat's kete-cgroup check (ADR 0019 rule 5) fails closed — an
  unreadable exe counts, an unreadable cgroup is reported in the event's message — with a unit test
  and an integration scenario for a stray process.

## Out of scope
- Changing the gateway or its schemas (read only).
- Upstream `packages/ai` lowering (no upstream edit needed: the conformer normalises the body).
- Large item-11 gaps — listed for the coordinator in result.md.

## Acceptance criteria
- [ ] AC1: every gateway job-key refusal class has a local equivalent, tested per family
  (`packages/core/test/kete/job-request.test.ts`).
- [ ] AC2: the real provider packages (Anthropic, OpenAI Responses and Chat, Gemini, OpenRouter)
  pointed at gateway routes produce requests the local checks pass — beta header, `?beta=true`,
  `alt=sse`, clamps — and a disallowed beta from provider headers is refused with zero bytes sent
  (`job-request-wire.test.ts`, `job-request-service.test.ts`).
- [ ] AC3: a replayed Gemini body with `null` in those fields is sent without them.
- [ ] AC4: `docs/platform/jobs-v1.md` present with provenance.
- [ ] AC5: item 11 table in result.md; the heartbeat check fails closed; unit + integration tests.

## Risks and constraints
- Security: stricter only (refuses more, never less). Two conformances, not refusals: the thinking
  budget is lowered below the clamped output (as the output itself already is), and `null` part
  fields are omitted. No contract, schema, money or tenancy change in this repo.
- Drift: the schema copies must follow the platform's; the wire test is the tripwire.
