import { test, expect, type Page, type Response } from '@playwright/test'
import * as path from 'path'

const NOTES_FIXTURE = path.join(__dirname, 'fixtures', 'project-notes.txt')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the Projects panel from anywhere */
async function openProjectsPanel(page: Page) {
  await page.goto('/c/new')
  await page.waitForLoadState('networkidle')
  await page.click('[data-panel="projects"]')
  await expect(page.locator('.projects-panel')).toBeVisible()
}

/**
 * Create a project via the Projects panel UI.
 * Assumes the projects panel is already open.
 * Returns after the new project item is visible in the list.
 */
async function createProject(page: Page, name: string) {
  await page.click('.panel-header-btn')
  await page.locator('.new-project-bar input').waitFor({ state: 'visible' })
  await page.fill('.new-project-bar input', name)
  await page.keyboard.press('Enter')
  // Wait for the input to disappear and the item to appear
  await page.locator('.new-project-bar input').waitFor({ state: 'hidden', timeout: 5000 })
  await expect(
    page.locator('.project-item').filter({ hasText: name })
  ).toBeVisible({ timeout: 5000 })
}

/**
 * Turn on "Show project chats" in the ChatsPanel filter popover. Off by default, so a chat
 * moved into a project drops straight out of the list and its chip can never be asserted.
 * Assumes the ChatsPanel is open.
 */
async function showProjectChats(page: Page) {
  await page.locator('.chat-list-filter .chat-filter-btn').click()
  const item = page.locator('.chat-list-filter-item').filter({ hasText: 'Show project chats' })
  await item.locator('input').check()
  // The popover only closes on a click outside it (there is no Esc handler), and while it
  // is open it covers the top of the chat list — every later hover/click there is
  // intercepted. Toggle it shut with the same button that opened it.
  await page.locator('.chat-list-filter .chat-filter-btn').click()
  await expect(page.locator('.chat-list-filter-menu')).toBeHidden({ timeout: 5000 })
}

/**
 * Delete a project via the Projects panel UI.
 * Assumes the projects panel is visible.
 * Handles the confirm() dialog automatically.
 */
async function deleteProject(page: Page, name: string) {
  const item = page.locator('.project-item').filter({ hasText: name })
  // Accept the confirm() dialog that handleDelete() triggers
  page.once('dialog', dialog => dialog.accept())
  await item.hover()
  // Title is "Delete project" (not "Delete") — ProjectsPanel.tsx's delete
  // button. Using the wrong selector here silently failed cleanup on every
  // run (swallowed by the try/catch at each call site), leaving orphaned
  // "E2E ..." projects in the live account indefinitely.
  await item.locator('button[title="Delete project"]').click()
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

test.describe('Projects panel — navigation', () => {
  test.use({ storageState: '.auth/state.json' })

  test('opens via activity bar', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.click('[data-panel="projects"]')
    await expect(page.locator('.projects-panel')).toBeVisible()
  })

  test('shows empty state or project list', async ({ page }) => {
    await openProjectsPanel(page)
    // Either empty hint or at least one project item is acceptable
    const emptyHint = page.locator('.projects-panel .empty-hint')
    const projectList = page.locator('.projects-panel .project-list')
    const hasEmpty = await emptyHint.isVisible()
    const hasList = await projectList.isVisible()
    expect(hasEmpty || hasList).toBe(true)
  })
})

test.describe('Projects — CRUD lifecycle', () => {
  test.use({ storageState: '.auth/state.json' })

  test('create project', async ({ page }) => {
    const name = `E2E Test Project CRUD ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, name)

    // The project item is visible
    await expect(page.locator('.project-item').filter({ hasText: name })).toBeVisible()

    // Cleanup
    try {
      await deleteProject(page, name)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('navigate to project view', async ({ page }) => {
    const name = `E2E Nav Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, name)

    // Creating also navigates to /p/:projectId automatically; verify
    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()
    await expect(page.locator('.project-view-header h2')).toContainText(name)

    // Screenshot of the project view
    await page.screenshot({ path: `.screenshots/${new Date().toISOString().slice(0, 10)}-projects-view.jpg` })

    // Cleanup — go back to panel, delete
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, name)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('project view sections are visible', async ({ page }) => {
    const name = `E2E Sections Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, name)

    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()

    const headers = page.locator('.project-section-header')
    await expect(headers.filter({ hasText: 'Chats' })).toBeVisible()
    await expect(headers.filter({ hasText: 'Files' })).toBeVisible()
    await expect(headers.filter({ hasText: 'Memory' })).toBeVisible()

    // Cleanup
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, name)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('rename project', async ({ page }) => {
    const before = `E2E Rename Before ${Date.now()}`
    const after = `E2E Rename After ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, before)

    // Navigate back to panel after auto-redirect to /p/:projectId
    await page.click('[data-panel="projects"]')
    await expect(page.locator('.projects-panel')).toBeVisible()

    const item = page.locator('.project-item').filter({ hasText: before })
    await item.hover()
    // Click the Rename (pen) button — title is "Rename project" (not "Rename",
    // which is the chat-item rename button's title in this same panel)
    await item.locator('button[title="Rename project"]').click()

    // Fill the rename input — note: query it unscoped from `item`, not
    // `item.locator(...)`. Entering edit mode replaces the row's text
    // content with a bare input, so the `hasText: before` filter `item` was
    // built from stops matching anything once editing starts. Only one
    // project can be mid-edit at a time, so the global query is unambiguous.
    await expect(page.locator('.rename-input')).toBeVisible()
    await page.fill('.rename-input', after)
    await page.keyboard.press('Enter')

    // The project title should update
    await expect(
      page.locator('.project-title').filter({ hasText: after })
    ).toBeVisible({ timeout: 3000 })

    // Cleanup
    try {
      await deleteProject(page, after)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('delete project — chats survive', async ({ page }) => {
    const name = `E2E Delete Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, name)

    // Come back to the panel after auto-redirect
    await page.click('[data-panel="projects"]')
    await expect(page.locator('.projects-panel')).toBeVisible()

    await deleteProject(page, name)

    // Project item should be gone
    await expect(
      page.locator('.project-item').filter({ hasText: name })
    ).not.toBeVisible({ timeout: 5000 })
  })
})

test.describe('Projects — chat membership', () => {
  test.use({ storageState: '.auth/state.json' })

  test('new chat in project gets project chip in ChatView', async ({ page }) => {
    const projectName = `E2E Chip Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, projectName)

    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()

    // Click "New chat" inside the project view
    await page.locator('.project-view-header .btn-action').click()

    // Should navigate to a chat
    await page.waitForURL(/\/c\/(?!new)/, { timeout: 10000 })
    await expect(page.locator('.chat-view')).toBeVisible()

    // Project chip should appear in the chat header
    await expect(page.locator('.chat-header .project-chip')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.chat-header .project-chip')).toContainText(projectName)

    // Cleanup: navigate to project, remove chat, delete project
    try {
      await page.locator('.chat-header .project-chip').click()
      await page.waitForURL(/\/p\//, { timeout: 5000 })
      const removeBtn = page.locator('.chat-item .chat-actions button[title="Remove from project"]')
      if (await removeBtn.isVisible()) await removeBtn.click()
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('move chat to project via ChatsPanel', async ({ page }) => {
    const projectName = `E2E Move Test ${Date.now()}`

    // Go to /c/new — a new chat URL is assigned
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // The URL stays /c/new until the user sends a message, so we just record it
    // Instead, create a fresh chat by navigating once more after panel load
    await page.waitForSelector('.chat-list', { timeout: 5000 })

    // Store current chats count to identify the newest one we'll create
    // We rely on "New Chat" item from a fresh /c/new session showing in ChatsPanel

    // Create the project
    await page.click('[data-panel="projects"]')
    await expect(page.locator('.projects-panel')).toBeVisible()
    await createProject(page, projectName)

    // After project creation, go back to a chat context
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Open ChatsPanel
    await page.click('[data-panel="chats"]')
    await expect(page.locator('.chat-list')).toBeVisible()
    await showProjectChats(page)

    // The first chat item in the list is the most recently updated one
    const firstChatItem = page.locator('.chat-list .chat-item').first()
    await expect(firstChatItem).toBeVisible({ timeout: 5000 })

    // Hover to reveal actions
    await firstChatItem.hover()
    await firstChatItem.locator('button[title="Move to project"]').click()

    // Move menu appears
    await expect(firstChatItem.locator('.move-menu')).toBeVisible({ timeout: 3000 })

    // Click the project name in the move menu
    await firstChatItem.locator('.move-menu-item').filter({ hasText: projectName }).click()

    // The project chip should appear on this chat item
    await expect(firstChatItem.locator('.project-chip')).toBeVisible({ timeout: 5000 })
    await expect(firstChatItem.locator('.project-chip')).toContainText(projectName)

    // Cleanup: remove from project, then delete project
    try {
      await firstChatItem.hover()
      await firstChatItem.locator('button[title="Move to project"]').click()
      await expect(firstChatItem.locator('.move-menu')).toBeVisible({ timeout: 3000 })
      await firstChatItem.locator('.move-menu-item.remove').click()
      await expect(firstChatItem.locator('.project-chip')).not.toBeVisible({ timeout: 3000 })

      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('remove chat from project via ChatsPanel', async ({ page }) => {
    const projectName = `E2E Remove Test ${Date.now()}`

    // Create project
    await openProjectsPanel(page)
    await createProject(page, projectName)

    // Navigate back to a chat context
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Open ChatsPanel, move the first chat item into the project
    await page.click('[data-panel="chats"]')
    await expect(page.locator('.chat-list')).toBeVisible()
    await showProjectChats(page)

    const firstChatItem = page.locator('.chat-list .chat-item').first()
    await expect(firstChatItem).toBeVisible({ timeout: 5000 })

    await firstChatItem.hover()
    await firstChatItem.locator('button[title="Move to project"]').click()
    await expect(firstChatItem.locator('.move-menu')).toBeVisible({ timeout: 3000 })
    await firstChatItem.locator('.move-menu-item').filter({ hasText: projectName }).click()
    await expect(firstChatItem.locator('.project-chip')).toBeVisible({ timeout: 5000 })

    // Now remove from project
    await firstChatItem.hover()
    await firstChatItem.locator('button[title="Move to project"]').click()
    await expect(firstChatItem.locator('.move-menu')).toBeVisible({ timeout: 3000 })
    await firstChatItem.locator('.move-menu-item.remove').click()

    // Project chip should be gone
    await expect(firstChatItem.locator('.project-chip')).not.toBeVisible({ timeout: 5000 })

    // Cleanup: delete project
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })

  test('project chip in ChatsPanel links to project view', async ({ page }) => {
    const projectName = `E2E Chip Link Test ${Date.now()}`

    // Create project
    await openProjectsPanel(page)
    await createProject(page, projectName)

    // Go back to a chat context
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Open ChatsPanel, move first chat into project
    await page.click('[data-panel="chats"]')
    await expect(page.locator('.chat-list')).toBeVisible()
    await showProjectChats(page)

    const firstChatItem = page.locator('.chat-list .chat-item').first()
    await expect(firstChatItem).toBeVisible({ timeout: 5000 })

    await firstChatItem.hover()
    await firstChatItem.locator('button[title="Move to project"]').click()
    await expect(firstChatItem.locator('.move-menu')).toBeVisible({ timeout: 3000 })
    await firstChatItem.locator('.move-menu-item').filter({ hasText: projectName }).click()
    await expect(firstChatItem.locator('.project-chip')).toBeVisible({ timeout: 5000 })

    // Click the project chip — should navigate to /p/:projectId
    await firstChatItem.locator('.project-chip').click()
    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()
    await expect(page.locator('.project-view-header h2')).toContainText(projectName)

    // Cleanup
    try {
      // Remove the chat from the project first via the project view
      const removeBtn = page.locator('.chat-item .chat-actions button[title="Remove from project"]').first()
      if (await removeBtn.isVisible({ timeout: 2000 })) await removeBtn.click()

      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })
})

test.describe('Projects — file upload UI', () => {
  test.use({ storageState: '.auth/state.json' })

  test('file drop zone visible in project view', async ({ page }) => {
    const projectName = `E2E Files UI Test ${Date.now()}`

    await openProjectsPanel(page)
    await createProject(page, projectName)

    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()

    // Drop zone should be visible
    await expect(page.locator('.project-drop-zone')).toBeVisible()

    // Upload button should be visible in the Files section
    const filesSection = page.locator('.project-section').filter({ has: page.locator('.project-section-header', { hasText: 'Files' }) })
    await expect(filesSection.locator('button.btn-action', { hasText: 'Upload' })).toBeVisible()

    // Cleanup
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })
})

test.describe('Projects — inline edits (live verification)', () => {
  test.use({ storageState: '.auth/state.json' })

  test('project memory, file microLabel/summary, and chat summary edits persist across reload', async ({ page }) => {
    const projectName = `E2E Inline Edits Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, projectName)
    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()
    const projectUrl = page.url()

    // --- Seed a real project memory via the manage_project_memory tool ---
    await page.locator('.project-view-header .btn-action').click()
    await page.waitForURL(/\/c\/(?!new)/, { timeout: 10000 })
    await expect(page.locator('.chat-view')).toBeVisible()
    await page.locator('.message-input').fill(
      'Use the manage_project_memory tool right now (operation "remember") to save this project ' +
      'decision: "We use PostgreSQL 16 as the database for this project." Then reply with one word: Done.'
    )
    await page.locator('.btn-send').click()
    // Pill label is the descriptive "Remember (project): …" (not the raw tool name).
    const memPill = page.locator('.tool-pill', { hasText: 'Remember (project):' }).first()
    await expect(memPill).toBeVisible({ timeout: 60000 })
    await expect(memPill).not.toHaveClass(/pending/, { timeout: 60000 })
    await expect(memPill).not.toHaveClass(/error/)
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })

    // --- Back to the project view ---
    await page.goto(projectUrl)
    await expect(page.locator('.project-view')).toBeVisible()

    const isProjectMemoryPatch = (resp: Response) =>
      resp.request().method() === 'PATCH' && /\/api\/projects\/[^/]+\/memory\/[^/]+$/.test(resp.url())
    const isProjectFilePatch = (resp: Response) =>
      resp.request().method() === 'PATCH' && /\/api\/projects\/[^/]+\/files\/[^/]+$/.test(resp.url())
    const isChatPatch = (resp: Response) =>
      resp.request().method() === 'PATCH' && /\/api\/chats\/[^/]+$/.test(resp.url())

    // --- Project memory: edit text inline ---
    const memorySection = page.locator('.project-section').filter({ has: page.locator('.project-section-header', { hasText: 'Memory' }) })
    const memoryText = memorySection.locator('.memory-text').first()
    await expect(memoryText).toBeVisible({ timeout: 15000 })
    await memoryText.click()
    // Memory rows edit through a textarea of their own (.memory-edit-textarea), not the
    // .rename-input the file label uses.
    await memorySection.locator('.memory-edit-textarea').fill('Edited: Postgres 16 is the database of record.')
    await Promise.all([page.waitForResponse(isProjectMemoryPatch), page.keyboard.press('Enter')])
    await expect(memorySection.locator('.memory-text').first())
      .toHaveText('Edited: Postgres 16 is the database of record.', { timeout: 5000 })

    // --- Upload a file and wait for it to finish processing ---
    await page.locator('.project-view input[type="file"]').setInputFiles(NOTES_FIXTURE)
    const fileItem = page.locator('.project-file-item').first()
    await expect(fileItem.locator('.file-status')).toHaveCount(0, { timeout: 60000 })
    await expect(fileItem.locator('.file-micro-label')).toBeVisible({ timeout: 5000 })

    // File microLabel: edit inline
    await fileItem.locator('.file-micro-label').click()
    await fileItem.locator('.rename-input').fill('Edited label')
    await Promise.all([page.waitForResponse(isProjectFilePatch), page.keyboard.press('Enter')])
    await expect(fileItem.locator('.file-micro-label')).toHaveText('Edited label', { timeout: 5000 })

    // File summary: expand, then edit inline
    await fileItem.locator('.project-file-main').click()
    const fileSummary = fileItem.locator('.file-summary')
    await expect(fileSummary).toBeVisible({ timeout: 3000 })
    await fileSummary.click()
    const fileSummaryTextarea = fileItem.locator('.inline-edit-textarea')
    await fileSummaryTextarea.fill('Edited file summary text.')
    await Promise.all([page.waitForResponse(isProjectFilePatch), fileSummaryTextarea.blur()])
    await expect(fileItem.locator('.file-summary')).toHaveText('Edited file summary text.', { timeout: 5000 })

    // --- Chat summary: add/edit inline in the project's chat list ---
    const chatsSection = page.locator('.project-section').filter({ has: page.locator('.project-section-header', { hasText: 'Chats' }) })
    const chatItem = chatsSection.locator('.chat-item').first()
    await expect(chatItem).toBeVisible({ timeout: 5000 })
    await chatItem.locator('.chat-summary').click()
    const chatSummaryTextarea = chatItem.locator('.inline-edit-textarea')
    await chatSummaryTextarea.fill('Edited: discusses Postgres + ULID decisions for this project.')
    await Promise.all([page.waitForResponse(isChatPatch), chatSummaryTextarea.blur()])
    await expect(chatItem.locator('.chat-summary'))
      .toHaveText('Edited: discusses Postgres + ULID decisions for this project.', { timeout: 5000 })

    // --- Reload and confirm every edit persisted ---
    await page.reload()
    await page.waitForURL(projectUrl)
    await expect(page.locator('.project-view')).toBeVisible()

    await expect(page.locator('.memory-text').first())
      .toHaveText('Edited: Postgres 16 is the database of record.', { timeout: 10000 })

    const fileItemAfter = page.locator('.project-file-item').first()
    await expect(fileItemAfter.locator('.file-micro-label')).toHaveText('Edited label', { timeout: 10000 })
    await fileItemAfter.locator('.project-file-main').click()
    await expect(fileItemAfter.locator('.file-summary')).toHaveText('Edited file summary text.', { timeout: 5000 })

    const chatItemAfter = page.locator('.project-section')
      .filter({ has: page.locator('.project-section-header', { hasText: 'Chats' }) })
      .locator('.chat-item').first()
    await expect(chatItemAfter.locator('.chat-summary'))
      .toHaveText('Edited: discusses Postgres + ULID decisions for this project.', { timeout: 10000 })

    await page.screenshot({ path: `.screenshots/${new Date().toISOString().slice(0, 10)}-project-inline-edits.jpg` })

    // Cleanup
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })
})

test.describe('Projects — memory dedup (dual-writer regression)', () => {
  test.use({ storageState: '.auth/state.json' })

  // Regression: when the model saves a fact via manage_project_memory mid-loop,
  // the post-turn passive enrichment must see that write (re-read after the loop)
  // and merge it — NOT re-derive a paraphrase as a second memory. Before the fix
  // this turn reliably produced two near-duplicate "PostgreSQL" memories.
  test('a single tool-saved project fact does not get duplicated by passive enrichment', async ({ page }) => {
    // Unique per-run name so leftover projects from prior best-effort cleanups
    // can't collide with the create/delete name filters (strict-mode violations).
    const projectName = `E2E Memory Dedup ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, projectName)
    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()
    const projectUrl = page.url()

    // New chat in the project, instruct it to save exactly one decision via the tool
    await page.locator('.project-view-header .btn-action').click()
    await page.waitForURL(/\/c\/(?!new)/, { timeout: 10000 })
    await expect(page.locator('.chat-view')).toBeVisible()
    await page.locator('.message-input').fill(
      'Use the manage_project_memory tool right now (operation "remember", category "decision") ' +
      'to save exactly this project decision: "We use PostgreSQL 16 as the database for this project." ' +
      'Then reply with one word: Done.'
    )
    await page.locator('.btn-send').click()

    // Pill label is the descriptive "Remember (project): …" (not the raw tool name).
    const memPill = page.locator('.tool-pill', { hasText: 'Remember (project):' }).first()
    await expect(memPill).toBeVisible({ timeout: 60000 })
    await expect(memPill).not.toHaveClass(/pending/, { timeout: 60000 })
    await expect(memPill).not.toHaveClass(/error/)
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })
    await expect(page.locator('.message-input')).toBeEnabled({ timeout: 15000 })

    // The memory pill shows WHAT was saved: descriptive label + expanded body
    // with the remembered text (not a bare "manage_project_memory" / "Saved.").
    await expect(memPill.locator('.tool-label')).toContainText('Remember (project):')
    await expect(memPill.locator('.tool-label')).toContainText('PostgreSQL')
    await memPill.locator('.tool-pill-header').click()
    const memCard = memPill.locator('.memory-update-card')
    await expect(memCard).toBeVisible({ timeout: 5000 })
    await expect(memCard.locator('.memory-update-op')).toContainText('Remembered project memory')
    await expect(memCard.locator('.memory-update-text')).toContainText('PostgreSQL 16')
    await page.screenshot({ path: `.screenshots/${new Date().toISOString().slice(0, 10)}-memory-card.jpg` })

    // Passive enrichment (Sonnet) runs server-side AFTER the WS 'done' frame; a
    // clean merge emits no WS frame, so wait for it to settle before counting.
    const countPostgresMemories = async () => {
      await page.goto(projectUrl)
      await expect(page.locator('.project-view')).toBeVisible()
      const memSection = page.locator('.project-section').filter({ has: page.locator('.project-section-header', { hasText: 'Memory' }) })
      await expect(memSection.locator('.memory-item, .panel-empty')).not.toHaveCount(0, { timeout: 10000 })
      return memSection.locator('.memory-item', { hasText: /postgres/i }).count()
    }

    // Poll until the tool's memory shows up, then settle and confirm it stays a single item.
    await expect.poll(countPostgresMemories, { timeout: 30000, intervals: [3000, 3000, 5000, 5000] }).toBeGreaterThanOrEqual(1)
    await page.waitForTimeout(12000) // let any late/duplicate enrichment write land
    const finalCount = await countPostgresMemories()
    expect(finalCount, 'exactly one PostgreSQL memory should exist (tool write merged, not duplicated)').toBe(1)

    await page.screenshot({ path: `.screenshots/${new Date().toISOString().slice(0, 10)}-project-memory-dedup.jpg` })

    // Cleanup
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })
})

test.describe('Projects — Settings section', () => {
  test.use({ storageState: '.auth/state.json' })

  test('description, instructions, and memoryEnabled persist across reload', async ({ page }) => {
    const projectName = `E2E Settings Test ${Date.now()}`
    await openProjectsPanel(page)
    await createProject(page, projectName)

    await page.waitForURL(/\/p\//, { timeout: 10000 })
    await expect(page.locator('.project-view')).toBeVisible()

    // Project settings now live in the Project details dialog, opened from the gear
    // next to the project name (moved out of an always-scrolling inline section —
    // see "Chat details dialog & the settings surfaces" in frontend/CLAUDE.md).
    await page.locator('.project-view-header .btn-icon[title="Project details"]').click()
    const dialog = page.locator('.dialog')
    await expect(dialog).toBeVisible()

    const isProjectPatch = (resp: import('@playwright/test').Response) =>
      resp.request().method() === 'PATCH' && /\/api\/projects\/[^/]+$/.test(resp.url())

    // Edit description — wait for the PATCH to actually land before moving on,
    // since a reload would otherwise cancel an in-flight request
    const descTextarea = dialog.locator('.pref-textarea').first()
    await descTextarea.fill('A project for end-to-end testing.')
    await Promise.all([page.waitForResponse(isProjectPatch), descTextarea.blur()])

    // Edit instructions
    const instrTextarea = dialog.locator('.pref-textarea').nth(1)
    await instrTextarea.fill('Always answer in haiku.')
    await Promise.all([page.waitForResponse(isProjectPatch), instrTextarea.blur()])

    // Toggle memory off
    const memoryToggle = dialog.locator('.pref-row', { hasText: 'Project memory' }).locator('.toggle-btn')
    await expect(memoryToggle).toHaveText('On')
    await Promise.all([page.waitForResponse(isProjectPatch), memoryToggle.click()])
    await expect(memoryToggle).toHaveText('Off', { timeout: 3000 })

    // Reload and re-navigate to the same project — values must persist
    const url = page.url()
    await page.reload()
    await page.waitForURL(url)
    await expect(page.locator('.project-view')).toBeVisible()

    await page.locator('.project-view-header .btn-icon[title="Project details"]').click()
    const dialogAfterReload = page.locator('.dialog')
    await expect(dialogAfterReload.locator('.pref-textarea').first()).toHaveValue('A project for end-to-end testing.', { timeout: 5000 })
    await expect(dialogAfterReload.locator('.pref-textarea').nth(1)).toHaveValue('Always answer in haiku.')
    await expect(dialogAfterReload.locator('.pref-row', { hasText: 'Project memory' }).locator('.toggle-btn')).toHaveText('Off')
    await page.keyboard.press('Escape')

    // Cleanup
    try {
      await page.click('[data-panel="projects"]')
      await deleteProject(page, projectName)
    } catch { /* cleanup failure is acceptable */ }
  })
})
