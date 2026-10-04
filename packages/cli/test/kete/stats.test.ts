import { expect, test } from "bun:test"
import type { SessionStatsInfo } from "@opencode/client"
import { Brand } from "@opencode/util/kete/brand"
import { renderStats } from "../../src/commands/handlers/stats"

const stats: SessionStatsInfo = {
  range: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 8) },
  sessions: 1,
  subagents: 0,
  prompts: 1,
  steps: 1,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  tools: { mode: "none" },
  activeDays: 1,
  streak: 1,
  activity: [{ date: "2026-01-02", steps: 1 }],
  models: [],
}
const options = { label: "2026", scope: "all projects", models: false, tools: false, cost: false, limit: 5, color: false, width: 80 }

test("kete stats never credits opencode.ai; the footer waits for a Kete website", () => {
  for (const input of [stats, { ...stats, sessions: 0, steps: 0, activity: [] }]) {
    const output = renderStats(input, options)
    expect(output).not.toMatch(/opencode/i)
    expect(output).toContain(`${Brand.cliName} stats`)
  }
  expect(Brand.urls.website).toBeUndefined()
})
