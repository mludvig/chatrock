import { test, expect } from '@playwright/test'
import { newChat, request } from './ux.helpers'

// Synthetic provider output keeps this regression deterministic without spending
// a full output budget. Auth and the throwaway chat use the live deployment.
for (const thinkingOnly of [true, false]) {
  test(`output-limit notice survives reload and Continue clears it (${thinkingOnly ? 'thinking only' : 'partial answer'})`, async ({ page }) => {
    let completed = false
    let sent: Record<string, unknown> | undefined
    await page.routeWebSocket('**/ws*', ws => {
      ws.onMessage(message => {
        const payload = JSON.parse(String(message))
        if (payload.action !== 'sendMessage') return
        sent = payload
        completed = true
        ws.send(JSON.stringify({ type: 'ack', chatId: payload.chatId }))
        ws.send(JSON.stringify({ type: 'delta', chatId: payload.chatId, text: 'Completed answer' }))
        ws.send(JSON.stringify({ type: 'done', chatId: payload.chatId, stopReason: 'end_turn' }))
      })
    })
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible()
    const { chatId } = await newChat(page)
    try {
      await page.route(`**/api/chats/${chatId}/messages*`, route => route.fulfill({
        json: {
          bubbles: [{
            msgId: 'limited-answer', parentId: null, role: 'assistant',
            model: 'global.anthropic.claude-haiku-5-5', createdAt: new Date().toISOString(),
            stopReason: completed ? 'end_turn' : 'max_tokens',
            steps: completed
              ? [{ kind: 'text', text: 'Completed answer' }]
              : thinkingOnly
                ? [{ kind: 'thinking', text: 'Still reasoning' }]
                : [{ kind: 'text', text: 'Partial answer' }],
          }],
          conversationUsage: { inputTokens: 0, outputTokens: 0 },
          streaming: false, hasMore: false, oldestMsgId: null,
        },
      }))
      await page.goto(`/c/${chatId}`)
      const notice = page.getByRole('status').filter({ hasText: 'Output limit reached.' })
      await expect(notice).toBeVisible()
      await expect(notice).toContainText(thinkingOnly ? 'before writing an answer' : 'This response used')
      await page.reload()
      await expect(notice).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      const button = notice.getByRole('button', { name: 'Continue', exact: true })
      await expect(button).toBeVisible()
      const bounds = await button.boundingBox()
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
      await button.click()
      await expect.poll(() => sent?.continue).toBe(true)
      expect(sent?.parentId).toBe('limited-answer')
      await expect(notice).toHaveCount(0)
      await expect(page.locator('.message.assistant')).toContainText('Completed answer')
      await page.reload()
      await expect(notice).toHaveCount(0)
      await expect(page.locator('.message.assistant')).toContainText('Completed answer')
    } finally {
      await request(page, 'DELETE', `/chats/${chatId}`)
    }
  })
}

test('Continue completes through the live Opus provider without assistant prefill', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible()
  await page.locator('.model-picker').selectOption('global.anthropic.claude-opus-5-5')
  await page.locator('select[title="Thinking effort"]').selectOption('low')
  await page.locator('.message-input').fill('Reply with exactly "Ready". Do not use tools.')
  await page.locator('.btn-send').click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/)
  const chatId = /\/c\/([^/]+)$/.exec(page.url())![1]
  try {
    await expect(page.locator('.message.assistant')).toContainText('Ready', { timeout: 60_000 })
    await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 60_000 })
    let showLimit = true
    await page.route(`**/api/chats/${chatId}/messages*`, async route => {
      const response = await route.fetch()
      const body = await response.json()
      if (showLimit) {
        for (const bubble of body.bubbles) {
          if (bubble.role === 'assistant') bubble.stopReason = 'max_tokens'
        }
      }
      await route.fulfill({ response, json: body })
    })
    await page.reload()
    const notice = page.getByRole('status').filter({ hasText: 'Output limit reached.' })
    await expect(notice).toBeVisible()
    showLimit = false
    await notice.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.locator('.btn-stop')).toBeVisible()
    await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 60_000 })
    const saved = await request<{ bubbles: Array<{ role: string; stopReason?: string; errored?: boolean }> }>(page, 'GET', `/chats/${chatId}/messages`)
    expect(saved.bubbles.filter(b => b.role === 'user')).toHaveLength(1)
    const answers = saved.bubbles.filter(b => b.role === 'assistant')
    expect(answers).toHaveLength(1)
    expect(answers[0].stopReason).toBe('end_turn')
    expect(answers[0].errored).not.toBe(true)
    await expect(notice).toHaveCount(0)
  } finally {
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})
