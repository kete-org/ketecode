// Build | Plan as a segmented control (composer-controls.tsx's KeteAgentSwitch connects it to the
// composer). No app contexts, so a story can render it. Styled by panel.css.

import "./tokens.css"
import "./panel.css"

export function KeteAgentSwitchView(props: { planning: boolean; onChoose: (choice: "build" | "plan") => void }) {
  return (
    <div data-kete="agent-switch" role="radiogroup" aria-label="Agent">
      <button type="button" role="radio" aria-checked={!props.planning} onClick={() => props.onChoose("build")}>
        Build
      </button>
      <button type="button" role="radio" aria-checked={props.planning} onClick={() => props.onChoose("plan")}>
        Plan
      </button>
    </div>
  )
}
