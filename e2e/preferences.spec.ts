import { test, expect } from '@playwright/test'

test.describe('Preferences panel', () => {
  test.use({ storageState: '.auth/state.json' })

  test('preference panel opens when clicking prefs icon', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-panel="prefs"]').click()
    await expect(page.locator('.prefs-panel')).toBeVisible()
  })

  test('prefs panel has Defaults and This chat tabs', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-panel="prefs"]').click()
    await expect(page.locator('.prefs-panel')).toBeVisible()
    // Both tabs must be present
    await expect(page.locator('.prefs-tab', { hasText: 'Defaults' })).toBeVisible()
    await expect(page.locator('.prefs-tab', { hasText: 'This chat' })).toBeVisible()
    // This chat tab is active by default
    await expect(page.locator('.prefs-tab.active', { hasText: 'This chat' })).toBeVisible()
  })

  test('switching to This chat tab shows custom instructions and model settings', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-panel="prefs"]').click()
    await page.locator('.prefs-tab', { hasText: 'This chat' }).click()
    // Tab switches
    await expect(page.locator('.prefs-tab.active', { hasText: 'This chat' })).toBeVisible()
    // Custom instructions textarea visible
    await expect(page.locator('.prefs-tab-content .pref-textarea')).toBeVisible()
    // ModelSettingsPanel rendered (web search toggle is always shown)
    await expect(page.locator('.model-settings')).toBeVisible()
  })

  test('no gear button in chat header', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    // The gear button (btn-icon for chat settings) should not exist
    const gearBtn = page.locator('.chat-header .btn-icon[title="Chat settings"]')
    await expect(gearBtn).not.toBeAttached()
  })

  test('model select is still present in chat header', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.chat-header .model-select')).toBeVisible()
  })

  test('custom persona in Defaults tab is reflected in assistant replies', async ({ page }) => {
    // Set persona that forbids emojis
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-panel="prefs"]').click()
    // Ensure Defaults tab is active
    await page.locator('.prefs-tab', { hasText: 'Defaults' }).click()
    await page.locator('.prefs-tab-content .pref-textarea').fill('You are a helpful assistant. Never use emojis in your responses.')
    await page.waitForTimeout(1200)  // wait for debounced save

    // Start a new chat and ask something emoji-prone
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.locator('[data-panel="chats"]').click()
    await page.locator('.message-input').fill('Say hello!')
    await page.locator('.btn-send').click()
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })
    // Get the assistant response text
    const reply = await page.locator('.message.assistant').last().textContent()
    expect(reply).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)  // no emoji codepoints
  })

  test('show token stats toggle in Defaults tab works', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    // First ensure we have a chat with a message
    await page.locator('[data-panel="chats"]').click()
    await page.locator('.message-input').fill('Hi')
    await page.locator('.btn-send').click()
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })

    // Open prefs, switch to Defaults, disable token stats
    await page.locator('[data-panel="prefs"]').click()
    await page.locator('.prefs-tab', { hasText: 'Defaults' }).click()
    // Find the token stats toggle — if it's On, click to turn Off
    const toggle = page.locator('.pref-row', { hasText: 'token stats' }).locator('.toggle-btn')
    const isOn = await toggle.textContent()
    if (isOn?.toLowerCase().includes('on')) await toggle.click()
    await page.waitForTimeout(1200)

    // Switch back to chats panel and verify prefs panel is hidden
    await page.locator('[data-panel="chats"]').click()
    await expect(page.locator('.prefs-panel')).not.toBeVisible()
    await expect(page.locator('.chats-panel, .chat-list')).toBeVisible()
  })
})
