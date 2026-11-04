import { createSignal } from "solid-js"
import { KeteAgentSwitchView } from "./agent-switch"
import { KeteSidebarView, type SidebarSession } from "./sidebar/view"

export default {
  id: "app-kete-shell",
  title: "App/Kete/Shell",
}

// A fixed clock in local time, so the relative times read the same everywhere.
const now = new Date(2026, 10, 10, 15, 30).getTime()
const sessions: SidebarSession[] = Array.from({ length: 10 }, (_, index) => ({
  id: `s${index}`,
  title: `Session ${index}`,
  time: now - (index + 1) * 5 * 60_000,
}))

function SidebarStory() {
  const [current, setCurrent] = createSignal<string | undefined>("s1")
  const [last, setLast] = createSignal("")
  return (
    <div style={{ width: "280px", height: "640px", display: "flex", "flex-direction": "column" }}>
      <KeteSidebarView
        total={sessions.length}
        sessions={sessions.slice(0, 8)}
        more
        projects={[
          { name: "alpha", count: sessions.length, sessions: sessions.slice(0, 3) },
          { name: "beta", count: 0, sessions: [] },
        ]}
        currentId={current()}
        now={now}
        onSearch={() => setLast("search")}
        onNewSession={() => setLast("new")}
        onSettings={() => setLast("settings")}
        onOpen={(id) => setCurrent(id)}
        onMore={() => setLast("more")}
      />
      <output data-testid="last">{last()}</output>
    </div>
  )
}

function AgentSwitchStory(props: { planning?: boolean }) {
  const [planning, setPlanning] = createSignal(props.planning ?? false)
  return <KeteAgentSwitchView planning={planning()} onChoose={(choice) => setPlanning(choice === "plan")} />
}

export const Sidebar = {
  render: () => <SidebarStory />,
}

export const AgentSwitch = {
  render: () => <AgentSwitchStory />,
}

// An existing session already in Plan: the switch opens on Plan and Build leaves it.
export const AgentSwitchInPlan = {
  render: () => <AgentSwitchStory planning />,
}
