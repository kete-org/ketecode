import { KeteWordmark } from "@/kete/wordmark" // kete_change: Kete Code wordmark in place of OpenCode's
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto w-4/5">
        <KeteWordmark class="block aspect-[720/129] w-full opacity-[0.16]" /> {/* kete_change */}
        <KeteWordmark class="wordmark-shimmer absolute inset-0 aspect-[720/129] w-full" /> {/* kete_change */}
      </div>
    </div>
  )
}
