import { expect, story } from "../../stories/playwright/story"

const SESSION = '[data-kete="sidebar-session"]'
const SECTION = '[data-kete="sidebar-section"]'
const TITLE = '[data-kete="sidebar-section-title"]'
const COUNT = '[data-kete="sidebar-count"]'

story("lists the eight newest sessions with the total and View more", async ({ mount }) => {
  const root = await mount("app-kete-shell--sidebar")
  const sessions = root.locator(SECTION).first()

  await expect(sessions.locator(SESSION)).toHaveCount(8)
  await expect(sessions.locator(`${TITLE} ${COUNT}`)).toHaveText("10")
  await expect(sessions.locator(SESSION).first()).toContainText("Session 0")
  await expect(sessions.locator(SESSION).first()).toContainText("5 min ago")
  await expect(sessions.getByRole("button", { name: "View more" })).toBeVisible()
})

story("collapses and expands a section", async ({ mount }) => {
  const root = await mount("app-kete-shell--sidebar")
  const sessions = root.locator(SECTION).first()
  const title = sessions.locator(TITLE)

  await expect(title).toHaveAttribute("aria-expanded", "true")
  await title.click()
  await expect(title).toHaveAttribute("aria-expanded", "false")
  await expect(sessions.locator(SESSION)).toHaveCount(0)
  await title.click()
  await expect(title).toHaveAttribute("aria-expanded", "true")
  await expect(sessions.locator(SESSION)).toHaveCount(8)
})

story("marks the open session as the current page and moves the mark on selection", async ({ mount }) => {
  const root = await mount("app-kete-shell--sidebar")
  const sessions = root.locator(SECTION).first()

  await expect(sessions.locator(`${SESSION}[aria-current="page"]`)).toHaveCount(1)
  await expect(sessions.locator(`${SESSION}[aria-current="page"]`)).toContainText("Session 1")
  await sessions.locator(SESSION).filter({ hasText: "Session 4" }).click()
  await expect(sessions.locator(`${SESSION}[aria-current="page"]`)).toHaveCount(1)
  await expect(sessions.locator(`${SESSION}[aria-current="page"]`)).toContainText("Session 4")
})

story("View more and the navigation buttons call their handlers", async ({ mount }) => {
  const root = await mount("app-kete-shell--sidebar")
  const last = root.getByTestId("last")

  await root.getByRole("button", { name: "View more" }).click()
  await expect(last).toHaveText("more")
  await root.getByRole("button", { name: "Search" }).click()
  await expect(last).toHaveText("search")
  await root.getByRole("button", { name: "New session" }).click()
  await expect(last).toHaveText("new")
  await root.getByRole("button", { name: "Settings" }).click()
  await expect(last).toHaveText("settings")
})

story("shows each project's full count but only its three newest sessions", async ({ mount }) => {
  const root = await mount("app-kete-shell--sidebar")
  const projects = root.locator(SECTION).nth(1)
  const alpha = projects.locator('[data-kete="sidebar-project"]').first()

  await expect(projects.locator(`${TITLE} ${COUNT}`)).toHaveText("2")
  await expect(alpha.locator('[data-kete="sidebar-project-name"]')).toContainText("alpha")
  await expect(alpha.locator('[data-kete="sidebar-project-name"] ' + COUNT)).toHaveText("10")
  await expect(alpha.locator(SESSION)).toHaveCount(3)
})

story("opens on Plan for a session already in Plan and leaves it with Build", async ({ mount }) => {
  const root = await mount("app-kete-shell--agent-switch-in-plan")
  const group = root.getByRole("radiogroup", { name: "Agent" })

  await expect(group.getByRole("radio", { name: "Plan" })).toHaveAttribute("aria-checked", "true")
  await group.getByRole("radio", { name: "Build" }).click()
  await expect(group.getByRole("radio", { name: "Build" })).toHaveAttribute("aria-checked", "true")
  await expect(group.getByRole("radio", { name: "Plan" })).toHaveAttribute("aria-checked", "false")
})

story("covers the page with the panel while a server is incompatible and restores it after", async ({ mount }) => {
  const root = await mount("app-kete-shell--incompatible-gate")

  await expect(root.getByTestId("panel")).toBeVisible()
  await expect(root.getByTestId("home")).toHaveCount(0)
  await root.getByRole("button", { name: "Toggle" }).click()
  await expect(root.getByTestId("home")).toBeVisible()
  await expect(root.getByTestId("panel")).toHaveCount(0)
})

story("switches between Build and Plan",async ({ mount }) => {
  const root = await mount("app-kete-shell--agent-switch")
  const group = root.getByRole("radiogroup", { name: "Agent" })
  const build = group.getByRole("radio", { name: "Build" })
  const plan = group.getByRole("radio", { name: "Plan" })

  await expect(build).toHaveAttribute("aria-checked", "true")
  await expect(plan).toHaveAttribute("aria-checked", "false")
  await plan.click()
  await expect(plan).toHaveAttribute("aria-checked", "true")
  await expect(build).toHaveAttribute("aria-checked", "false")
  await build.click()
  await expect(build).toHaveAttribute("aria-checked", "true")
})

story("shows Work disabled with its hint and leaves Code checked when it is clicked", async ({ mount }) => {
  const root = await mount("app-kete-shell--mode-switch")
  const group = root.getByRole("radiogroup", { name: "Mode" })
  const code = group.getByRole("radio", { name: "Code" })
  const work = group.getByRole("radio", { name: "Work" })

  await expect(code).toHaveAttribute("aria-checked", "true")
  await expect(work).toHaveAttribute("aria-disabled", "true")
  await expect(root.getByText("Not available yet")).toBeVisible()
  await expect(work).toHaveAccessibleDescription("Not available yet")
  // Playwright refuses to click an aria-disabled element unless forced; a user can still try.
  await work.click({ force: true })
  await expect(code).toHaveAttribute("aria-checked", "true")
  await expect(root.getByTestId("last")).toHaveText("")
})

story("selects Work by click when it is available", async ({ mount }) => {
  const root = await mount("app-kete-shell--mode-switch-work-available")
  const group = root.getByRole("radiogroup", { name: "Mode" })

  await expect(group.getByRole("radio", { name: "Work" })).not.toHaveAttribute("aria-disabled", "true")
  await group.getByRole("radio", { name: "Work" }).click()
  await expect(group.getByRole("radio", { name: "Work" })).toHaveAttribute("aria-checked", "true")
  await expect(root.getByTestId("last")).toHaveText("work")
})

story("moves between available modes with the arrow keys and skips unavailable ones", async ({ mount, page }) => {
  const available = await mount("app-kete-shell--mode-switch-work-available")
  const code = available.getByRole("radio", { name: "Code" })
  const work = available.getByRole("radio", { name: "Work" })

  await expect(code).toHaveAttribute("tabindex", "0")
  await expect(work).toHaveAttribute("tabindex", "-1")
  await page.keyboard.press("Tab")
  await expect(code).toBeFocused()
  await expect(code).toHaveCSS("outline-style", "solid")
  await page.keyboard.press("ArrowRight")
  await expect(work).toHaveAttribute("aria-checked", "true")
  await expect(work).toBeFocused()
  await expect(work).toHaveAttribute("tabindex", "0")
  await expect(code).toHaveAttribute("tabindex", "-1")
})

story("arrow keys stay on Code while Work is unavailable", async ({ mount, page }) => {
  const root = await mount("app-kete-shell--mode-switch")
  const code = root.getByRole("radio", { name: "Code" })

  await page.keyboard.press("Tab")
  await expect(code).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(code).toHaveAttribute("aria-checked", "true")
  await expect(code).toBeFocused()
})
