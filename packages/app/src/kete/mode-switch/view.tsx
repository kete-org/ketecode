// Code | Work as a radiogroup (mode-switch.tsx connects it). No app contexts, so a story can render it;
// the strings come in as props. Only the checked radio is in the tab order; the arrow keys move to the
// next available radio and select it. An unavailable mode stays visible, disabled, with a hint.

import { For } from "solid-js"
import { KeteModeSwitch } from "./state"
import "../tokens.css"
import "../sidebar/sidebar.css"

export function KeteModeSwitchView(props: {
  modes: readonly KeteModeSwitch.Mode[]
  selected: string
  label: string
  unavailable: string
  onSelect: (id: string) => void
}) {
  const move = (event: KeyboardEvent, direction: 1 | -1) => {
    event.preventDefault()
    const next = KeteModeSwitch.step(props.modes, props.selected, direction)
    if (next === props.selected) return
    props.onSelect(next)
    ;(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus()
  }
  return (
    <div data-kete="mode-switch-wrap">
      <div data-kete="mode-switch" role="radiogroup" aria-label={props.label}>
        <For each={props.modes}>
          {(mode) => (
            <button
              type="button"
              role="radio"
              data-mode={mode.id}
              aria-checked={props.selected === mode.id}
              aria-disabled={mode.available ? undefined : "true"}
              aria-describedby={mode.available ? undefined : `kete-mode-hint-${mode.id}`}
              tabindex={props.selected === mode.id ? 0 : -1}
              onClick={() => mode.available && props.onSelect(mode.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") move(event, 1)
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(event, -1)
              }}
            >
              {mode.name}
            </button>
          )}
        </For>
      </div>
      <For each={props.modes.filter((mode) => !mode.available)}>
        {(mode) => (
          <span data-kete="mode-hint" id={`kete-mode-hint-${mode.id}`}>
            {props.unavailable}
          </span>
        )}
      </For>
    </div>
  )
}
