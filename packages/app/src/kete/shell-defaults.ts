import { currentHost, type IdeHost } from "./ide-host"

/** Desktop and browser get the vertical sidebar; the editor webviews are too narrow for it. */
export function keteDefaultTabLayout(host: IdeHost | undefined = currentHost()): "horizontal" | "vertical" {
  return host ? "horizontal" : "vertical"
}
