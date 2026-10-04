import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, type JSX } from "solid-js"
import { Logo } from "../component/logo"
import { useTheme } from "../context/theme"

/**
 * The Kete mark (assets/brand/kete-logo-512.png, packages/app/src/kete/mark.tsx) as terminal pixel
 * art: four columns (narrow, wide, wide, narrow) and four bands (narrow, wide, wide, narrow) with
 * one-pixel gaps, so the short ink bars stand apart as in the artwork. "K" is an ink bar (the
 * theme's text colour), "P" a brand bar, "." empty. Two pixel rows make one terminal line (half
 * blocks), so the mark is 9 columns by 5 lines.
 */
export const MARK_PIXELS = [
  "..KK.KK..",
  ".....KK..",
  "PPPPPKK.P",
  "PPPPPKK.P",
  "..KK.KK..",
  "P.KKPPPPP",
  "P.KKPPPPP",
  "..KK.....",
  "..KK.KK..",
] as const

/** The brand colour, fixed like the portal's and the web UI's mark (not a theme hue). */
export const BRAND = RGBA.fromHex("#6e47f5")

type Pixel = "K" | "P" | "."
export type MarkCell = { char: string; fg?: "K" | "P"; bg?: "K" | "P" }

/** One terminal line from two pixel rows: upper and lower half blocks, or a full block. */
export function markCells(top: string, bottom: string): MarkCell[] {
  return Array.from(top).map((char, i) => {
    const upper = char as Pixel
    const lower = (bottom[i] ?? ".") as Pixel
    if (upper === "." && lower === ".") return { char: " " }
    if (lower === ".") return { char: "▀", fg: upper as "K" | "P" }
    if (upper === ".") return { char: "▄", fg: lower }
    if (upper === lower) return { char: "█", fg: upper }
    return { char: "▀", fg: upper, bg: lower }
  })
}

export function markLines(): MarkCell[][] {
  const lines: MarkCell[][] = []
  for (let row = 0; row < MARK_PIXELS.length; row += 2) lines.push(markCells(MARK_PIXELS[row]!, MARK_PIXELS[row + 1] ?? ""))
  return lines
}

export function KeteMark(): JSX.Element {
  const theme = useTheme()
  const color = (pixel: "K" | "P" | undefined) => (pixel === "K" ? theme.text.base : pixel === "P" ? BRAND : undefined)
  return (
    <box>
      <For each={markLines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(cell) => (
                <text fg={color(cell.fg)} bg={color(cell.bg)} selectable={false}>
                  {cell.char}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

/** Upstream's wordmark with the mark beside it when the terminal is wide and tall enough. */
export function KeteLogo(): JSX.Element {
  const dimensions = useTerminalDimensions()
  return (
    <box flexDirection="row" gap={3} alignItems="flex-end">
      <Show when={dimensions().width >= 56 && dimensions().height >= 12}>
        <KeteMark />
      </Show>
      <Logo />
    </box>
  )
}
