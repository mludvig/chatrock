/**
 * End-to-end test: Continue button on a budget-truncated Brief answer.
 *
 * Brief budgets 3 tool rounds (backend/src/lib/llm/loop.ts's ROUND_BUDGETS), but a round
 * runs its tool calls concurrently (docs/adr/0016-parallel-tool-execution.md) — a prompt
 * asking for several *independent* searches gets them all fired in round 1 and never
 * exhausts the budget. The prompt below forces genuine sequential dependency (each search
 * query is only knowable from the previous search's result), which can't be parallelized
 * away, to reliably exercise the `stopReason: 'max_rounds'` -> `truncated: true` ->
 * "Continue research" button path end to end, including that clicking Continue completes
 * the answer.
 */
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

test('a truncated Brief research answer shows Continue and completes when clicked', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })
  await expect(page.locator('select[title^="Research depth"]')).toHaveValue('brief')

  await page.locator('.message-input').fill(
    'Do this as a strictly sequential chain of web_search calls — one search at a time, ' +
    'each query built from the previous result, never batched or guessed ahead: ' +
    '(1) search for "wikipedia largest ocean by area" and note the ocean it names; ' +
    '(2) search for the exact name of the deepest trench in that ocean; ' +
    '(3) search for the exact name of the first expedition or vessel to reach the bottom ' +
    'of that trench; (4) search for the year that expedition took place; ' +
    '(5) search for the name of the expedition leader or vessel captain. ' +
    'You must not answer any step from prior knowledge — issue the search and use its ' +
    'result before moving to the next step. Report all five facts at the end.',
  )
  await page.locator('.btn-send').click()

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  // `.cursor` only marks a currently-streaming *text* step — it disappears the moment a
  // tool call starts, well before the turn itself is done. `.btn-stop` (bound to the
  // store's `sending` flag) is the reliable "whole turn finished" signal.
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 120_000 })

  const assistantBubble = page.locator('.message.assistant').first()
  await assistantBubble.hover()
  const continueBtn = assistantBubble.locator('.action-btn[title="Continue research"]')
  await expect(continueBtn).toBeVisible({ timeout: 5_000 })

  await continueBtn.click()
  await expect(page.locator('.btn-stop')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 120_000 })

  // The continuation persists across reload — `truncated` before, and now a completed
  // answer, are both durable turn state, not just live stream flags.
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant').first()).toBeVisible({ timeout: 15_000 })
})
