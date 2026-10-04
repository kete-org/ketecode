/// <reference path="../../src/markdown.d.ts" />

import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Layer, Stream } from "effect"
import { SkillPlugin } from "@opencode/core/plugin/skill"
import { KeteSkillPlugin } from "@opencode/core/kete/skill"
import { Skill } from "@opencode/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"
import reportSource from "../../src/kete/skill/report.md" with { type: "text" }

const it = testEffect(AppNodeBuilder.build(Skill.node))
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([new Document({ type: "document", info: new Info({ plugins: [] }) })]),
    changes: () => Stream.never,
  }),
)

// Records the namespaces a plugin registers without building the tool service.
function toolRecorder() {
  const namespaces: { name: string; description?: string }[] = []
  const draft = { namespace: (namespace: { name: string; description?: string }) => namespaces.push(namespace) }
  const transform = (update: (value: typeof draft) => void) => Effect.sync(() => update(draft))
  return { namespaces, transform }
}

// Upstream's plugin first, then Kete's, as ordered in plugin/internal.ts.
const loadBoth = Effect.fn(function* () {
  const skill = yield* Skill.Service
  const tools = toolRecorder()
  const context = host({
    app: { name: "test", version: "1.2.3", channel: "beta" },
    skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: skill.reload },
    // The recorder implements only what these plugins call.
    tool: { transform: tools.transform } as unknown as ReturnType<typeof host>["tool"],
  })
  yield* SkillPlugin.Plugin.effect(context)
  yield* KeteSkillPlugin.Plugin.effect(context)
  return { skills: yield* skill.list(), namespaces: tools.namespaces }
})

describe("KeteSkillPlugin", () => {
  it.effect("replaces upstream's OpenCode skill with the Kete Code skill", () =>
    Effect.gen(function* () {
      const { skills } = yield* loadBoth()
      expect(skills.map((skill) => String(skill.id)).toSorted()).toEqual(["kete", "report"])
      expect(skills.find((skill) => skill.id === "kete")).toMatchObject({
        name: "Kete Code",
        description: expect.stringContaining("any question about Kete Code itself"),
        content: KeteSkillPlugin.KeteContent,
      })
    }).pipe(Effect.provide(config)),
  )

  it.effect("replaces the report skill with one that never files in OpenCode's repository", () =>
    Effect.gen(function* () {
      const report = (yield* loadBoth()).skills.find((skill) => skill.id === "report")
      expect(report?.description).toContain("Kete Code issue")
      expect(report?.content).toContain("Never file a Kete Code issue in the OpenCode repository")
      expect(report?.content).toContain("does not have a public issue tracker yet. Do not publish the report anywhere")
      expect(report?.content).toContain("- Kete Code version: 1.2.3")
      expect(report?.content).toContain("- install/channel: beta")
      expect(report?.content).not.toContain("gh issue create")
    }).pipe(Effect.provide(config)),
  )

  it.effect("describes the inherited tool namespace as Kete Code's, keeping its ID", () =>
    Effect.gen(function* () {
      const { namespaces } = yield* loadBoth()
      expect(namespaces).toEqual([{ name: "opencode", description: KeteSkillPlugin.ToolNamespaceDescription }])
      expect(KeteSkillPlugin.ToolNamespaceDescription).toStartWith("Tools for managing Kete Code itself")
    }).pipe(Effect.provide(config)),
  )

  test("files reports in Kete's own tracker once one is configured", () => {
    const destination = KeteSkillPlugin.reportDestination("https://example.com/kete/issues")
    expect(destination).toContain("<https://example.com/kete/issues>")
    expect(destination).toContain("publish only after")
  })
})

// OpenCode names that must not reach the user. The Kete skill may mention OpenCode as
// its foundation and link OpenCode's docs, but outside the name-mapping table it must
// never hand the user an OpenCode command, path, file name, or variable.
const forbidden = [
  /(^|[\s`(])opencode (mcp|service|api|auth|run|upgrade|serve|models|--)/,
  /~\/\.config\/opencode/,
  /\.local\/share\/opencode/,
  /(^|[^\w.])\.opencode\b/,
  /opencode\.jsonc?/,
  /OPENCODE_[A-Z]/,
  /anomalyco\/opencode\/issues/,
]

function offending(markdown: string) {
  return markdown
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("|")) // the name-mapping table
    .map((line) => line.replace(/https?:\/\/\S+/g, "")) // documentation links
    .filter((line) => forbidden.some((pattern) => pattern.test(line)))
}

describe("Kete skill content", () => {
  test("the Kete Code skill hands out only Kete names", () => {
    expect(offending(KeteSkillPlugin.KeteContent)).toEqual([])
  })

  test("the report skill hands out only Kete names", () => {
    expect(offending(reportSource)).toEqual([])
  })

  test("the content check catches OpenCode names", () => {
    expect(offending("Run `opencode service restart`.\nEdit ~/.config/opencode/opencode.json")).toHaveLength(2)
  })
})
