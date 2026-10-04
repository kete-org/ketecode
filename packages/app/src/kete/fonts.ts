// The wordmark font's licence, bundled so its URL is emitted next to the font (see tokens.css) and
// linked from Settings → About. `?url` makes Vite resolve and hash the file into dist/_assets, the
// same as the woff2 itself; imported from a module (not referenced from a CSS url()) since About is
// TSX, not CSS.

import licenceUrl from "../../../../assets/brand/fonts/OFL.txt?url"

export const wordmarkFont = {
  name: "Bricolage Grotesque",
  licence: "SIL Open Font License 1.1",
  licenceUrl,
} as const
