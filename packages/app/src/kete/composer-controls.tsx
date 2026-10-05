// The two Kete controls the composer's toolbar renders through `ComposerEditor`'s `kete` slot
// (composer/editor/editor.tsx): the commands button next to the `+` menu, and the Auto/Ask/Plan
// toggle next to send. Both take the composer's `ComposerModel` and wire themselves to the route
// (which session, or which new-session draft, is open) and the server SDK — composer.tsx only
// passes them through, so its own edit stays a couple of lines.

import { createMemo } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import type { ComposerModel } from "@/composer/model"
import { useData, useServer } from "@/runtime/server/current"
import { apply, derive, KeteModeDraft, next as nextMode, PLAN_AGENT, type ApplyAgent, type Mode } from "./mode"
import { useKeteNoToolsNotice } from "./local-ui"

const MODE_LABEL: Readonly<Record<Mode, string>> = { auto: "Auto", ask: "Ask", plan: "Plan" }

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

export function KeteModeToggle(props: { model: ComposerModel }) {
  const server = useServer()
  const data = useData()
  const { sessionID, draftID } = useComposerSessionKey()
  // Once per session, for a model that can't call tools: it can only answer (local-ui.tsx).
  useKeteNoToolsNotice({ sessionID, model: () => props.model.model.selection.current() })

  const agentView = () => props.model.view.agent
  const planAvailable = createMemo(() => agentView()?.options().some((option) => option.id === PLAN_AGENT) ?? false)
  const metadata = createMemo(() => {
    const id = sessionID()
    return id ? data.session.get(id)?.metadata : undefined
  })
  const mode = createMemo<Mode>(() => derive({ agent: agentView()?.current(), metadata: metadata() }))

  const applyAgent = (): ApplyAgent => {
    const view = agentView()
    return {
      // No agent switcher at all (a single-agent composer) means Plan is never offered
      // (planAvailable is false), so this fallback is never actually compared against "plan".
      current: () => view?.current() ?? "",
      options: () => view?.options().map((option) => option.id) ?? [],
      select: (name) => view?.onSelect(name),
    }
  }

  const cycle = () => {
    const target = nextMode(mode(), planAvailable())
    const id = sessionID()
    if (id) {
      void apply({ sdk: server.ctx.sdk.api, sessionID: id, mode: target, agent: applyAgent() })
      return
    }
    // No session yet: Plan is an agent choice, applied to the draft's selection right away; Auto/Ask
    // wait in KeteModeDraft for session.create (new-session/composer-adapter.ts) to carry it in atomically.
    const view = agentView()
    if (target === "plan") view?.onSelect(PLAN_AGENT)
    else if (view?.current() === PLAN_AGENT) {
      const fallback = view.options().find((option) => option.id !== PLAN_AGENT)?.id
      if (fallback) view.onSelect(fallback)
    }
    const draft = draftID()
    if (draft) KeteModeDraft.set(draft, target)
  }

  const label = () => `Permission mode: ${MODE_LABEL[mode()]}`

  return (
    <Tooltip placement="top" value={label()}>
      <button type="button" data-kete="mode-toggle" data-mode={mode()} aria-label={label()} onClick={cycle}>
        <Icon name="shield" />
        <span>{MODE_LABEL[mode()]}</span>
      </button>
    </Tooltip>
  )
}
