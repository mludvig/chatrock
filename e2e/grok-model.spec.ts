/**
 * End-to-end test: Grok on Bedrock Converse reads an image and a text file (sent inline, as it
 * rejects document blocks), and the composer refuses a PDF because the model has pdf:false.
 * See docs/adr/0071-pdf-support-separate-from-text-documents.md.
 */
import { test, expect } from '@playwright/test'
import * as path from 'path'

const GROK_LABEL = 'Grok 4.7'
// A real icon, not fixtures/test-image.png: a 1x1 pixel image tells the model nothing.
const PNG_FIXTURE = path.join(__dirname, '..', 'frontend', 'public', 'icon-192.png')
const TXT_FIXTURE = path.join(__dirname, 'fixtures', 'hello.txt')
const PDF_FIXTURE = path.join(__dirname, 'fixtures', 'secret.pdf')

test(`${GROK_LABEL}: image and text file answered, PDF refused`, async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: GROK_LABEL })

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles([PNG_FIXTURE, TXT_FIXTURE, PDF_FIXTURE])
  await expect(page.locator('.toast--error')).toContainText(/can't read PDFs.*secret\.pdf/)
  await expect(page.locator('.attachment-tray-item')).toHaveCount(2, { timeout: 5_000 })
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

  const input = page.locator('.message-input')
  await input.fill('In one sentence each: what is the main colour of the image, and what does the text file say?')
  await input.press('Enter')
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 120_000 })
  await expect(page.locator('.error-banner:not(.warning)')).toHaveCount(0)
  await expect(page.locator('.message.assistant').last()).toContainText(/blue/i, { timeout: 60_000 })
  await expect(page.locator('.message.assistant').last()).toContainText(/hello|chatrock/i, { timeout: 60_000 })
})
