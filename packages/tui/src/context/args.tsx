import { mergeProps } from "solid-js"
import { createSimpleContext } from "./helper"
import type { KetePermissionModes } from "@opencode/util/kete/permission-mode" // kete_change

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  newSessionID?: string
  fork?: boolean
  auto?: boolean
  permissionMode?: KetePermissionModes.Mode // kete_change: --permission-mode / --auto (kete/permission-mode.tsx)
  addDirs?: string[] // kete_change: --add-dir folders, absolute (kete/add-dir.tsx)
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => {
    // The first new session created from home takes this ID; later ones mint their own.
    let pending = props.newSessionID
    return mergeProps(props, {
      takeNewSessionID() {
        const id = pending
        pending = undefined
        return id
      },
      restoreNewSessionID(id: string) {
        pending ??= id
      },
    })
  },
})
