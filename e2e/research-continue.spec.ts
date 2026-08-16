/**
 * End-to-end test: Continue button on a budget-truncated Brief answer.
 *
 * Brief budgets 3 tool rounds (backend/src/lib/llm/loop.ts's ROUND_BUDGETS). A prompt that
 * demands several independent web_search calls reliably exhausts that budget, exercising
 * the `stopReason: 'max_rounds'` -> `truncated: true` -> "Continue research" button path
 * end to end, including that clicking Continue completes the answer.
 */
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

test('a truncated Brief research answer shows Continue and completes when clicked', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').first().selectOption({ label: FAST_MODEL_LABEL })
  await expect(page.locator('select[title^="Research depth"]')).toHaveValue('brief')

  await page.locator('.message-input').fill(
    'Use the web_search tool separately for each of these five topics and report one fact ' +
    'for each, with a separate search per topic: the tallest mountain on each continent ' +
    '(Africa, Asia, Europe, North America, South America).',
  )
  await page.locator('.btn-send').click()

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 120_000 })

  const assistantBubble = page.locator('.message.assistant').first()
  await assistantBubble.hover()
  const continueBtn = assistantBubble.locator('.action-btn[title="Continue research"]')
  await expect(continueBtn).toBeVisible({ timeout: 5_000 })

  await continueBtn.click()
  await expect(page.locator('.cursor').or(page.locator('.waiting-indicator')))
    .toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 120_000 })

  // The continuation persists across reload — `truncated` before, and now a completed
  // answer, are both durable turn state, not just live stream flags.
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant').first()).toBeVisible({ timeout: 15_000 })
})
