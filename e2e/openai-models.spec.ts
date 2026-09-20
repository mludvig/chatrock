/**
 * End-to-end test: every OpenAI GPT model answers through the bedrock-responses provider
 * (docs/adr/0048-openai-models-on-bedrock-runtime.md) — image + document attachments, a
 * web-search tool round, and a follow-up turn that replays the first turn's reasoning.
 */
import { test, expect, type Page } from '@playwright/test'
import * as path from 'path'

const GPT_MODEL_LABELS = ['GPT-5.6 Luna', 'GPT-5.6 Terra', 'GPT-5.6 Sol', 'GPT-6 Astra']
// A real icon, not fixtures/test-image.png: GPT silently ignores that 1x1 pixel image.
const PNG_FIXTURE = path.join(__dirname, '..', 'frontend', 'public', 'icon-192.png')
const TXT_FIXTURE = path.join(__dirname, 'fixtures', 'hello.txt')

async function waitForTurnDone(page: Page, assistantCount: number) {
  await expect(page.locator('.message.assistant')).toHaveCount(assistantCount, { timeout: 30_000 })
  await expect(page.locator('.btn-send:not(.btn-stop)')).toBeVisible({ timeout: 180_000 })
  await expect(page.locator('.error-banner:not(.warning)')).toHaveCount(0)
}

for (const label of GPT_MODEL_LABELS) {
  test(`${label}: attachments, tool call and follow-up turn`, async ({ page }) => {
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
    await page.locator('.model-picker').selectOption({ label })

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.btn-attach').click(),
    ])
    await fileChooser.setFiles([PNG_FIXTURE, TXT_FIXTURE])
    await expect(page.locator('.attachment-tray-item')).toHaveCount(2, { timeout: 5_000 })
    await expect(page.locator('.attachment-tray-item.uploading')).toHaveCount(0, { timeout: 30_000 })

    const input = page.locator('.message-input')
    await input.fill('In one sentence each: what colour is the image, what does the text file say, and — using web search — what is the current AWS Lambda maximum timeout?')
    await input.press('Enter')
    await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
    await waitForTurnDone(page, 1)

    await expect(page.locator('.tool-pill').first()).toBeVisible()
    // Retrying assertions double as the wait: the Send button can reappear between rounds.
    const answer = page.locator('.message.assistant').last()
    await expect(answer).toContainText(/blue/i, { timeout: 60_000 })
    await expect(answer).toContainText(/hello|chatrock/i, { timeout: 60_000 })

    await input.fill('Repeat the Lambda timeout you found, as a number of minutes only.')
    await input.press('Enter')
    await waitForTurnDone(page, 2)
    await expect(page.locator('.message.assistant').last()).toContainText(/15|90/, { timeout: 60_000 }) // 90 = Lambda Managed Instances' limit
  })
}
