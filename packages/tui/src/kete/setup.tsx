// First-run setup in the TUI (docs/local-models.md, README "Get started"): one screen offering
// sign-in, your own API key, or a local model, shown once when nothing is set up (no provider, no
// signed-in account, no model). `useKeteSetup()` (called from useKeteLocalModels in the app shell)
// decides when to show it and registers `/setup`; the first-run local-model offer waits for that
// decision. Esc or "Skip for now" counts as done, so it shows once; `/setup` reopens it. Sign-in
// runs `kete login` as a child process (./setup-login.ts); the key never passes through the TUI.

import { KeteSyncRpc } from "@opencode/schema/kete/sync"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteOffline } from "@opencode/util/kete/offline"
import { KeteSetup } from "@opencode/util/kete/setup"
import { Schema } from "effect"
import { createEffect, createResource, createSignal, onCleanup, Show, untrack } from "solid-js"
import { DialogIntegration } from "../component/dialog-integration"
import { DialogModel } from "../component/dialog-model"
import { useArgs } from "../context/args"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useLog } from "../context/log"
import { useStorage } from "../context/storage"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { hasConnectedProvider } from "../util/connected-provider"
import { canCallTools, fetchStatus, KeteLocalPicker, offlineFrom, rediscover } from "./local-models"
import { SetupLogin } from "./setup-login"

export const STORAGE_KEY = "kete-setup"
export const COMMAND = "kete.setup"
/** How long to wait for the gateway's models after signing in. */
const MODELS_TIMEOUT = 30_000

const decodeSync = Schema.decodeUnknownPromise(KeteSyncRpc.Status)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const FALLBACK_HINT = {
  ollama: "Start it with `ollama serve`, then check again.",
  lmstudio: "Start LM Studio's local server, then check again.",
  vllm: "Start vLLM's OpenAI-compatible server, then check again.",
} as const

function useDone() {
  const log = useLog({ component: "kete.setup" })
  const [state, update] = useStorage().store<{ done: boolean }>(STORAGE_KEY, { initial: { done: false } })
  return {
    done: () => state.done === true,
    mark: () =>
      update((draft) => {
        draft.done = true
      }).catch((error: unknown) =>
        log.warn("setup choice not saved", { error: error instanceof Error ? error.message : String(error) }),
      ),
  }
}

export function useKeteSetup() {
  const args = useArgs()
  const client = useClient()
  const data = useData()
  const local = useLocal()
  const location = useLocation()
  const dialog = useDialog()
  const log = useLog({ component: "kete.setup" })
  const state = useDone()
  const [decided, setDecided] = createSignal(false)
  const [shown, setShown] = createSignal(false)

  let checked = false
  createEffect(() => {
    if (checked || !local.model.ready || !local.model.catalogReady) return
    // A job has no person to set up for (spec); the TUI isn't started there today.
    if (KeteJobMode.enabled()) {
      checked = true
      return setDecided(true)
    }
    const config = data.location.config.list(location.ref)
    const integrations = data.location.integration.list(location.ref)
    if (config === undefined || integrations === undefined) return
    checked = true
    untrack(() => {
      const hasModel =
        !!args.model ||
        config.some((entry) => entry.type === "document" && entry.info.model !== undefined) ||
        local.model.recent().length > 0 ||
        local.model.favorite().length > 0
      const provider = hasConnectedProvider(integrations)
      // Nothing to ask the runtime when setup is already done, a provider is connected or a model is chosen.
      if (!KeteSetup.shouldShow({ done: state.done(), connected: provider, hasModel })) return setDecided(true)
      client.api.rpc
        .call(
          { rpcID: KeteSyncRpc.ID, method: "status", input: {}, location: location.ref },
          { signal: AbortSignal.timeout(15_000) },
        )
        .then((response) => decodeSync(response.output))
        .then((sync) => {
          if (!KeteSetup.shouldShow({ done: state.done(), connected: provider || sync.signedIn, hasModel })) return
          setShown(true)
          dialog.replace(() => <KeteSetupDialog />)
        })
        // Advisory, like the home notices: without the account state the screen doesn't show.
        .catch((error: unknown) =>
          log.debug("setup not shown: sync status unavailable", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => setDecided(true))
    })
  })

  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        group: "System",
        title: "Set up Kete Code",
        bind: false,
        palette: true as const,
        slash: { name: "setup" },
        run: () => dialog.replace(() => <KeteSetupDialog />),
      },
    ],
  }))
  Keymap.createLayer(() => ({ bindings: [COMMAND] }))

  return { decided, shown }
}

/** What every setup view shares: the catalog's models and how a choice finishes setup. */
function useSetup() {
  const client = useClient()
  const data = useData()
  const local = useLocal()
  const location = useLocation()
  const dialog = useDialog()
  const toast = useToast()
  const state = useDone()
  const models = () =>
    (data.location.model.list(location.ref) ?? []).map((model) => ({
      providerID: model.providerID,
      id: model.id,
      tools: canCallTools(model),
    }))
  return {
    client,
    data,
    location,
    dialog,
    toast,
    state,
    models,
    finish(model: { providerID: string; id: string }) {
      local.model.set({ providerID: model.providerID, modelID: model.id }, { recent: true })
      void state.mark()
      toast.show({ variant: "success", message: `Using ${model.providerID}/${model.id}.` })
      dialog.clear()
    },
    skip() {
      void state.mark()
      dialog.clear()
    },
    // Each view is its own dialog (as upstream's dialogs do), so leaving one cleans it up.
    rows: () => dialog.replace(() => <KeteSetupDialog />),
  }
}

export function KeteSetupDialog() {
  const setup = useSetup()
  const [status] = createResource(() => fetchStatus(setup.client.api, setup.location.ref).catch(() => undefined))
  const offline = () => offlineFrom(KeteOffline.enabled(), setup.data.location.config.list(setup.location.ref))

  function ownKey() {
    setup.dialog.replace(() => (
      <DialogIntegration
        onConnected={(providerID) => {
          void setup.state.mark()
          setup.dialog.replace(() => <DialogModel providerID={providerID} />)
        }}
      />
    ))
  }

  return (
    <DialogSelect
      title="Set up Kete Code"
      renderFilter={false}
      options={KeteSetup.rows({ offline: offline(), status: status() }).map((row) => ({
        title: row.title,
        description: row.description,
        value: row.id as string,
      }))}
      onCancel={setup.skip}
      onSelect={(option) => {
        if (option.value === "signin") return setup.dialog.replace(() => <SetupSignIn />)
        if (option.value === "key") return ownKey()
        if (option.value === "local") return setup.dialog.replace(() => <SetupLocal />)
        setup.skip()
      }}
    />
  )
}

/** Sign-in: runs `kete login` while shown; leaving the view (Cancel, Esc, another dialog) kills it. */
function SetupSignIn() {
  const setup = useSetup()
  const theme = useTheme().surface("dialog")
  const [url, setUrl] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const run = SetupLogin.start({ onURL: setUrl })
  onCleanup(() => run.cancel())

  async function gatewayModel() {
    const deadline = Date.now() + MODELS_TIMEOUT
    while (Date.now() < deadline) {
      const model = KeteLocalPicker.pick(setup.models(), "kete")
      if (model) return model
      await sleep(500)
    }
    return undefined
  }

  void run.result.then(async (result) => {
    if (result.kind === "cancelled") return
    if (result.kind === "failed") {
      setup.toast.show({ variant: "error", message: result.reason })
      setup.rows()
      return
    }
    setLoading(true)
    try {
      await setup.client.api.location.reload()
      const model = await gatewayModel()
      if (model) return setup.finish(model)
      void setup.state.mark()
      setup.toast.show({ variant: "info", message: "Signed in. Pick a model with /models." })
      setup.dialog.clear()
    } catch (error) {
      setup.toast.error(error)
      setup.rows()
    }
  })

  return (
    <DialogSelect
      title="Sign in to Kete Code"
      renderFilter={false}
      options={[{ title: "Cancel", value: "cancel" }]}
      footer={
        <box flexDirection="column">
          <Show when={!loading()} fallback={<text fg={theme.text.muted}>Signed in. Loading models…</text>}>
            <text fg={theme.text.muted}>Waiting for approval in your browser…</text>
            <Show when={url()}>{(link) => <text fg={theme.text.muted}>{link()}</text>}</Show>
          </Show>
        </box>
      }
      onCancel={setup.rows}
      onSelect={setup.rows}
    />
  )
}

/** The local servers found, or how to start one. */
function SetupLocal() {
  const setup = useSetup()
  const [status, { refetch }] = createResource(() => fetchStatus(setup.client.api, setup.location.ref).catch(() => undefined))

  async function checkAgain() {
    try {
      await rediscover(setup.client.api, setup.location.ref)
      await refetch()
    } catch (error) {
      setup.toast.error(error)
    }
  }

  function chooseLocal(id: string) {
    const model = KeteLocalPicker.pick(setup.models(), id)
    if (model) return setup.finish(model)
    setup.toast.show({
      variant: "warning",
      message: `${KeteLocalPicker.isLocal(id) ? KeteLocalPicker.providers[id] : id} isn't listing its models yet. Pick one with /models in a moment.`,
    })
  }

  const options = () => {
    const providers = status()?.providers
    const ready = (providers ?? []).filter((item) => item.state === "reachable" && (item.models ?? 0) > 0)
    const found = ready.map((item) => ({
      title: `${KeteLocalPicker.providers[item.id]} · ${item.models} ${item.models === 1 ? "model" : "models"}`,
      description: item.url,
      value: `use:${item.id}`,
    }))
    const missing =
      ready.length > 0
        ? []
        : (["ollama", "lmstudio", "vllm"] as const).map((id) => ({
            title: `${KeteLocalPicker.providers[id]} isn't running`,
            description: (providers?.find((item) => item.id === id)?.hint ?? FALLBACK_HINT[id]).replaceAll("`", ""),
            value: "info",
          }))
    return [...found, ...missing, { title: "Check again", value: "again" }, { title: "Back", value: "back" }]
  }

  return (
    <DialogSelect
      title="Use a local model"
      renderFilter={false}
      options={options()}
      onCancel={setup.rows}
      onSelect={(option) => {
        if (option.value === "back") return setup.rows()
        if (option.value === "again") return void checkAgain()
        if (option.value.startsWith("use:")) chooseLocal(option.value.slice(4))
      }}
    />
  )
}
