// Raise or lower the model variant (reasoning effort) one step: Alt+. and Alt+, (parity C3, spec P6).
// `variant.cycle` (Ctrl+T) wraps around; these stop at the ends. The order is the model's variant list
// (low → high), with the model's default before the first one, as `cycleModelVariant` walks it.

import { normalizeModelVariant } from "../model-preference"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"

export const NEXT = "variant.next"
export const PREVIOUS = "variant.previous"

/** The variant one step up (+1) or down (-1) from `current`, or `current` itself at the ends. */
export function step(current: string | undefined, variants: readonly string[], direction: 1 | -1) {
  const steps = [undefined, ...variants.filter((variant) => variant !== "default")]
  const value = normalizeModelVariant(current)
  const index = Math.max(0, steps.indexOf(value))
  return steps[Math.min(steps.length - 1, Math.max(0, index + direction))]
}

export function useKeteVariantStep() {
  const local = useLocal()
  const move = (direction: 1 | -1) => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return
    const current = local.model.variant.current()
    const target = step(current, variants, direction)
    if (target !== normalizeModelVariant(current)) local.model.variant.set(target)
  }

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: NEXT, group: "Agent", title: "Raise model variant", bind: false, palette: true as const, run: () => move(1) },
      { id: PREVIOUS, group: "Agent", title: "Lower model variant", bind: false, palette: true as const, run: () => move(-1) },
    ],
  }))
  Keymap.createLayer(() => ({ bindings: [NEXT, PREVIOUS] }))
}
