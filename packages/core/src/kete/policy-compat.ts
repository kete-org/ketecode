// Upstream v2.1.4 renamed the config policy action "permission" (matched against `<permission action>:<resource>`)
// to "tool.use", and normalization now drops a statement with any other action. Kete's own policies were written
// with "permission" (`hooks:*`, `sandbox_off:*`; docs/context/modules/{hooks,sandbox}.md), so dropping them would
// quietly turn their deny rules off. They are read as "tool.use": the same statement under its new name.

export * as KetePolicyCompat from "./policy-compat.js"

/** `list` with each legacy `"permission"` statement renamed to `"tool.use"`; anything else is left as it is. */
export function upgrade(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map((item: unknown) =>
    typeof item === "object" && item !== null && "action" in item && item.action === "permission"
      ? { ...item, action: "tool.use" }
      : item,
  )
}
