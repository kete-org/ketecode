// Which server the app-wide "this server version isn't supported" panel covers (incompatible-gate.tsx).
// Session and draft routes show the panel themselves; settings stays reachable so the user can remove or
// switch the server. Elsewhere the current server is the Home's focused one: the selected server if it is
// visible, else the first visible one (home/model.ts).

export function coveredServer(input: {
  route: { readonly type: string }
  selected: string | undefined
  visible: readonly string[]
  health: Readonly<Record<string, { readonly incompatible?: boolean } | undefined>>
}): string | undefined {
  if (input.route.type === "session" || input.route.type === "draft" || input.route.type === "settings") return
  const key = input.visible.find((visible) => visible === input.selected) ?? input.visible[0]
  return key !== undefined && input.health[key]?.incompatible ? key : undefined
}
