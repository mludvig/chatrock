/**
 * End-to-end test: concurrent per-chat streaming
 * (docs/adr/0040-concurrent-per-chat-streaming.md).
 *
 * A deep-research turn can run for many minutes. Starting one must not lock the user out
 * of every other chat — sendingByChat/streamingByChat are keyed per chatId, not one global
 * flag, and cancelling one chat's turn can only ever target that chat, never whichever chat
 * happens to be in flight at the same moment on the same connection. This drives two chats
 * concurrently and checks both claims.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

const slowQuestion = readFileSync(join(__dirname, '..', 'research-question.tmp'), 'utf-8').trim()

test('a background chat keeps streaming while a foreground chat sends, and cancel stays scoped to one chat', async ({ page }) => {
  test.setTimeout(300_000)

  // Chat A: a Deep-depth turn, slow enough to still be running for the rest of this test.
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })
  await page.locator('select[title^="Research depth"]').selectOption('deep')
  await page.locator('.message-input').fill(slowQuestion)
  await page.locator('.btn-send').click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const chatIdA = /\/c\/([^/]+)$/.exec(page.url())![1]
  // The URL updates as soon as the chat is created; sending flips true slightly later,
  // once the ack frame lands (armAckWatchdog budgets up to 12s for that — realtime-reliability.md).
  await expect(page.locator('.btn-stop')).toBeVisible({ timeout: 20_000 })

  // Navigate to a brand-new chat — client-side, so chat A's in-memory per-chat state
  // survives (a page.goto/reload here would wipe sendingByChat/streamingByChat, since they
  // are deliberately not persisted — frontend/CLAUDE.md's "Persisted Zustand state" list).
  await page.locator('button.btn-new[title="New chat"]').click()
  await expect(page).toHaveURL(/\/c\/new$/)

  // Chat A is no longer the viewed chat, but its sidebar row still shows the "sending"
  // spinner — proof sendingByChat is keyed per chatId, not one global flag.
  await expect(page.getByTitle('Generating a response…')).toHaveCount(1)

  // Chat B: an ordinary fast turn, sent while A is still in flight.
  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })
  await page.locator('.message-input').fill('Give me one two-sentence fun fact about octopuses.')
  await page.locator('.btn-send').click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const chatIdB = /\/c\/([^/]+)$/.exec(page.url())![1]
  expect(chatIdB).not.toBe(chatIdA)
  await expect(page.locator('.btn-stop')).toBeVisible({ timeout: 20_000 })

  // Both chats are sending at once — two independent sidebar spinners, not one shared flag.
  await expect(page.getByTitle('Generating a response…')).toHaveCount(2)

  // Switch back to chat A — browser back, since the composer's post-send navigate() for a
  // new chat replaces the /c/new history entry (ChatView.tsx), so this lands exactly on
  // /c/<chatIdA> without needing a sidebar chatId selector.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/c/${chatIdA}$`))

  // A is still running — cancelling it here must not touch B's turn on the same connection.
  await expect(page.locator('.btn-stop')).toBeVisible({ timeout: 10_000 })
  await page.locator('.btn-stop').click()
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 15_000 })

  // Back to B: its turn was never cancelled and completes normally on its own.
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/c/${chatIdB}$`))
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message.assistant').last()).toBeVisible()
})
