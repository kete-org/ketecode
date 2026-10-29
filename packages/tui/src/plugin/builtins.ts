import HomeFooter from "../feature-plugins/home/footer"
import PromptBtw from "../feature-plugins/prompt/btw"
import PromptFooter from "../feature-plugins/prompt/footer"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import KeteBalance from "../kete/balance" // kete_change
import KeteLocalStatus from "../kete/local-status" // kete_change
import KeteSandboxStatus from "../kete/sandbox-status" // kete_change
import KeteTodo from "../kete/todo" // kete_change
import KeteStatusLine from "../kete/statusline" // kete_change
import KeteReleaseNotes from "../kete/release-notes" // kete_change
import KeteFeedback from "../kete/feedback" // kete_change
import KeteDoctor from "../kete/doctor" // kete_change
import KeteContext from "../kete/context" // kete_change
import KeteTerminalSetup from "../kete/terminal-setup" // kete_change
// import SidebarTodo from "../feature-plugins/sidebar/todo" // kete_change: KeteTodo shows the task list
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Plugins from "../feature-plugins/system/plugins"
import Storybook from "../feature-plugins/system/storybook"
import Stats from "../feature-plugins/system/stats"
import Latex from "@opencode/latex/plugin"
import Merman from "@opencode/merman/plugin"

export const builtins = [
  HomeFooter,
  PromptFooter,
  PromptBtw,
  SidebarContext,
  KeteBalance, // kete_change: Kete credit balance under the session context
  KeteLocalStatus, // kete_change: "Offline" footer indicator
  KeteSandboxStatus, // kete_change: "Unsandboxed" footer warning
  KeteTodo, // kete_change: the session task list (sidebar list, footer progress)
  KeteStatusLine, // kete_change: the configurable status line (/statusline)
  KeteReleaseNotes, // kete_change: /release-notes, and the notes once after an upgrade
  KeteFeedback, // kete_change: /feedback, the problem report dialog
  KeteDoctor, // kete_change: /doctor, the setup checks dialog
  KeteContext, // kete_change: /context, the context usage breakdown
  KeteTerminalSetup, // kete_change: /terminal-setup, Shift+Enter guidance
  SidebarMcp,
  // SidebarTodo, // kete_change: KeteTodo shows the task list
  SidebarFooter,
  Notifications,
  Plugins,
  Stats,
  Merman,
  Latex,
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for OPENCODE_STORY runs.
  ...(process.env.OPENCODE_STORY ? [Storybook] : []),
  DiffViewer,
]
