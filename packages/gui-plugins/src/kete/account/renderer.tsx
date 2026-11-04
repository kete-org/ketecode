import { lazy, Suspense } from "solid-js"
import { SettingsPage, type Plugin } from "@opencode/plugin/gui"
import type definition from "./index"

// Settings -> Account. Not gated on `ctx.desktop`: the web UI on the same machine gets it too. It talks to
// the app's own server (the desktop's builtin one), else a local one; the server's account gate refuses
// credential changes unless it is local-only (server/src/kete/account-gate.ts).
const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const Page = lazy(() => import("./page"))
  const server = () => {
    const refs = ctx.servers.list().map((id) => ctx.servers.get(id))
    return refs.find((ref) => ref?.builtin) ?? refs.find((ref) => ref?.local)
  }

  ctx.add(SettingsPage, {
    id: "kete-account",
    icon: "shield",
    get title() {
      return ctx.t("title")
    },
    get entries() {
      return [{ id: "kete-account", title: ctx.t("title"), description: ctx.t("description"), keywords: "sign in login logout organization" }]
    },
    render: () => (
      <Suspense>
        <Page server={server} />
      </Suspense>
    ),
  })
}

export default setup
