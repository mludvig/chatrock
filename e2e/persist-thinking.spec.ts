/**
 * End-to-end test: thinking + tool call results persist across page reload.
 *
 * Scenario:
 *  1. Start a new chat with a thinking-capable model
 *  2. Send a prompt that forces a web search
 *  3. Verify thinking block + search result cards appear during streaming
 *  4. Wait for streaming to finish
 *  5. Reload the page
 *  6. Assert thinking block + search result cards STILL render after reload
 *     (this is the regression this increment fixes — previously they disappeared)
 */
import { test, expect } from '@playwright/test'
import { THINKING_MODEL_LABEL } from './testConfig'

test('thinking and search results survive page reload', async ({ page }) => {
  // Navigate to a new chat
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  // Select a thinking-capable model
  const modelSelect = page.locator('.model-picker')
  await modelSelect.selectOption({ label: THINKING_MODEL_LABEL })

  // Thinking effort is a composer select. Pick 'high': thinking is adaptive, so at
  // 'low' the model routinely answers with no thinking block at all.
  await page.getByLabel('Thinking effort', { exact: true }).selectOption('high')

  // Send a prompt that will trigger a web search
  const input = page.locator('.message-input')
  // Asks for a calculation on top of the lookup: adaptive thinking skips a plain lookup.
  await input.fill('Search the web for the current AWS Lambda maximum timeout value and cite your sources. Then think carefully: how many back-to-back 7-minute-23-second jobs fit in one maximum-length invocation, and how many seconds are left over?')
  await input.press('Enter')

  // Processing indicator appears first
  await expect(page.locator('.waiting-indicator')).toBeVisible({ timeout: 10_000 })

  // At some point a thinking block should appear (Sonnet with thinking enabled)
  await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 60_000 })

  // A web search tool pill should appear (model may emit multiple tool calls)
  await expect(page.locator('.tool-pill').first()).toBeVisible({ timeout: 60_000 })

  // Wait for streaming to complete. The cursor is absent between agentic rounds too, so
  // it alone is not a done-signal — the turn is over once the composer swaps its Stop
  // button back for Send. (btn-send enabled is no signal either: it's also disabled when
  // the input is empty.)
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 120_000 })
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 120_000 })

  // Capture the current chat URL (now has a real chatId)
  const chatUrl = page.url()
  expect(chatUrl).toMatch(/\/c\/[^/]+$/)
  expect(chatUrl).not.toContain('/c/new')

  // Expand the web_search pill to reveal its result cards. Target it by label: a
  // web_fetch pill carries no cards, so ".first()" is not necessarily the right one.
  const searchPill = page.locator('.tool-pill').filter({ hasText: 'Search:' }).first()
  await expect(searchPill).not.toHaveClass(/pending/, { timeout: 30_000 })
  await searchPill.locator('.tool-pill-header').click()
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
  await expect(page.locator('.thinking-block').first()).toBeVisible({ timeout: 10_000 })

  // Tool pill(s) should still render
  await expect(page.locator('.tool-pill').first()).toBeVisible({ timeout: 5_000 })

  // Expand the same pill again and verify search result cards are back
  await page.locator('.tool-pill').filter({ hasText: 'Search:' }).first()
    .locator('.tool-pill-header').click()
  const cardCountAfter = await page.locator('.search-result-card').count()
  expect(cardCountAfter).toBeGreaterThanOrEqual(1)

  // The answer text should also be present
  await expect(page.locator('.message.assistant .md')).toBeVisible({ timeout: 5_000 })
})
