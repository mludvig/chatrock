import { test, expect } from '@playwright/test'

test('fork on assistant bubble creates new chat with cloned thread; original unchanged', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').selectOption({ label: 'Claude Sonnet 4.6' })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Fork test answer."')

  // Set up the response watcher BEFORE pressing Enter so we capture the post-stream reload.
  // We need the SECOND /messages call (the post-stream reload that hydrates real DB msgIds),
  // not the first (which is the initial load triggered by URL change from /c/new → /c/<chatId>).
  // Approach: collect all /messages responses after the send, wait for at least 2.
  const messagesResponses: number[] = []
  page.on('response', res => {
    if (res.url().includes('/messages') && res.status() === 200) messagesResponses.push(Date.now())
  })

  await input.press('Enter')

  // Wait for URL change from /c/new → /c/<chatId>
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const originalUrl = page.url()

  // Wait for streaming to complete and messages to reload from DB
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Wait until we've seen at least 2 /messages calls: initial load + post-stream reload.
  // This guarantees the bubbles carry real DB msgIds before we click fork.
  await expect(async () => {
    expect(messagesResponses.length).toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 15_000 })

  // ── Fork on the assistant bubble ──
  const forkBtn = page.locator('.message.assistant .action-btn[title="Fork to a new chat (up to here)"]')
  await expect(forkBtn).toBeVisible({ timeout: 5_000 })
  await forkBtn.click()

  // URL should change to a DIFFERENT chat (not the original)
  await expect(async () => {
    expect(page.url()).not.toBe(originalUrl)
    expect(page.url()).toMatch(/\/c\/(?!new)[^/]+$/)
  }).toPass({ timeout: 15_000 })
  const forkedUrl = page.url()

  // Forked chat shows the cloned assistant answer
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant')).toContainText('Fork test answer', { timeout: 10_000 })

  // Sidebar shows at least one fork entry (title ends with "(fork)")
  await expect(page.locator('.chat-title').filter({ hasText: '(fork)' }).first()).toBeVisible({ timeout: 5_000 })

  // ── Original chat is unchanged ──
  await page.goto(originalUrl)
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant')).toContainText('Fork test answer', { timeout: 5_000 })

  // ── Reload forked chat → thread persists ──
  await page.goto(forkedUrl)
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant')).toContainText('Fork test answer', { timeout: 5_000 })
})

test('fork on user bubble: new chat opens with user text pre-filled as draft', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-select').selectOption({ label: 'Claude Sonnet 4.6' })

  const input = page.locator('.message-input')
  const questionText = 'Reply with exactly: "Before fork answer."'
  await input.fill(questionText)
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Send a second message to create a multi-turn conversation
  await input.fill('What did you just say?')
  await input.press('Enter')
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })

  // Wait for the messages reload that comes after the second stream's done event.
  // We can't distinguish it from other /messages calls, so we use the fact that
  // after reload the second user bubble has a real msgId (fork button appears).
  // Adding an extra wait avoids the race where finalizeStream shows a temp msgId.
  await page.waitForTimeout(1500)

  // ── Fork on the second user bubble ──
  const userBubbles = page.locator('.message.user')
  const secondUserBubble = userBubbles.nth(1)
  const forkBtn = secondUserBubble.locator('.action-btn[title="Fork to a new chat (up to here)"]')
  await expect(forkBtn).toBeVisible({ timeout: 5_000 })
  const originalUrl2 = page.url()
  await forkBtn.click()

  // URL should change to a DIFFERENT chat
  await expect(async () => {
    expect(page.url()).not.toBe(originalUrl2)
    expect(page.url()).toMatch(/\/c\/(?!new)[^/]+$/)
  }).toPass({ timeout: 15_000 })

  // Input should be pre-filled with the second user bubble's text
  await expect(page.locator('.message-input')).toHaveValue('What did you just say?', { timeout: 5_000 })

  // The forked chat should contain only the first exchange (1 user + 1 assistant),
  // NOT the second user turn ("What did you just say?") — it's in the input as a draft
  await expect(page.locator('.message.user')).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator('.message.user')).not.toContainText('What did you just say?', { timeout: 5_000 })
})
