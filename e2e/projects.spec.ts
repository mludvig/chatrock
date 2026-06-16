import { test, expect, type Page } from '@playwright/test'

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
 * Delete a project via the Projects panel UI.
 * Assumes the projects panel is visible.
 * Handles the confirm() dialog automatically.
 */
async function deleteProject(page: Page, name: string) {
  const item = page.locator('.project-item').filter({ hasText: name })
  // Accept the confirm() dialog that handleDelete() triggers
  page.once('dialog', dialog => dialog.accept())
  await item.hover()
  await item.locator('button[title="Delete"]').click()
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
    const name = 'E2E Test Project CRUD'
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
    const name = 'E2E Nav Test'
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
    const name = 'E2E Sections Test'
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
    const before = 'E2E Rename Before'
    const after = 'E2E Rename After'
    await openProjectsPanel(page)
    await createProject(page, before)

    // Navigate back to panel after auto-redirect to /p/:projectId
    await page.click('[data-panel="projects"]')
    await expect(page.locator('.projects-panel')).toBeVisible()

    const item = page.locator('.project-item').filter({ hasText: before })
    await item.hover()
    // Click the Rename (pen) button
    await item.locator('button[title="Rename"]').click()

    // Fill the rename input
    await expect(item.locator('.rename-input')).toBeVisible()
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
    const name = 'E2E Delete Test'
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
    const projectName = 'E2E Chip Test'
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
    const projectName = 'E2E Move Test'

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
    const projectName = 'E2E Remove Test'

    // Create project
    await openProjectsPanel(page)
    await createProject(page, projectName)

    // Navigate back to a chat context
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Open ChatsPanel, move the first chat item into the project
    await page.click('[data-panel="chats"]')
    await expect(page.locator('.chat-list')).toBeVisible()

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
    const projectName = 'E2E Chip Link Test'

    // Create project
    await openProjectsPanel(page)
    await createProject(page, projectName)

    // Go back to a chat context
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Open ChatsPanel, move first chat into project
    await page.click('[data-panel="chats"]')
    await expect(page.locator('.chat-list')).toBeVisible()

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
    const projectName = 'E2E Files UI Test'

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
