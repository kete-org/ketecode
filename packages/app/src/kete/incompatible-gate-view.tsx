import { type JSX, Show } from "solid-js"

/** Shows `panel` in place of the page while a server is covered. Plain props so a story can drive it. */
export function KeteIncompatibleGateView(props: { covered: string | undefined; panel: JSX.Element; children: JSX.Element }) {
  return (
    <div data-kete="incompatible-gate" class="flex size-full min-h-0 min-w-0 flex-col">
      <Show when={props.covered} fallback={props.children}>
        {props.panel}
      </Show>
    </div>
  )
}
