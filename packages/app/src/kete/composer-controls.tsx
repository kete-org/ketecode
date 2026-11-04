// The two Kete controls the composer's toolbar renders through `ComposerEditor`'s `kete` slot
// (composer/editor/editor.tsx): the commands button next to the `+` menu, and the permission-mode
// toggle (Default/Auto/Ask/Plan, kete/mode.ts) next to send. Both take the composer's `ComposerModel` and wire themselves to the route
// (which session, or which new-session draft, is open) and the server SDK — composer.tsx only
// passes them through, so its own edit stays a couple of lines.

import { createMemo, createSignal, Show } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import type { ComposerModel } from "@/composer/model"
import { useLocal } from "@/providers/models/selection"
import { useData, useServer } from "@/runtime/server/current"
import {
  agentSwitchVisible,
  apply,
  derive,
  DESCRIPTION,
  KeteModeDraft,
  LABEL,
  next as nextMode,
  PLAN_AGENT,
  selectAgent,
  switchTarget,
  type ApplyAgent,
  type Mode,
} from "./mode"
import { KeteAgentSwitchView } from "./agent-switch"
import { homeLayout } from "./panel-state"
import { useKeteNoToolsNotice } from "./local-ui"

export function KeteCommandsButton(props: { model: ComposerModel }) {
  return (
    <Tooltip placement="top" value="Commands">
      <IconButton
        type="button"
        data-action="kete-commands"
        icon={<Icon name="code-slash" />}
        variant="ghost-muted"
        size="large"
        aria-label="Commands"
        onClick={props.model.openCommands}
      />
    </Tooltip>
  )
}

/** The session this composer is for: an existing session's ID from the route, or (on the new-session
 *  route) the draft's ID, for `KeteModeDraft` until `session.create` gives it a real one. */
function useComposerSessionKey() {
  const location = useLocation()
  const [search] = useSearchParams<{ draftId?: string }>()
  return {
    sessionID: createMemo(() => /\/session\/([^/]+)$/.exec(location.pathname)?.[1]),
    draftID: () => search.draftId,
  }
}

/** The composer's permission mode and how to change it, shared by the mode toggle and the Build | Plan switch. */
export function useKeteMode(model: ComposerModel) {
  const server = useServer()
  const data = useData()
  const { sessionID, draftID } = useComposerSessionKey()

  const agentView = () => model.view.agent
  const metadata = createMemo(() => {
    const id = sessionID()
    return id ? data.session.get(id)?.metadata : undefined
  })
  // A new-session draft has no metadata yet: show the mode chosen for it.
  const [draftMode, setDraftMode] = createSignal<Mode | undefined>()
  const mode = createMemo<Mode>(() => {
    const draft = draftID()
    const fallback = sessionID() || !draft ? undefined : (draftMode() ?? KeteModeDraft.get(draft))
    return derive({ agent: agentView()?.current(), metadata: metadata(), fallback })
  })

  // Upstream hides its agent picker unless custom agents exist (providers/models/selection.tsx), so the
  // composer's view then has no agents; the same list is still on the local selection it reads from.
  const local = optionalLocal()
  const applyAgent = (): ApplyAgent => {
    const view = agentView()
    if (view)
      return {
        current: () => view.current(),
        options: () => view.options().map((option) => option.id),
        select: (name) => view.onSelect(name),
      }
    return {
      current: () => local?.agent.current()?.name ?? "",
      options: () => local?.agent.list().map((agent) => agent.name) ?? [],
      select: (name) => local?.agent.set(name),
    }
  }

  const set = (target: Mode) => {
    const id = sessionID()
    if (id) {
      void apply({ sdk: server.ctx.sdk.api, sessionID: id, mode: target, agent: applyAgent() })
      return
    }
    // No session yet: the mode waits in KeteModeDraft for session.create (new-session/composer-adapter.ts)
    // to carry it in atomically; Plan's agent choice applies to the draft's selection right away.
    const draft = draftID()
    if (draft) KeteModeDraft.set(draft, target)
    setDraftMode(target)
    selectAgent(applyAgent(), draft ?? "", target)
  }

  const planAvailable = () => applyAgent().options().includes(PLAN_AGENT)

  return { sessionID, draftID, mode, set, planAvailable }
}

// `useLocal` throws outside its provider; composer stories and editor hosts can render the composer without one.
function optionalLocal(): ReturnType<typeof useLocal> | undefined {
  try {
    return useLocal()
  } catch {
    return undefined
  }
}

export function KeteModeToggle(props: {
  model: ComposerModel
  /** "toolbar" sits next to send; "under" sits under the card on the desktop/web home (view.tsx). */
  placement?: "toolbar" | "under"
}) {
  const state = useKeteMode(props.model)
  // Once per session, for a model that can't call tools: it can only answer (local-ui.tsx).
  useKeteNoToolsNotice({ sessionID: state.sessionID, model: () => props.model.model.selection.current() })
  const { mode } = state

  // On the desktop/web new-session screen the "under" instance replaces the toolbar one. Plan has the
  // Build | Plan switch there, so the cycle skips it, unless the session is already in Plan.
  const placement = () => props.placement ?? "toolbar"
  const hidden = () => (placement() === "toolbar" ? homeLayout() && !!state.draftID() : !homeLayout())
  const cycle = () => state.set(nextMode(mode(), { plan: !homeLayout() }))

  const label = () => `Permission mode: ${LABEL[mode()]}. ${DESCRIPTION[mode()]}`

  return (
    <Show when={!hidden()}>
      <Tooltip placement="top" value={label()}>
        <button
          type="button"
          data-kete="mode-toggle"
          data-placement={placement()}
          data-mode={mode()}
          aria-label={label()}
          onClick={cycle}
        >
          <Icon name="shield" />
          <span>{LABEL[mode()]}</span>
        </button>
      </Tooltip>
    </Show>
  )
}

/** Build | Plan above the composer card on desktop/web, new session or existing: Plan is the plan agent in read-only Plan mode; Build is the
 *  last mode before Plan, else Default. Hidden when no plan agent is offered. */
export function KeteAgentSwitch(props: { model: ComposerModel }) {
  const state = useKeteMode(props.model)
  let before: Mode = "default"
  const choose = (choice: "build" | "plan") => {
    const target = switchTarget({ choice, current: state.mode(), before })
    if (!target) return
    before = target.before
    state.set(target.mode)
  }

  return (
    <Show when={agentSwitchVisible({ browser: homeLayout(), planAvailable: state.planAvailable() })}>
      <KeteAgentSwitchView planning={state.mode() === "plan"} onChoose={choose} />
    </Show>
  )
}
