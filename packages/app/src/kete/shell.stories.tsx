import { createSignal } from "solid-js"
import { KeteAgentSwitchView } from "./agent-switch"
import { KeteIncompatibleGateView } from "./incompatible-gate-view"
import { KeteModeSwitchView } from "./mode-switch/view"
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

function ModeSwitchStory(props: { workAvailable: boolean }) {
  const modes = [
    { id: "code" as const, name: "Code", description: "", agent: "build", available: true },
    { id: "work" as const, name: "Work", description: "", agent: "work-orchestrator", available: props.workAvailable },
  ]
  const [selected, setSelected] = createSignal("code")
  const [last, setLast] = createSignal("")
  return (
    <div data-kete="sidebar" style={{ width: "240px" }}>
      <KeteModeSwitchView
        modes={modes}
        selected={selected()}
        label="Mode"
        unavailable="Not available yet"
        onSelect={(id) => {
          setSelected(id)
          setLast(id)
        }}
      />
      <output data-testid="last">{last()}</output>
    </div>
  )
}

// The real panel needs server contexts the harness doesn't mock, so a stand-in fills its slot.
function IncompatibleGateStory() {
  const [covered, setCovered] = createSignal<string | undefined>("local")
  return (
    <div style={{ width: "480px", height: "240px", display: "flex", "flex-direction": "column" }}>
      <button type="button" onClick={() => setCovered((value) => (value ? undefined : "local"))}>
        Toggle
      </button>
      <KeteIncompatibleGateView covered={covered()} panel={<div data-testid="panel">Panel stand-in</div>}>
        <div data-testid="home">Home stand-in</div>
      </KeteIncompatibleGateView>
    </div>
  )
}

export const IncompatibleGate = {
  render: () => <IncompatibleGateStory />,
}

export const Sidebar = {
  render: () => <SidebarStory />,
}

export const AgentSwitch = {
  render: () => <AgentSwitchStory />,
}

// Work as the runtime ships it today: listed, disabled, with its hint.
export const ModeSwitch = {
  render: () => <ModeSwitchStory workAvailable={false} />,
}

export const ModeSwitchWorkAvailable = {
  render: () => <ModeSwitchStory workAvailable />,
}

// An existing session already in Plan: the switch opens on Plan and Build leaves it.
export const AgentSwitchInPlan = {
  render: () => <AgentSwitchStory planning />,
}
