// The Kete Code wordmark for the web UI, in place of upstream's OpenCode Logo and Wordmark. Same
// 720×129 box, so upstream's layouts and shimmer (new-session/wordmark.tsx) keep working. Set in
// Bricolage Grotesque 600 (tokens.css's "Kete Wordmark" @font-face, bundled from assets/brand/fonts —
// never loaded remotely); "Kete" in the current colour, "Code" a step fainter, split from
// `Brand.displayName` so the two names it's made of are never hard-coded here.

import { Brand } from "@opencode/util/kete/brand"
import "./tokens.css"

const [primary, ...rest] = Brand.displayName.split(" ")
const secondary = rest.join(" ")

export function KeteWordmark(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      data-component="kete-wordmark"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label={Brand.displayName}
    >
      <text
        x="360"
        y="98"
        text-anchor="middle"
        font-family="var(--kete-wordmark-font)"
        font-size="104"
        font-weight="600"
        letter-spacing="-1"
      >
        <tspan fill="currentColor">{primary}</tspan>
        {secondary && (
          <tspan fill="var(--kete-text-2, currentColor)" dx="14">
            {secondary}
          </tspan>
        )}
      </text>
    </svg>
  )
}
