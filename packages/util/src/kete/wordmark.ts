// The Kete Code logo as a self-contained SVG string, for pages served without assets (the OAuth
// callback page): the mark beside the name. The mark's bars are packages/app/src/kete/mark.tsx's
// MARK_RECTS (kept in lockstep by packages/core/test/kete/oauth-page.test.ts); ink bars and the
// name use the page's colour (currentColor), brand bars the brand violet.

import { displayName } from "./brand.js"

const BRAND = "#6e47f5"

// [x, y, width, height, rx, brand?] on the mark's 512 grid.
const MARK: readonly (readonly [number, number, number, number, number, boolean])[] = [
  [121, 61, 105, 37, 10, false],
  [286, 61, 105, 202, 12, false],
  [61, 121, 202, 105, 12, true],
  [414, 121, 37, 105, 10, true],
  [121, 249, 105, 202, 12, false],
  [61, 286, 37, 105, 10, true],
  [249, 286, 202, 105, 12, true],
  [286, 414, 105, 37, 10, false],
]

const bars = MARK.map(
  ([x, y, width, height, rx, brand]) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${brand ? BRAND : "currentColor"}"/>`,
).join("")

// textLength keeps the name inside the box whatever system font the browser picks.
export const wordmarkSvg = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="40 40 1960 432" role="img" aria-label="${displayName}">${bars}<text x="560" y="372" textLength="1400" lengthAdjust="spacingAndGlyphs" fill="currentColor" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="320" font-weight="600">${displayName}</text></svg>`
