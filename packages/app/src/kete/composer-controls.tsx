// The two Kete controls the composer's toolbar renders through `ComposerEditor`'s `kete` slot
// (composer/editor/editor.tsx): the commands button next to the `+` menu, and the permission-mode
// toggle (Default/Auto/Ask/Plan, kete/mode.ts) next to send. Both take the composer's `ComposerModel` and wire themselves to the route
// (which session, or which new-session draft, is open) and the server SDK — composer.tsx only
// passes them through, so its own edit stays a couple of lines.

import { createMemo, createSignal } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
import type { ComposerModel } from "@/composer/model"
import { useData, useServer } from "@/runtime/server/current"
import { apply, derive, DESCRIPTION, KeteModeDraft, LABEL, next as nextMode, selectAgent, type ApplyAgent, type Mode } from "./mode"
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

export function KeteModeToggle(props: { model: ComposerModel }) {
  const server = useServer()
  const data = useData()
  const { sessionID, draftID } = useComposerSessionKey()
  // Once per session, for a model that can't call tools: it can only answer (local-ui.tsx).
  useKeteNoToolsNotice({ sessionID, model: () => props.model.model.selection.current() })

  const agentView = () => props.model.view.agent
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

  const applyAgent = (): ApplyAgent => {
    const view = agentView()
    return {
      // No agent switcher at all (a single-agent composer): Plan is then only the permission mode.
      current: () => view?.current() ?? "",
      options: () => view?.options().map((option) => option.id) ?? [],
      select: (name) => view?.onSelect(name),
    }
  }

  const cycle = () => {
    const target = nextMode(mode())
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

  const label = () => `Permission mode: ${LABEL[mode()]}. ${DESCRIPTION[mode()]}`

  return (
    <Tooltip placement="top" value={label()}>
      <button type="button" data-kete="mode-toggle" data-mode={mode()} aria-label={label()} onClick={cycle}>
        <Icon name="shield" />
        <span>{LABEL[mode()]}</span>
      </button>
    </Tooltip>
  )
}
