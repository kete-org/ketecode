import { createSimpleContext } from "./helper"
import type { KetePermissionModes } from "@opencode/util/kete/permission-mode" // kete_change

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
  permissionMode?: KetePermissionModes.Mode // kete_change: --permission-mode / --auto (kete/permission-mode.tsx)
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
