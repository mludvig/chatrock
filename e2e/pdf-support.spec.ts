/**
 * End-to-end test: switching a chat with PDFs to a model without PDF support (GPT-6.2 Sol)
 * warns about the PDFs in its history, blocks sending a pending PDF, refuses a new one, and
 * still answers once the pending PDF is removed.
 * See docs/adr/0071-pdf-support-separate-from-text-documents.md.
 */
import { test, expect, type Page } from '@playwright/test'
import * as path from 'path'

const PDF_FIXTURE = path.join(__dirname, 'fixtures', 'secret.pdf')

async function attach(page: Page, file: string) {
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.btn-attach').click(),
  ])
  await fileChooser.setFiles([file])
}

async function waitForTurnDone(page: Page, assistantCount: number) {
  await expect(page.locator('.message.assistant')).toHaveCount(assistantCount, { timeout: 30_000 })
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 180_000 })
  await expect(page.locator('.error-banner:not(.warning)')).toHaveCount(0)
}

test('a model without PDF support warns about PDFs instead of failing', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: 'GPT-6.1 Sol' })

  await attach(page, PDF_FIXTURE)
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })
  const input = page.locator('.message-input')
  await input.fill('What is the secret word in the attached PDF? One word.')
  await input.press('Enter')
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await waitForTurnDone(page, 1)
  await expect(page.locator('.message.assistant').last()).toContainText(/pelican/i, { timeout: 60_000 })

  // A PDF pending in the tray when switching to a model that can't read it blocks Send.
  await attach(page, PDF_FIXTURE)
  await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })
  await page.locator('.model-picker').selectOption({ label: 'GPT-6.2 Sol' })
  await expect(page.locator('.error-banner.warning')).toContainText(/GPT-6.2 Sol can't read the PDF earlier in this chat/)
  await expect(page.locator('.attachment-tray-item.error')).toHaveCount(1)
  await input.fill('What is 2 + 2? Digits only.')
  await expect(page.locator('.btn-send')).toBeDisabled()

  // A new PDF is refused outright.
  await attach(page, PDF_FIXTURE)
  await expect(page.locator('.toast--error')).toContainText(/can't read PDFs.*secret\.pdf/)

  // With the pending PDF removed, the turn runs; the PDF in history reaches the model as a note.
  await page.locator('.attachment-tray-item .tray-remove').click()
  await expect(page.locator('.btn-send')).toBeEnabled()
  await page.locator('.btn-send').click()
  await waitForTurnDone(page, 2)
  await expect(page.locator('.message.assistant').last()).toContainText('4', { timeout: 60_000 })

  // Dismissing the history notice keeps it hidden for this chat and model.
  await page.locator('.error-banner.warning button[title="Dismiss"]').click()
  await expect(page.locator('.error-banner.warning')).toHaveCount(0)
})
