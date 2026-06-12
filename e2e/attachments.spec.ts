/**
 * End-to-end tests: file attachments — upload via file picker, verify tray,
 * verify attachment blocks in bubbles, and reload persistence.
 *
 * Uses Claude Haiku 4.5 for speed; all models have attachments: true.
 * Auth state is provided by the project-level storageState in playwright.config.ts.
 */
import { test, expect } from '@playwright/test'
import * as path from 'path'

const PNG_FIXTURE = path.join(__dirname, 'fixtures', 'test-image.png')
const TXT_FIXTURE = path.join(__dirname, 'fixtures', 'hello.txt')

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Navigate to a new chat, wait for the view to be ready, select model. */
async function startNewChat(page: import('@playwright/test').Page) {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-select').selectOption({ label: 'Claude Haiku 4.5' })
}

/** Wait for streaming to fully finish. */
async function waitForStreamDone(page: import('@playwright/test').Page) {
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('attach PNG via file picker: tray shows filename, bubble shows image block, assistant responds', async ({ page }) => {
  await startNewChat(page)

  // Click the paperclip button and intercept the file chooser
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles(PNG_FIXTURE)

  // Attachment tray should appear with the filename
  await expect(page.locator('.attachment-tray')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.attachment-tray-item .tray-filename')).toContainText('test-image.png', { timeout: 5_000 })

  // Wait for upload to complete (tray item leaves 'uploading' state)
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

  // Type a message and send
  const input = page.locator('.message-input')
  await input.fill('What colour is this image? Reply in one sentence.')
  await input.press('Enter')

  // URL changes from /c/new → /c/<chatId>
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })

  // Wait for stream to finish
  await waitForStreamDone(page)

  // User bubble should contain the image attachment block
  await expect(page.locator('.message.user .attachment-block--image')).toBeVisible({ timeout: 10_000 })

  // Filename should be visible in the bubble
  await expect(page.locator('.message.user .attachment-block--image .attachment-filename'))
    .toContainText('test-image.png', { timeout: 5_000 })

  // Assistant reply must be present
  await expect(page.locator('.message.assistant .md')).toBeVisible({ timeout: 10_000 })
})

test('attach text file: tray shows chip, bubble shows doc block, assistant responds', async ({ page }) => {
  await startNewChat(page)

  // Attach the text fixture
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles(TXT_FIXTURE)

  // Tray item appears
  await expect(page.locator('.attachment-tray')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.attachment-tray-item .tray-filename')).toContainText('hello.txt', { timeout: 5_000 })

  // Wait for upload to complete
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

  // Send with a question about the file contents
  const input = page.locator('.message-input')
  await input.fill('What does this file say? Reply in one sentence.')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await waitForStreamDone(page)

  // User bubble should contain the document attachment block
  await expect(page.locator('.message.user .attachment-block--doc')).toBeVisible({ timeout: 10_000 })

  // Filename chip visible in the bubble
  await expect(page.locator('.message.user .attachment-block--doc .attachment-filename'))
    .toContainText('hello.txt', { timeout: 5_000 })

  // Assistant reply present — ideally mentions "Hello" or "test"
  await expect(page.locator('.message.assistant .md')).toBeVisible({ timeout: 10_000 })
})

test('attachment persists after reload: image block still visible from signed URL', async ({ page }) => {
  await startNewChat(page)

  // Attach PNG and send
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles(PNG_FIXTURE)

  // Wait for upload to finish
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

  const input = page.locator('.message-input')
  await input.fill('Describe this image briefly.')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  const chatUrl = page.url()

  await waitForStreamDone(page)

  // Confirm attachment block is present before reload
  await expect(page.locator('.message.user .attachment-block--image')).toBeVisible({ timeout: 5_000 })

  // Reload the same chat URL
  await page.goto(chatUrl)
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.user')).toBeVisible({ timeout: 15_000 })

  // Attachment block must still render (served from CloudFront signed URL)
  await expect(page.locator('.message.user .attachment-block--image')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.message.user .attachment-block--image .attachment-filename'))
    .toContainText('test-image.png', { timeout: 5_000 })

  // Assistant reply persists too
  await expect(page.locator('.message.assistant .md')).toBeVisible({ timeout: 10_000 })
})
