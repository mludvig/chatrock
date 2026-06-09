/**
 * End-to-end test: thinking + tool call results persist across page reload.
 *
 * Scenario:
 *  1. Start a new chat with a thinking-capable model (Sonnet 4.6)
 *  2. Send a prompt that forces a web search
 *  3. Verify thinking block + search result cards appear during streaming
 *  4. Wait for streaming to finish
 *  5. Reload the page
 *  6. Assert thinking block + search result cards STILL render after reload
 *     (this is the regression this increment fixes — previously they disappeared)
 */
import { test, expect } from '@playwright/test'

test('thinking and search results survive page reload', async ({ page }) => {
  // Navigate to a new chat
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  // Select a thinking-capable model: Claude Sonnet 4.6
  const modelSelect = page.locator('.model-select')
  await modelSelect.selectOption({ label: 'Claude Sonnet 4.6' })

  // Open settings and enable a thinking effort so thinking blocks appear
  await page.locator('button[title="Chat settings"]').click()
  // Enable thinking by clicking a non-off effort button (e.g. "Low")
  const lowEffortBtn = page.locator('.effort-btn', { hasText: 'Low' })
  if (await lowEffortBtn.isVisible()) {
    await lowEffortBtn.click()
  }

  // Send a prompt that will trigger a web search
  const input = page.locator('.message-input')
  await input.fill('Search the web for the current AWS Lambda maximum timeout value and cite your sources.')
  await input.press('Enter')

  // Processing indicator appears first
  await expect(page.locator('.waiting-indicator')).toBeVisible({ timeout: 10_000 })

  // At some point a thinking block should appear (Sonnet with thinking enabled)
  await expect(page.locator('.thinking-block')).toBeVisible({ timeout: 60_000 })

  // A web search tool pill should appear (model may emit multiple tool calls)
  await expect(page.locator('.tool-pill').first()).toBeVisible({ timeout: 60_000 })

  // Wait for streaming to complete — the blinking cursor disappears when done.
  // (Don't use btn-send enabled as a signal: it's also disabled when input is empty)
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 120_000 })

  // Capture the current chat URL (now has a real chatId)
  const chatUrl = page.url()
  expect(chatUrl).toMatch(/\/c\/[^/]+$/)
  expect(chatUrl).not.toContain('/c/new')

  // Expand the tool pill to reveal search result cards (if collapsed)
  const toolPillHeader = page.locator('.tool-pill-header').first()
  await toolPillHeader.click()
  await expect(page.locator('.search-result-card').first()).toBeVisible({ timeout: 5_000 })
  const cardCountBefore = await page.locator('.search-result-card').count()
  expect(cardCountBefore).toBeGreaterThanOrEqual(1)

  // ── Reload ────────────────────────────────────────────────────────────────
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })

  // Wait for messages to load from the API before asserting on their content.
  // (listMessages is async; the assistant bubble must be present before we
  //  look for the thinking block inside it.)
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })

  // After reload: thinking block should still render
  await expect(page.locator('.thinking-block')).toBeVisible({ timeout: 10_000 })

  // Tool pill(s) should still render
  await expect(page.locator('.tool-pill').first()).toBeVisible({ timeout: 5_000 })

  // Expand the tool pill again and verify search result cards are back
  await page.locator('.tool-pill-header').first().click()
  const cardCountAfter = await page.locator('.search-result-card').count()
  expect(cardCountAfter).toBeGreaterThanOrEqual(1)

  // The answer text should also be present
  await expect(page.locator('.message.assistant .md')).toBeVisible({ timeout: 5_000 })
})
