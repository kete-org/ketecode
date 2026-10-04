// Structural tests for the new-session panel's layout: the scroll area (hero mark, tip, notices,
// CLI hint) sits above a footer pinned to the bottom (composer, project/workspace row).
//
// These parse source text rather than mounting the components (same technique as
// packages/kete-vscode/test/brand.test.ts's markRects()). packages/app's Solid components are
// authored with JSX, and this package's `bun test` setup has no working path to render JSX-authored
// components: every existing test that builds a live Solid tree (test-browser/solid-runtime.test.ts,
// composer-attachment-ownership.test.tsx) uses solid-js's non-JSX `createComponent()`/plain function
// calls in a .ts/.tsx file with no JSX literal in it, never `<Component/>` syntax — Bun's JSX
// transform here falls back to a classic React pragma (`ReferenceError: React is not defined`) for
// any file that contains JSX literal syntax, confirmed against both panel-layout.tsx and the
// pre-existing kete/mark.tsx, regardless of test file location or `--conditions`. Rewriting
// panel-layout.tsx to avoid JSX would be inconsistent with every other file under kete/ (panel.tsx,
// mark.tsx, wordmark.tsx) — flagged in handoff.md as an infra gap, not fixed here.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const layoutSource = fs.readFileSync(path.join(import.meta.dir, "panel-layout.tsx"), "utf8")
const viewSource = fs.readFileSync(path.join(import.meta.dir, "../new-session/view.tsx"), "utf8")

describe("KeteNewSessionLayout's own structure (panel-layout.tsx)", () => {
  test("panel-scroll (children) is a sibling that comes before panel-footer (footer), both inside panel-column", () => {
    const column = between(layoutSource, `data-kete="panel-column"`, `</div>\n  )`)
    const scrollIndex = column.indexOf(`data-kete="panel-scroll"`)
    const footerIndex = column.indexOf(`data-kete="panel-footer"`)
    expect(scrollIndex).toBeGreaterThan(-1)
    expect(footerIndex).toBeGreaterThan(-1)
    expect(scrollIndex).toBeLessThan(footerIndex)
  })

  test("panel-scroll renders props.children and panel-footer renders props.footer", () => {
    const scroll = between(layoutSource, `data-kete="panel-scroll"`, `</div>`)
    const footer = between(layoutSource, `data-kete="panel-footer"`, `</div>`)
    expect(scroll).toContain("{props.children}")
    expect(footer).toContain("{props.footer}")
  })
})

describe("new-session/view.tsx's use of KeteNewSessionLayout", () => {
  test("the scroll area (KeteNewSessionLayout's children) holds the hero mark/tip/notices, then the CLI hint, in that order", () => {
    const call = between(viewSource, "<KeteNewSessionLayout", "</KeteNewSessionLayout>")
    const footerPropEnd = call.indexOf("}\n          >")
    const children = call.slice(footerPropEnd)
    const emptyStateIndex = children.indexOf("<KeteEmptyState")
    const cliHintIndex = children.indexOf("<KeteCliHint")
    expect(emptyStateIndex).toBeGreaterThan(-1)
    expect(cliHintIndex).toBeGreaterThan(-1)
    expect(emptyStateIndex).toBeLessThan(cliHintIndex)
  })

  test("the footer prop holds the composer", () => {
    const call = between(viewSource, "<KeteNewSessionLayout", "</KeteNewSessionLayout>")
    const footerProp = between(call, "footer={", "\n          >")
    expect(footerProp).toContain("<Composer model={props.composer} />")
  })
})

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  const to = source.indexOf(end, from)
  expect(to).toBeGreaterThan(-1)
  return source.slice(from, to)
}
