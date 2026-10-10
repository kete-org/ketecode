// A permission service that enforces an organization's synced policies the way the sync plugin does
// (util/src/kete/sync/policy.ts `evaluate`, with the runtime's wildcard matcher): enough to show that a
// check goes through the permission system and that a policy in the documented form refuses it.
import { Effect } from "effect"
import { Permission } from "@opencode/core/permission"
import { Wildcard } from "@opencode/core/util/wildcard"
import { KeteSyncPolicy } from "@opencode/util/kete/sync/policy"
import type { SyncedPolicy } from "@opencode/util/kete/sync/contract"

/** The policy docs/sandbox.md documents: an organization requiring the OS sandbox. */
export const requireSandbox: SyncedPolicy = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Require the sandbox",
  description: "",
  category: "security",
  enforcement: "enforced",
  environment_kinds: [],
  agents: null,
  rules: [{ action: "sandbox_off", resource: "*", effect: "deny", description: "Commands run in the OS sandbox" }],
  updated_at: "2026-10-10T00:00:00Z",
}

export function permissionWith(policies: ReadonlyArray<SyncedPolicy>, asked: string[] = []) {
  return Permission.Service.of({
    assert: (input: { action: string; resources: ReadonlyArray<string> }) =>
      Effect.suspend(() => {
        asked.push(input.action)
        const result = KeteSyncPolicy.evaluate(policies, { action: input.action, resources: input.resources, environment: "development" }, Wildcard.match)
        return result.enforced?.effect === "deny"
          ? Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: [...input.resources] } as any))
          : Effect.void
      }),
  } as any)
}
