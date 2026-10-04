// The Kete Code mark: eight rounded bars weaving an interlocking "K" shape. The single source of
// geometry for every rendering of the mark — the inline SVG below, the VS Code activity-bar icon
// (packages/kete-vscode/media/kete.svg, kept in lockstep by kete-vscode/test/brand.test.ts) and the
// favicon in index.html. See docs/design/kete-code-panel.html:269-278 for the original artwork.

import { Brand } from "@opencode/util/kete/brand"

export type MarkRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rx: number
  /** "brand" bars use `var(--kete-brand)`; "ink" bars use `currentColor`. */
  readonly fill: "brand" | "ink"
}

export const MARK_VIEWBOX = "0 0 512 512"

export const MARK_RECTS: readonly MarkRect[] = [
  { x: 121, y: 61, width: 105, height: 37, rx: 10, fill: "ink" },
  { x: 286, y: 61, width: 105, height: 202, rx: 12, fill: "ink" },
  { x: 61, y: 121, width: 202, height: 105, rx: 12, fill: "brand" },
  { x: 414, y: 121, width: 37, height: 105, rx: 10, fill: "brand" },
  { x: 121, y: 249, width: 105, height: 202, rx: 12, fill: "ink" },
  { x: 61, y: 286, width: 37, height: 105, rx: 10, fill: "brand" },
  { x: 249, y: 286, width: 202, height: 105, rx: 12, fill: "brand" },
  { x: 286, y: 414, width: 105, height: 37, rx: 10, fill: "ink" },
]

export function KeteMark(props: { class?: string; decorative?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_VIEWBOX}
      data-component="kete-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      role={props.decorative ? undefined : "img"}
      aria-hidden={props.decorative ? "true" : undefined}
      aria-label={props.decorative ? undefined : Brand.displayName}
    >
      {MARK_RECTS.map((rect) => (
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={rect.rx}
          fill={rect.fill === "brand" ? "var(--kete-brand)" : "currentColor"}
        />
      ))}
    </svg>
  )
}
