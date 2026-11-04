// The new-session panel's own layout: a scroll area (hero mark, tip, notices, CLI hint) above a
// footer pinned to the bottom of the panel (composer, project/workspace row). Kete-owned so the
// split lives here instead of restructuring new-session/view.tsx beyond swapping in this one
// wrapper. Styled by panel.css's [data-kete="panel-column"]/"panel-scroll"/"panel-footer" rules —
// the column never exceeds 680px and stays centered at every width down to 300px. In the desktop/web
// app (`data-kete-layout="home"`) the greeting and the composer card sit together in the middle.

import type { JSX } from "solid-js"
import { homeLayout } from "./panel-state"
import "./panel.css"

export function KeteNewSessionLayout(props: { children: JSX.Element; footer: JSX.Element }) {
  return (
    <div data-kete="panel-column" data-kete-layout={homeLayout() ? "home" : undefined}>
      <div data-kete="panel-scroll">{props.children}</div>
      <div data-kete="panel-footer">{props.footer}</div>
    </div>
  )
}
