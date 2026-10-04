// Generates the VS Code icon assets derived from packages/app/src/kete/mark.tsx's MARK_RECTS, the
// single source of the mark's geometry:
// - media/kete-mark.woff — the glyph behind the `kete-mark` product icon (contributes.icons in
//   package.json), monochrome, via a pinned dev tool (fantasticon) run through `bunx` — not a project
//   dependency (CLAUDE.md §4: prefer configuration/extension points before a new dependency; this
//   needs neither, so a one-off generator instead).
// - media/kete-tab-light.svg, media/kete-tab-dark.svg — the two-tone chat tab icon (WebviewPanel
//   iconPath), brand bars in the violet brand color, ink bars in ink-on-paper / paper-on-ink.
// Not part of the extension build: run by hand when the mark's geometry changes, then commit the
// regenerated files.
//
// Usage: bun run script/icon-font.ts   (from packages/kete-vscode/)

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const FANTASTICON_VERSION = "4.1.0"
const BRAND = "#6E47F5"
const INK_LIGHT = "#16141D"
const INK_DARK = "#F1EFF6"

const here = path.dirname(fileURLToPath(import.meta.url))
const markPath = path.join(here, "../../app/src/kete/mark.tsx")
const media = path.join(here, "../media")

// Same regex-based parse as test/brand.test.ts and test/icon-font.test.ts: a .tsx file can't be
// imported by a plain script without pulling in the Solid JSX runtime.
function markRects(source: string) {
  const start = source.indexOf("export const MARK_RECTS")
  const block = source.slice(start, source.indexOf("]\n", start))
  return [
    ...block.matchAll(/{ x: (\d+), y: (\d+), width: (\d+), height: (\d+), rx: (\d+), fill: "(brand|ink)" }/g),
  ].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    rx: Number(match[5]),
    fill: match[6] as "brand" | "ink",
  }))
}

const rects = markRects(readFileSync(markPath, "utf8"))
if (rects.length !== 8) throw new Error(`expected 8 rects in mark.tsx, found ${rects.length}`)

function tabSvg(inkColor: string) {
  const bars = rects
    .map((r) => `  <rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}" fill="${r.fill === "brand" ? BRAND : inkColor}"/>`)
    .join("\n")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n${bars}\n</svg>\n`
}

writeFileSync(path.join(media, "kete-tab-light.svg"), tabSvg(INK_LIGHT))
writeFileSync(path.join(media, "kete-tab-dark.svg"), tabSvg(INK_DARK))
console.log("Wrote media/kete-tab-light.svg, media/kete-tab-dark.svg")

// Monochrome font glyph: the fill color is irrelevant (svgicons2svgfont extracts outlines, not
// paint), so every bar (brand or ink) becomes one shape in the glyph.
const glyphSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
${rects.map((r) => `  <rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${r.rx}" fill="#000"/>`).join("\n")}
</svg>
`

const outputWoff = path.join(media, "kete-mark.woff")
const workDir = mkdtempSync(path.join(tmpdir(), "kete-icon-font-"))
const svgDir = path.join(workDir, "svg")
const outDir = path.join(workDir, "out")
mkdirSync(svgDir)
mkdirSync(outDir)
writeFileSync(path.join(svgDir, "kete-mark.svg"), glyphSvg)

try {
  // --font-height 512 matches the mark's own viewBox, so the glyph keeps the same proportions
  // (including its inherent padding) as every other rendering of MARK_RECTS.
  const run = Bun.spawnSync(
    [
      "bunx",
      "--bun",
      `fantasticon@${FANTASTICON_VERSION}`,
      svgDir,
      "-o",
      outDir,
      "-n",
      "kete-mark",
      "-t",
      "woff",
      "-g",
      "json",
      "--font-height",
      "512",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (run.exitCode !== 0) {
    throw new Error(`fantasticon@${FANTASTICON_VERSION} failed (exit ${run.exitCode}):\n${run.stderr.toString()}`)
  }

  const codepoints = JSON.parse(readFileSync(path.join(outDir, "kete-mark.json"), "utf8")) as Record<string, number>
  const codepoint = codepoints["kete-mark"]
  if (typeof codepoint !== "number") throw new Error("fantasticon did not report a codepoint for kete-mark")

  copyFileSync(path.join(outDir, "kete-mark.woff"), outputWoff)

  const fontCharacter = `\\${codepoint.toString(16)}`
  console.log(`Wrote ${path.relative(process.cwd(), outputWoff)}`)
  console.log(
    `fontCharacter: "${fontCharacter}" — must match packages/kete-vscode/package.json's ` +
      `contributes.icons.kete-mark.default.fontCharacter.`,
  )
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
