/**
 * End-to-end test: re-run an assistant answer.
 *
 * Scenario:
 *  1. Start a new chat (Sonnet 4.6)
 *  2. Send a short prompt; wait for streaming to finish
 *  3. Hover the assistant bubble → Re-run button appears
 *  4. Click Re-run → a new answer streams and finalises
 *  5. Assert the user prompt is still visible and a fresh answer appears
 *  6. Reload → the active-path (re-run) answer is shown, user prompt present
 */
import { test, expect } from '@playwright/test'

test('re-run produces a new answer and persists after reload', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  // Use Sonnet 4.6 (known-good model, no data-retention issues)
  await page.locator('.model-select').selectOption({ label: 'Claude Sonnet 4.6' })

  // Send a short deterministic prompt
  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Hello from test one."')
  await input.press('Enter')

  // Wait for the URL to change from /c/new → /c/<chatId>
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })

  // Wait for the assistant answer to appear and streaming to complete
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  const chatUrl = page.url()
  expect(chatUrl).toMatch(/\/c\/[^/]+$/)

  // The original answer text should be present
  await expect(page.locator('.message.assistant')).toContainText('Hello from test one', { timeout: 5_000 })

  // ── Re-run ────────────────────────────────────────────────────────────────

  // Hover the assistant bubble to reveal the Re-run button
  await page.locator('.message.assistant').hover()
  const rerunBtn = page.locator('.message.assistant .action-btn[title="Re-run this answer"]')
  await expect(rerunBtn).toBeVisible({ timeout: 5_000 })

  // Click Re-run
  await rerunBtn.click()

  // A new streaming answer should start (waiting indicator or cursor appears)
  // Give it a moment then wait for the new stream to complete
  await expect(page.locator('.cursor').or(page.locator('.waiting-indicator')))
    .toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // The user prompt should still be present
  await expect(page.locator('.message.user')).toContainText('Reply with exactly', { timeout: 5_000 })

  // An assistant answer should still be visible (the re-run result)
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 5_000 })

  // ── Reload → active path (re-run answer) persists ────────────────────────
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })

  // User prompt still visible after reload
  await expect(page.locator('.message.user')).toContainText('Reply with exactly', { timeout: 5_000 })

  // Re-run button is present on the reloaded answer (has parentId)
  await page.locator('.message.assistant').hover()
  await expect(
    page.locator('.message.assistant .action-btn[title="Re-run this answer"]')
  ).toBeVisible({ timeout: 5_000 })
})
