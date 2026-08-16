/**
 * End-to-end test: Deep Research plan-approval gate.
 *
 * Scenario:
 *  1. Switch the composer to Deep Research and send a question.
 *  2. Wait for recon/planning to produce a plan (awaiting_approval).
 *  3. Typing substantive feedback switches the single action button to "Revise";
 *     submitting it produces an updated plan, still awaiting approval.
 *  4. Leaving the feedback box empty keeps the button on "Approve"; submitting it
 *     starts the run (status leaves awaiting_approval) and a research bubble is shown.
 */
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

test('plan approval: revise on substantive feedback, approve on empty input', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').first().selectOption({ label: FAST_MODEL_LABEL })
  await page.locator('select[title^="Research depth"]').selectOption('deep')

  await page.locator('.message-input').fill('What are the main causes of coral bleaching?')
  await page.locator('.btn-send').click()

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.research-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.research-panel-plan')).toBeVisible({ timeout: 120_000 })

  const feedback = page.locator('.research-panel-feedback')
  const actionBtn = page.locator('.research-panel-actions button')

  // Empty input -> Approve.
  await expect(actionBtn).toHaveText(/Approve/, { timeout: 5_000 })

  // Substantive feedback -> button switches to Revise.
  await feedback.fill('Also add a sub-question specifically about ocean acidification.')
  await expect(actionBtn).toHaveText(/Revise/, { timeout: 5_000 })

  await actionBtn.click()
  // A revised plan still awaits approval — the panel doesn't disappear.
  await expect(page.locator('.research-panel-plan')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.research-panel-feedback')).toHaveValue('')

  // Now approve with no feedback — the run leaves awaiting_approval and starts researching.
  await expect(actionBtn).toHaveText(/Approve/, { timeout: 5_000 })
  await actionBtn.click()
  await expect(page.locator('.research-panel-plan')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.research-panel-status')).toBeVisible({ timeout: 15_000 })
})
