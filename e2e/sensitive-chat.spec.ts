import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

test('Private toggle creates a sensitive+ephemeral chat, hidden from the list until revealed', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: FAST_MODEL_LABEL })

  await page.locator('.btn-private-toggle').click()
  await expect(page.locator('.btn-private-toggle')).toHaveClass(/active/)
  await expect(page.locator('.chat-view')).toHaveClass(/chat-view--private/)

  const input = page.locator('.message-input')
  const marker = `Sensitive e2e ${Date.now()}`
  await input.fill(`Reply with exactly: "${marker}"`)
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  await expect(page.locator('.chat-header h2')).toHaveCount(0)
  await expect(page.locator('.chat-header .private-chip')).toBeVisible()

  await expect(page.locator('.chat-item.sensitive')).toHaveCount(0)

  await page.locator('.chat-list-filter .chat-filter-btn').click()
  await page.getByText('Show sensitive chats').click()

  await expect(page.locator('.chat-item.sensitive').first()).toBeVisible({ timeout: 5_000 })
})

test('Chat details dialog toggles Sensitive/Auto-delete independently on an existing chat', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: FAST_MODEL_LABEL })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Chat details test answer."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // A normal chat still shows its title in the header.
  await expect(page.locator('.chat-header h2')).toBeVisible()

  // Open the Chat details dialog (the cog, always present) and turn Sensitive on.
  await page.locator('.chat-header .btn-icon[title="Chat details"]').click()
  await expect(page.locator('.dialog')).toBeVisible()
  const sensitiveRow = page.locator('.dialog .model-setting-row').filter({ hasText: 'Sensitive' })
  await sensitiveRow.locator('.toggle-btn').click()

  // The chat re-fetches and the header title disappears; a private chip appears — visible
  // even with the dialog still open, since it sits in the header behind it.
  await expect(page.locator('.chat-header h2')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.chat-header .private-chip')).toBeVisible()
  await expect(sensitiveRow.locator('.toggle-btn')).toHaveText('On')

  // Turn it back off — title returns.
  await sensitiveRow.locator('.toggle-btn').click()
  await expect(page.locator('.chat-header h2')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.chat-header .private-chip')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.locator('.dialog')).toHaveCount(0)
})

test('Header "Private" button is a one-click shortcut for both flags together', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: FAST_MODEL_LABEL })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Private shortcut test answer."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  await page.locator('.chat-header .btn-private-toggle').click()
  await expect(page.locator('.chat-header .btn-private-toggle')).toHaveClass(/active/, { timeout: 10_000 })
  await expect(page.locator('.chat-header .private-chip')).toContainText('Private')

  // Both flags landed independently-verifiable via the dialog.
  await page.locator('.chat-header .btn-icon[title="Chat details"]').click()
  await expect(page.locator('.dialog .model-setting-row').filter({ hasText: 'Sensitive' }).locator('.toggle-btn')).toHaveText('On')
  await expect(page.locator('.dialog .model-setting-row').filter({ hasText: 'Auto-delete' }).locator('.toggle-btn')).toHaveText('On')
})
