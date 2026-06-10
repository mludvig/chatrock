import { test, expect } from '@playwright/test'

test('edit question creates sibling branch, sibling nav works, persists after reload', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').selectOption({ label: 'Claude Sonnet 4.6' })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Original answer."')
  await input.press('Enter')

  // Wait for the URL to change from /c/new → /c/<chatId>
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })

  // Wait for streaming to complete and sending state to clear
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // ── Edit the user question ──
  await page.locator('.message.user').hover()
  const editBtn = page.locator('.message.user .action-btn[title="Edit this question"]')
  await expect(editBtn).toBeVisible({ timeout: 5_000 })
  await editBtn.click()

  const textarea = page.locator('.message.user .edit-textarea')
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.fill('Reply with exactly: "Edited answer."')
  await page.locator('button[title="Save edit"]').click()

  // Wait for the new stream to start and finish
  await expect(
    page.locator('.cursor').or(page.locator('.waiting-indicator'))
  ).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // New answer should reflect the edited prompt
  await expect(page.locator('.message.assistant .md').first())
    .toContainText('Edited answer', { timeout: 5_000 })

  // ── Sibling nav should show 2/2 after reloadMessages() hydration ──
  const siblingLabel = page.locator('.sibling-label').first()
  await expect(siblingLabel).toBeVisible({ timeout: 10_000 })
  await expect(siblingLabel).toHaveText('2/2')

  // ── Navigate back to the original (1/2) ──
  await page.locator('.sibling-btn[title="Previous variant"]').first().click()
  await expect(siblingLabel).toHaveText('1/2', { timeout: 10_000 })

  // Original question and answer should be visible
  await expect(page.locator('.message.user'))
    .toContainText('Reply with exactly: "Original answer."', { timeout: 5_000 })

  // ── Reload → active branch (1/2) persists ──
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.sibling-label').first()).toHaveText('1/2', { timeout: 10_000 })
  await expect(page.locator('.message.user'))
    .toContainText('Reply with exactly: "Original answer."', { timeout: 5_000 })

  // Navigate forward again to confirm 2/2 still works
  await page.locator('.sibling-btn[title="Next variant"]').first().click()
  await expect(page.locator('.sibling-label').first()).toHaveText('2/2', { timeout: 10_000 })
})
