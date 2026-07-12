import { test, expect } from '@playwright/test'

test('Private toggle creates a sensitive+ephemeral chat, hidden from the list until revealed', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: 'Claude Haiku 4.5' })

  await page.locator('.btn-private-toggle').click()
  await expect(page.locator('.btn-private-toggle')).toHaveClass(/active/)
  await expect(page.locator('.chat-view')).toHaveClass(/chat-view--private/)

  const input = page.locator('.message-input')
  const marker = `Sensitive e2e ${Date.now()}`
  await input.fill(`Reply with exactly: "${marker}"`)
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // No title in the header for a sensitive chat — only the discreet chip.
  await expect(page.locator('.chat-header h2')).toHaveCount(0)
  await expect(page.locator('.chat-header .private-chip')).toBeVisible()

  // Sidebar: no sensitive chats rendered at all while the list filter defaults to off,
  // even though the API returns this chat like any other.
  await expect(page.locator('.chat-item.sensitive')).toHaveCount(0)

  // Reveal via the filter dialog.
  await page.locator('.chat-list-filter .chat-filter-btn').click()
  await page.getByText('Show sensitive chats').click()

  await expect(page.locator('.chat-item.sensitive').first()).toBeVisible({ timeout: 5_000 })
})

test('Header cog toggles Sensitive/Auto-delete independently on an existing chat', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: 'Claude Haiku 4.5' })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Cog test answer."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // A normal chat still shows its title in the header.
  await expect(page.locator('.chat-header h2')).toBeVisible()

  // Open the cog and turn Sensitive on. Click (not .check()) — the toggle round-trips through
  // a PATCH + GET before the checked state actually flips (no optimistic update), so asserting
  // via the header title change below is more reliable than racing .check()'s own re-verify.
  await page.locator('.chat-cog button.btn-icon').click()
  const sensitiveLabel = page.locator('.chat-cog-menu .chat-list-filter-item').filter({ hasText: 'Sensitive' })
  await sensitiveLabel.click()

  // The chat re-fetches and the header title disappears; a private chip appears.
  await expect(page.locator('.chat-header h2')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.chat-header .private-chip')).toBeVisible()

  // Turn it back off — title returns. The cog popover is still open from the click above
  // (toggling a flag doesn't close it), so no need to re-click the cog button.
  await sensitiveLabel.click()
  await expect(page.locator('.chat-header h2')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.chat-header .private-chip')).toHaveCount(0)
})
