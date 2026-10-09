/**
 * End-to-end test: Grok on Bedrock Converse reads an image attachment, and the composer
 * refuses a document attachment because the model has documents:false (config/models.ts).
 */
import { test, expect } from '@playwright/test'
import * as path from 'path'

const GROK_LABEL = 'Grok 4.7'
// A real icon, not fixtures/test-image.png: a 1x1 pixel image tells the model nothing.
const PNG_FIXTURE = path.join(__dirname, '..', 'frontend', 'public', 'icon-192.png')
const TXT_FIXTURE = path.join(__dirname, 'fixtures', 'hello.txt')

test(`${GROK_LABEL}: image attachment answered, document attachment refused`, async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: GROK_LABEL })

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles([PNG_FIXTURE, TXT_FIXTURE])
  await expect(page.locator('.toast--error')).toContainText(/can't read documents.*hello\.txt/)
  await expect(page.locator('.attachment-tray-item')).toHaveCount(1, { timeout: 5_000 })
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

  const input = page.locator('.message-input')
  await input.fill('What is the main colour of this image? One word.')
  await input.press('Enter')
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.btn-send:not(.btn-stop)')).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.error-banner:not(.warning)')).toHaveCount(0)
  await expect(page.locator('.message.assistant').last()).toContainText(/blue/i, { timeout: 60_000 })
})
