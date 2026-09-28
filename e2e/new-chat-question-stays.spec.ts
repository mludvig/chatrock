/**
 * The first question of a new chat must stay on screen while its answer streams, even when the
 * post-navigate message fetch answers "no messages, not streaming" after the `ack` has arrived —
 * the backend acks before it persists the question or the streaming marker. See
 * docs/adr/0056-stale-sending-needs-a-quiet-stream.md.
 */
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'
import { request } from './ux.helpers'

test('the first question stays visible when an early message fetch reports nothing yet', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })

  // Hold the first /messages fetch until the answer is visibly streaming (so the ack has
  // landed), then answer it the way the backend does before it has persisted anything.
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let served!: () => void
  const wasServed = new Promise<void>(resolve => { served = resolve })
  let held = false
  await page.route('**/api/chats/*/messages*', async route => {
    if (held) return route.continue()
    held = true
    await released
    await route.fulfill({
      json: { bubbles: [], conversationUsage: { inputTokens: 0, outputTokens: 0 }, hasMore: false, oldestMsgId: null, streaming: false },
    })
    served()
  })

  const question = `Count from one to two hundred in words, one number per line. ${Date.now()}`
  await page.locator('.message-input').fill(question)
  await page.locator('.btn-send').click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const chatId = /\/c\/([^/]+)$/.exec(page.url())![1]
  try {
    await expect(page.locator('.message.assistant').last()).toContainText(/one/i, { timeout: 30_000 })
    release()
    await wasServed
    await page.waitForTimeout(300)
    // Immediate reads, not auto-retrying expects: the `done` reload repaints the question
    // anyway, so a retrying assertion would wait out the flicker instead of catching it.
    expect(await page.locator('.message.user', { hasText: question }).count()).toBe(1)
    expect(await page.locator('.btn-stop').count()).toBe(1)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})
