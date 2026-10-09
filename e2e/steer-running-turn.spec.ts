/**
 * End-to-end test: a message sent while a turn runs is queued and steers it
 * (docs/adr/0059-queued-user-messages-steer-a-running-turn.md).
 *
 * Send stays enabled beside Stop. The message shows dimmed after the live answer until the
 * server injects it at the next tool boundary (or runs it as the next turn), after which it
 * is an ordinary user bubble that survives a reload, followed by an answer.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

const slowQuestion = readFileSync(join(__dirname, '..', 'research-question.tmp'), 'utf-8').trim()
const steer = 'Keep it short: three bullet points at most.'

test('a message sent mid-turn is queued, then becomes a normal user turn with an answer after it', async ({ page }) => {
  test.setTimeout(420_000)

  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })
  await page.locator('select[title="Response mode"]').selectOption('extended')
  await page.locator('.message-input').fill(slowQuestion)
  await page.locator('.btn-send').click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.btn-stop')).toBeVisible({ timeout: 20_000 })

  // Send is still offered next to Stop while the turn runs.
  const send = page.locator('.btn-send:not(.btn-stop)')
  await page.locator('.message-input').fill(steer)
  await expect(send).toBeEnabled()
  await send.click()
  await expect(page.locator('.message-queued', { hasText: steer })).toBeVisible({ timeout: 5_000 })

  // Injected at a tool boundary (or run as the next turn): it leaves the queue and becomes a
  // regular user bubble.
  await expect(page.locator('.message-queued')).toHaveCount(0, { timeout: 300_000 })
  await expect(page.locator('.message.user', { hasText: steer })).toBeVisible()
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 300_000 })

  // Persisted as its own user turn in the transcript, answered after it.
  await page.reload()
  await expect(page.locator('.message.user')).toHaveCount(2, { timeout: 20_000 })
  await expect(page.locator('.message.user').nth(1)).toContainText(steer)
  await expect(page.locator('.message').last()).toHaveClass(/assistant/)
})
