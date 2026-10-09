export * as PluginInternal from "./internal.js"

import { LLMClient } from "@opencode/ai"
import type { Plugin } from "@opencode/plugin/effect/plugin"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { AppProcess } from "@opencode/util/process"
import { Context, Effect, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Agent } from "../agent.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { Command } from "../command.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { llmClient } from "../effect/app-node-platform.js"
import { ConfigAgentPlugin } from "../config/plugin/agent.js"
import { ConfigCommandPlugin } from "../config/plugin/command.js"
import { ConfigCompactionPlugin } from "../config/plugin/compaction.js"
import { ConfigFormatterPlugin } from "../config/plugin/formatter.js"
import { ConfigImagePlugin } from "../config/plugin/image.js"
import { ConfigInstructionPlugin } from "../config/plugin/instruction.js"
import { ConfigLocationWatcherPlugin } from "../config/plugin/location-watcher.js"
import { ConfigMcpPlugin } from "../config/plugin/mcp.js"
import { ConfigProviderPlugin } from "../config/plugin/provider.js"
import { ConfigPolicyPlugin } from "../config/plugin/policy.js"
import { ConfigReferencePlugin } from "../config/plugin/reference.js"
import { ConfigShellPlugin } from "../config/plugin/shell.js"
import { ConfigSnapshotPlugin } from "../config/plugin/snapshot.js"
import { ConfigSkillPlugin } from "../config/plugin/skill.js"
import { ConfigCompatibilityPlugin } from "../config/plugin/compatibility.js"
import { ConfigToolOutputPlugin } from "../config/plugin/tool-output.js"
import { ConfigWebSearchPlugin } from "../config/plugin/websearch.js"
import { ConfigWorktreePlugin } from "../config/plugin/worktree.js"
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { FileMutation } from "../file-mutation.js"
import { Formatter } from "../formatter.js"
import { Form } from "../form.js"
import { FileSystem } from "../filesystem.js"
import { LocationWatcherPolicy } from "../filesystem/location-watcher-policy.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Image } from "../image.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Integration } from "../integration.js"
import { Job } from "../job.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { ManagedPolicy } from "../managed-policy.js"
import { ModelsDev } from "../models-dev.js"
import { Mcp } from "../mcp/index.js"
import { Npm } from "@opencode/util/npm"
import { Permission } from "../permission.js"
import { Reference } from "../reference.js"
import { WebSearch } from "../websearch.js"
import { Ripgrep } from "../ripgrep.js"
import { Session } from "../session.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionInstructions } from "../session/instructions.js"
import { Shell } from "../shell.js"
import { ShellSelect } from "../shell/select.js"
import { Snapshot } from "../snapshot.js"
import { Skill } from "../skill.js"
import { SkillDiscovery } from "../skill/discovery.js"
import { Watcher } from "../filesystem/watcher.js"
import { PatchTool } from "../tool/plugin/patch.js"
import { EditTool } from "../tool/plugin/edit.js"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { McpResourceTools } from "../tool/plugin/mcp-resource.js"
import { OpenCodeTools } from "../tool/plugin/opencode.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { ReadTool } from "../tool/plugin/read.js"
import { ShellTool } from "../tool/plugin/shell.js"
import { SkillTool } from "../tool/plugin/skill.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { WebFetchTool } from "../tool/plugin/webfetch.js"
import { WebSearchTool } from "../tool/plugin/websearch.js"
import { WellKnown } from "../wellknown.js"
import { WriteTool } from "../tool/plugin/write.js"
import { AgentPlugin } from "./agent.js"
import BrowserPlugin from "@opencode/plugin-browser"
import { CommandPlugin } from "./command.js"
import { NativeCompactionPlugin } from "./compaction.js"
import { IdentityPlugin } from "./identity.js"
import { PlanPlugin } from "./plan.js"
import { ModelsDevPlugin } from "./models-dev.js"
import { McpCodeModeDefaultsPlugin } from "./mcp-codemode-defaults.js"
import { ProviderPlugins } from "./provider.js"
import { OpencodePlugin } from "./provider/opencode.js"
import { WebSearchPlugins } from "./websearch/index.js"
import { SkillPlugin } from "./skill.js"
import { KeteSkillPlugin } from "../kete/skill.js" // kete_change
import { KeteGateway } from "../kete/gateway.js" // kete_change
import { KeteBudgetRule } from "../kete/budget-rule.js" // kete_change
import { KeteAttribution } from "../kete/attribution.js" // kete_change
import { KeteAgentSync } from "../kete/sync/plugin.js" // kete_change
import { KetePermissionMode } from "../kete/permission-mode.js" // kete_change
import { KeteSandbox } from "../kete/sandbox.js" // kete_change
import { KeteRoles } from "../kete/roles.js" // kete_change
import { KeteSubagents } from "../kete/subagents.js" // kete_change
import { KeteWorktrees } from "../kete/worktrees.js" // kete_change
import { KetePermissionCeiling } from "../kete/permission-ceiling.js" // kete_change
import { KeteUnattended } from "../kete/unattended.js" // kete_change
import { KeteJobPlugin } from "../kete/job-plugin.js" // kete_change
import { KeteLocalModels } from "../kete/local-models.js" // kete_change
import { KeteOffline } from "../kete/offline.js" // kete_change
import { KeteSessionMove } from "../kete/session-move.js" // kete_change
import { KeteStaleWrite } from "../kete/stale-write.js" // kete_change
import { KeteWorkflows } from "../kete/workflows.js" // kete_change
import { KeteTodo } from "../kete/todo.js" // kete_change
import { KeteLsp } from "../kete/lsp.js" // kete_change
import { KeteHooks } from "../kete/hooks.js" // kete_change
import { PermissionSaved } from "../permission/saved.js" // kete_change
import { Project } from "../project.js" // kete_change
import { VcsHgPlugin } from "./vcs/hg.js"
import { ToolInputRepairPlugin } from "./tool-input-repair.js"
import { OptimizePlugin } from "./optimize.js"
import { VcsGitPlugin } from "./vcs/git.js"
import { WarmingPlugin } from "./warming.js"
import { WellKnownPlugin } from "../wellknown/plugin.js"

const services = [
  Agent.Service,
  AppProcess.Service,
  Provider.Service,
  Model.Service,
  Command.Service,
  Config.Service,
  Credential.Service,
  Bus.Service,
  Environment.Service,
  FileAccess.Service,
  FileMutation.Service,
  Formatter.Service,
  LocationWatcherPolicy.Service,
  FileSystem.Service,
  FSUtil.Service,
  Global.Service,
  HttpClient.HttpClient,
  Image.Service,
  InstructionDiscovery.Service,
  Integration.Service,
  Job.Service,
  KV.Service,
  LLMClient.Service,
  Location.Service,
  ManagedPolicy.Service,
  ModelsDev.Service,
  Mcp.Service,
  Npm.Service,
  Permission.Service,
  PermissionSaved.Service, // kete_change: KetePermissionCeiling
  Project.Service, // kete_change: KeteWorktrees (the worktree setup script)
  Form.Service,
  ReadToolFileSystem.Service,
  Reference.Service,
  WebSearch.Service,
  Ripgrep.Service,
  Session.Service,
  SessionCompaction.Service,
  SessionInstructions.Service,
  Shell.Service,
  ShellSelect.Service,
  Snapshot.Service,
  Skill.Service,
  SkillDiscovery.Service,
  Tool.Service,
  ToolOutput.Service,
  Watcher.Service,
  WellKnown.Service,
  Worktree.Service,
  WorktreeStrategies.Service,
] as const

export type Requirements = Context.Service.Identifier<(typeof services)[number]>

export const requirements = LayerNode.group([
  Agent.node,
  AppProcess.node,
  Provider.node,
  Model.node,
  Command.node,
  Config.node,
  Credential.node,
  Bus.node,
  Environment.node,
  FileAccess.node,
  FileMutation.node,
  Formatter.node,
  LocationWatcherPolicy.node,
  FileSystem.node,
  FSUtil.node,
  Global.node,
  httpClient,
  Image.node,
  InstructionDiscovery.node,
  Integration.node,
  Job.node,
  KV.node,
  llmClient,
  Location.node,
  ManagedPolicy.node,
  ModelsDev.node,
  Mcp.node,
  Npm.node,
  Permission.node,
  PermissionSaved.node, // kete_change: KetePermissionCeiling
  Project.node, // kete_change: KeteWorktrees (the worktree setup script)
  Form.node,
  ReadToolFileSystem.node,
  Reference.node,
  WebSearch.node,
  Ripgrep.node,
  Session.node,
  SessionCompaction.node,
  SessionInstructions.node,
  Shell.node,
  ShellSelect.node,
  Snapshot.node,
  Skill.node,
  SkillDiscovery.node,
  Tool.node,
  ToolOutput.node,
  Watcher.node,
  WellKnown.node,
  Worktree.node,
  WorktreeStrategies.node,
])

export type InternalPlugin = Plugin<Requirements | Scope.Scope>

const pre = [
  ToolInputRepairPlugin.Plugin,
  ConfigWorktreePlugin.Plugin,
  BrowserPlugin,
  ConfigMcpPlugin.Plugin,
  McpCodeModeDefaultsPlugin.Plugin,
  WellKnownPlugin.Plugin,
  VcsGitPlugin.Plugin,
  AgentPlugin.Plugin,
  PlanPlugin.Plugin,
  CommandPlugin.Plugin,
  SkillPlugin.Plugin,
  VcsHgPlugin.Plugin,
  ModelsDevPlugin,
  NativeCompactionPlugin.Plugin,
  ...ProviderPlugins,
  ...WebSearchPlugins,
  PatchTool.Plugin,
  // Render model prompts after the patch plugin selects the available editing tools.
  ...OptimizePlugin.Plugins,
  IdentityPlugin.Plugin,
  EditTool.Plugin,
  GlobTool.Plugin,
  GrepTool.Plugin,
  OpenCodeTools.Plugin,
  McpResourceTools.Plugin,
  QuestionTool.Plugin,
  ReadTool.Plugin,
  ShellTool.Plugin,
  SkillTool.Plugin,
  SubagentTool.Plugin,
  WebFetchTool.Plugin,
  WebSearchTool.Plugin,
  WriteTool.Plugin,
  WarmingPlugin.Plugin,
  // kete_change: after SkillPlugin and OpenCodeTools; replaces their OpenCode-specific skills and namespace text
  KeteSkillPlugin.Plugin,
  // kete_change: after the catalog and provider plugins; gateway models copy their source provider's definitions
  KeteGateway.Plugin,
  // kete_change: after the provider plugins; replaces their OpenCode attribution headers with Kete Code's
  KeteAttribution.Plugin,
  // kete_change: starter role agents when not signed in to an organization; before KeteBudgetRule so they get its rule
  KeteRoles.Plugin,
  // kete_change: after AgentPlugin, before configuration rules are appended (post); see kete/budget.ts
  KeteBudgetRule.Plugin,
  // kete_change: an unattended run's policy loosens "ask" to "allow"; before mode/ceiling so they can still tighten it back; see kete/unattended.ts
  KeteUnattended.PolicyPlugin,
  // kete_change: safe defaults and permission modes (only tighten); see kete/permission-mode.ts
  KetePermissionMode.Plugin,
  // kete_change: the OS sandbox's escapes always ask (Plan blocks them); its status RPC; see kete/sandbox.ts
  KeteSandbox.Plugin,
  // kete_change: stopping a session stops its running subagents; see kete/subagents.ts
  KeteSubagents.Plugin,
  // kete_change: guards worktree removal, keeps sessions out of subagent worktrees; see kete/worktrees.ts
  KeteWorktrees.Plugin,
  // kete_change: a subagent can't do more than the agents above it; see kete/permission-ceiling.ts
  KetePermissionCeiling.Plugin,
  // kete_change: checks on the model's session_move tool; see kete/session-move.ts
  KeteSessionMove.Plugin,
  // kete_change: a write can't overwrite a version of a file its session hasn't seen; see kete/stale-write.ts
  KeteStaleWrite.Plugin,
  // kete_change: configured workflows run as subagent steps; see kete/workflows.ts
  KeteWorkflows.Plugin,
  // kete_change: the session task list (`todowrite` tool, `kete.todo` RPC); see kete/todo.ts
  KeteTodo.Plugin,
  // kete_change: language server diagnostics appended to edit results; see kete/lsp.ts
  KeteLsp.Plugin,
  // kete_change: shell commands configured under kete.hooks (project hooks only once trusted); see kete/hooks.ts
  KeteHooks.Plugin,
] as const satisfies readonly InternalPlugin[]

const post = [
  ConfigInstructionPlugin.Plugin,
  ConfigReferencePlugin.Plugin,
  ConfigAgentPlugin.Plugin,
  ConfigCommandPlugin.Plugin,
  ConfigCompactionPlugin.Plugin,
  ConfigFormatterPlugin.Plugin,
  ConfigImagePlugin.Plugin,
  ConfigLocationWatcherPlugin.Plugin,
  ConfigShellPlugin.Plugin,
  ConfigSnapshotPlugin.Plugin,
  ConfigToolOutputPlugin.Plugin,
  ConfigCompatibilityPlugin.Plugin,
  ConfigSkillPlugin.Plugin,
  // kete_change: after the config agent, compatibility and skill plugins, so platform-managed agents and skills win over local ones with the same slug
  KeteAgentSync.Plugin,
  ConfigProviderPlugin.Plugin,
  ConfigWebSearchPlugin.Plugin,
  ConfigPolicyPlugin.Plugin,
  // kete_change: after ConfigProviderPlugin, so a configured `capabilities.tools` is applied; local server status and no-tools models
  KeteLocalModels.Plugin,
  // kete_change: offline mode removes non-local models, remote MCP servers and web tools; adds no rules, so policy applies as online
  KeteOffline.Plugin,
  // kete_change: before KeteUnattended.Plugin; job mode disables every MCP server and every non-kete model
  KeteJobPlugin.Plugin,
  // kete_change: last, after every hook that could still turn "ask" into "allow"; see kete/unattended.ts
  KeteUnattended.Plugin,
  // kete_change: after every other hook: marks a shell request a person will approve (network in the OS sandbox); see kete/sandbox.ts
  KeteSandbox.ApprovalPlugin,
] as const satisfies readonly InternalPlugin[]

// Repository config must not switch off policy enforcement or the Console connection that delivers
// organization statements, so plugin remove operations skip these IDs.
// kete_change start: an unattended run's fail-closed policy must not be removable by repository config (ADR 0008)
export const guarded: ReadonlySet<string> = new Set([
  OpencodePlugin.id,
  ConfigPolicyPlugin.Plugin.id,
  KeteUnattended.PolicyPlugin.id,
  KeteUnattended.Plugin.id,
  KeteJobPlugin.Plugin.id,
  KeteOffline.Plugin.id,
  KeteSandbox.Plugin.id,
  KeteSandbox.ApprovalPlugin.id,
])
// kete_change end

export const list = Effect.fn("PluginInternal.list")(function* () {
  // Capture only services; activation supplies the child Scope and batching context.
  const context = Context.pick(...services)(yield* Effect.context<Requirements>())
  const resolve = (plugins: readonly InternalPlugin[]) =>
    plugins.map(
      (plugin): Plugin => ({
        id: plugin.id,
        effect: (host) => plugin.effect(host).pipe(Effect.provide(context)),
      }),
    )
  return {
    pre: resolve(pre),
    post: resolve(post),
  }
})
