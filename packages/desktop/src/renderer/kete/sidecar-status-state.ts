import type { ServerReadyData } from "../../shared/ipc-contract"

// What the user sees while main restarts the runtime service. The connector wires `notice` and `toast` to the
// toaster; the stream resumes on its own reconnect, so the only state to change is a new origin.
export function createSidecarStatus(input: {
  notice: { show: () => void; hide: () => void }
  toast: () => void
  current: () => ServerReadyData | undefined
  update: (data: ServerReadyData) => void
}) {
  let showing = false

  return {
    restarting() {
      if (showing) return
      showing = true
      input.notice.show()
    },
    ready(data: ServerReadyData) {
      if (showing) input.notice.hide()
      showing = false
      input.toast()

      if (input.current()?.url !== data.url) input.update(data)
    },
  }
}
