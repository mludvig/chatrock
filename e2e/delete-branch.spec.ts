import { test, expect } from '@playwright/test'

test('delete branch removes it and its descendants; other branch survives; reload confirms', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').selectOption({ label: 'Claude Haiku 4.5' })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Branch test base."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const chatUrl = page.url()

  // Wait for streaming to complete and messages reload
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Count /messages responses to wait for the post-stream reload (real DB msgIds)
  const messagesResponses: number[] = []
  page.on('response', res => {
    if (res.url().includes('/messages') && res.status() === 200) messagesResponses.push(Date.now())
  })

  // ── Create sibling via re-run ──
  const rerunBtn = page.locator('.message.assistant .action-btn[title="Re-run this answer"]')
  await expect(rerunBtn).toBeVisible({ timeout: 5_000 })
  await rerunBtn.click()

  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Wait for at least 1 /messages response (post-rerun reload)
  await expect(async () => {
    expect(messagesResponses.length).toBeGreaterThanOrEqual(1)
  }).toPass({ timeout: 15_000 })

  // Now there should be 2 assistant siblings: sibling nav shows 2/2
  await expect(page.locator('.sibling-label')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.sibling-label')).toContainText('/2', { timeout: 5_000 })

  // Navigate to the first sibling (1/2) so we can delete the second (the re-run)
  const prevBtn = page.locator('.sibling-btn[title="Previous variant"]')
  await expect(prevBtn).toBeEnabled({ timeout: 3_000 })
  await prevBtn.click()
  await expect(page.locator('.sibling-label')).toContainText('1/2', { timeout: 5_000 })

  // ── Delete the second sibling (currently non-active) ──
  // Navigate to 2/2 first so we can see its delete button
  const nextBtn = page.locator('.sibling-btn[title="Next variant"]')
  await nextBtn.click()
  await expect(page.locator('.sibling-label')).toContainText('2/2', { timeout: 5_000 })

  const deleteBtn = page.locator('.message.assistant .action-btn[title="Delete this branch"]')
  await expect(deleteBtn).toBeVisible({ timeout: 5_000 })

  // Intercept the confirm dialog
  page.once('dialog', dialog => dialog.accept())
  await deleteBtn.click()

  // Sibling nav should disappear (only 1 sibling left) and we should still see the assistant bubble
  await expect(page.locator('.sibling-label')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 5_000 })

  // ── Reload confirms the branch is gone ──
  await page.goto(chatUrl)
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.sibling-label')).toHaveCount(0, { timeout: 5_000 })
})

test('delete branch: dismissing the confirm dialog does nothing', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').selectOption({ label: 'Claude Haiku 4.5' })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "No delete."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })

  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Wait for post-stream reload
  await page.waitForTimeout(1500)

  const deleteBtn = page.locator('.message.assistant .action-btn[title="Delete this branch"]')
  await expect(deleteBtn).toBeVisible({ timeout: 5_000 })

  // Dismiss the dialog
  page.once('dialog', dialog => dialog.dismiss())
  await deleteBtn.click()

  // Message should still be there
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 3_000 })
})
