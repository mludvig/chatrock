/**
 * A message fetch that was started for the chat being viewed must not paint over the new-chat
 * draft if the user clicks "+" before that fetch comes back.
 */
import { test, expect } from '@playwright/test'
import { openApp, newChat, request } from './ux.helpers'

test('a slow message reload does not paint the previous chat over a new chat', async ({ page }) => {
  await openApp(page)
  const chat = await newChat(page)
  try {
    await page.goto(`/c/${chat.chatId}`)
    await expect(page.locator(`.sidebar a[href="/c/${chat.chatId}"]`)).toBeVisible()
    await expect(page.locator('.messages-skeleton')).toHaveCount(0)

    // Hold the next /messages response for this chat until the user has moved to /c/new.
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    let intercepted!: () => void
    const wasIntercepted = new Promise<void>(resolve => { intercepted = resolve })
    let served!: () => void
    const wasServed = new Promise<void>(resolve => { served = resolve })
    await page.route(`**/api/chats/${chat.chatId}/messages*`, async route => {
      intercepted()
      await released
      await route.fulfill({
        json: {
          bubbles: [{ msgId: 'stale-1', role: 'user', steps: [{ kind: 'text', text: 'STALE CHAT CONTENT' }], model: '', createdAt: new Date().toISOString() }],
          conversationUsage: { inputTokens: 0, outputTokens: 0 },
          hasMore: false, oldestMsgId: null, streaming: false,
        },
      })
      served()
    })

    // Returning to the tab triggers a refetch of the viewed chat.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await wasIntercepted
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect(page).toHaveURL(/\/c\/new$/)

    release()
    await wasServed
    await page.waitForTimeout(500)
    await expect(page.locator('.messages')).not.toContainText('STALE CHAT CONTENT')
    await expect(page.locator('.chat-empty')).toBeVisible()
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await request(page, 'DELETE', `/chats/${chat.chatId}`)
  }
})
