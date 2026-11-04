import { useLanguage } from "@opencode/app/desktop"
import { Brand } from "@opencode/util/kete/brand"
import { Loader } from "@opencode/ui/loader"
import { showToast, toaster, Toast } from "@opencode/ui/toast"
import { createRoot, onCleanup } from "solid-js"
import { listen } from "../ipc-client"
import type { ServerReadyData } from "../../shared/ipc-contract"
import { createSidecarStatus } from "./sidecar-status-state"

export function KeteSidecarStatus(props: {
  current: () => ServerReadyData | undefined
  update: (data: ServerReadyData) => void
}) {
  const language = useLanguage()
  const text = (key: "toast.kete.sidecar.restarting" | "toast.kete.sidecar.restarted") =>
    language.t(key, { product: Brand.displayName })
  let toastID: number | undefined
  let disposeToast: (() => void) | undefined

  const status = createSidecarStatus({
    current: props.current,
    update: props.update,
    toast: () => showToast({ title: text("toast.kete.sidecar.restarted") }),
    notice: {
      show: () => {
        toastID = toaster.show(
          ({ toastId }) =>
            createRoot((dispose) => {
              disposeToast?.()
              disposeToast = dispose

              return (
                <Toast toastId={toastId}>
                  <div data-slot="toast-v2-header" class="col-span-full">
                    <Toast.Icon>
                      <Loader />
                    </Toast.Icon>
                    <Toast.Content>
                      <Toast.Title dir="auto">{text("toast.kete.sidecar.restarting")}</Toast.Title>
                    </Toast.Content>
                  </div>
                </Toast>
              )
            }),
          { persistent: true },
        )
      },
      hide: () => {
        if (toastID !== undefined) toaster.dismiss(toastID)
        toastID = undefined
        disposeToast?.()
        disposeToast = undefined
      },
    },
  })

  const stops = [
    listen("KeteSidecarRestarting", () => status.restarting()),
    listen("KeteSidecarReady", (event) => status.ready({ url: event.url })),
  ]

  onCleanup(() => {
    for (const stop of stops) stop()
    // Dismiss a notice still up when the window goes away.
    if (toastID !== undefined) toaster.dismiss(toastID)
    disposeToast?.()
  })

  return null
}
