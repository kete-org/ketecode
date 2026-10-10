// The default TUI theme is presented as "kete". It is upstream's built-in default theme, registered
// under both names (theme/index.ts): "kete" is the default and appears in the theme picker, while
// "opencode" stays an alias so existing configs and saved settings keep working.
//
// Its colours come from ./theme.json, not upstream's assets/v2/opencode.json: the same document with
// Kete Code's brand colour as the primary: violet #6E47F5 on light backgrounds and its lighter tint
// #A38CFA on dark ones (step 200 of each mode's violet scale), as in the web UI's theme
// (ui/src/theme/kete/theme.ts). It adds a violet hue scale and makes it the interactive hue and the
// first categorical hue (the first agent's colour and the prompt's bar) in both modes. Regenerate it from upstream's asset after an upstream sync changes that file.

export const defaultTheme = "kete"
export const legacyDefault = "opencode"

/**
 * The theme to use for a configured or saved name: "opencode" means "kete", unless a custom or
 * plugin theme has taken the name "opencode" (then it is that theme, as before).
 */
export function canonicalTheme(name: string, themes: Record<string, unknown>) {
  return name === legacyDefault && themes[legacyDefault] === themes[defaultTheme] ? defaultTheme : name
}

/** Theme names for the picker: the "opencode" alias is hidden while it is the same theme as "kete". */
export function pickerThemes(themes: Record<string, unknown>) {
  return Object.keys(themes).filter((name) => canonicalTheme(name, themes) === name)
}

export * as KeteTheme from "./theme"
