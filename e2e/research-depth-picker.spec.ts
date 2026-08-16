/**
 * End-to-end test: composer research-depth picker.
 *
 * Scenario:
 *  1. Start a new chat — the depth picker defaults to Brief with zero configuration.
 *  2. Switch it to Extended — the selection sticks in the composer for this session.
 *  3. Send a short deterministic prompt at Extended; the picker's value is unchanged
 *     after the send completes (it doesn't silently reset to Brief).
 */
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

test('depth picker defaults to Brief and sticks once changed', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').first().selectOption({ label: FAST_MODEL_LABEL })

  const depthPicker = page.locator('select[title^="Research depth"]')
  await expect(depthPicker).toBeVisible({ timeout: 5_000 })
  await expect(depthPicker).toHaveValue('brief')

  await depthPicker.selectOption('extended')
  await expect(depthPicker).toHaveValue('extended')

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Depth picker test."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })

  // Picker still reflects Extended after the send — it doesn't reset per-message.
  await expect(depthPicker).toHaveValue('extended')
})
