// The `kete.context` plugin RPC (core/src/kete/context-breakdown.ts) behind `/context`: how much of a
// session's context window each part takes (system prompt, tools, Code Mode catalog, MCP, memory and
// instruction files, skills, messages). Sizes and names only, never file contents, config, headers or
// environment. Tokens are estimates (characters / 4), except `provider.tokens`, which the provider
// reported for the last step. Served by the existing `POST /api/rpc/:rpcID/:method`.

export * as KeteContextRpc from "./context.js"

import { Schema } from "effect"
import { Rpc } from "../rpc.js"
import { optional } from "../schema.js"

export const MAX_CATEGORIES = 12
export const MAX_ITEMS = 100
export const MAX_NAME = 300

const Count = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Name = Schema.String.check(Schema.isMaxLength(MAX_NAME))

export const Item = Schema.Struct({
  name: Name,
  characters: Count,
  tokens: Count,
}).annotate({ identifier: "KeteContext.Item" })
export type Item = typeof Item.Type

export const CategoryID = Schema.Literals(["system", "tools", "codemode", "mcp", "memory", "skills", "messages", "other"]).annotate({
  identifier: "KeteContext.CategoryID",
})
export type CategoryID = typeof CategoryID.Type

export const Category = Schema.Struct({
  id: CategoryID,
  label: Name,
  characters: Count,
  tokens: Count,
  items: Schema.Array(Item).check(Schema.isMaxLength(MAX_ITEMS)),
}).annotate({ identifier: "KeteContext.Category" })
export type Category = typeof Category.Type

export const Breakdown = Schema.Struct({
  type: Schema.Literal("breakdown"),
  categories: Schema.Array(Category).check(Schema.isMaxLength(MAX_CATEGORIES)),
  /** MCP tools a permission rule keeps out of the request. Left out when there are none. */
  hiddenMcp: optional(Schema.Struct({ count: Count, reason: Name })),
  /** The provider's own count for the last step. Left out when the session has no step with usage. */
  provider: optional(Schema.Struct({ tokens: Count, contextLimit: optional(Count), free: optional(Schema.Number) })),
  estimated: Schema.Literal(true),
}).annotate({ identifier: "KeteContext.Breakdown" })
export type Breakdown = typeof Breakdown.Type

export const Refused = Schema.Struct({ type: Schema.Literal("refused"), reason: Name }).annotate({
  identifier: "KeteContext.Refused",
})

export const Output = Schema.Union([Breakdown, Refused]).annotate({ identifier: "KeteContext.Output" })
export type Output = typeof Output.Type

export const ID = "kete.context"

export const Definition = Rpc.define({
  id: ID,
  methods: {
    get: { input: Schema.Struct({ sessionID: Schema.String }), output: Output },
  },
  events: {},
})
