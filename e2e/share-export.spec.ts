import { test, expect } from '@playwright/test'
import { THINKING_MODEL_LABEL } from './testConfig'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function sendOneMessage(page: import('@playwright/test').Page) {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })
  await page.locator('.model-picker').selectOption({ label: THINKING_MODEL_LABEL })

  const input = page.locator('.message-input')
  await input.fill('Reply with exactly: "Share test answer."')
  await input.press('Enter')

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.assistant')).toContainText('Share test answer', { timeout: 30_000 })
  await expect(page.locator('.cursor')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.message-input')).toBeEnabled({ timeout: 10_000 })
}

test('create a share link, open it unauthenticated, then revoke it', async ({ page, context }) => {
  await sendOneMessage(page)

  await page.locator('.btn-icon[title="Chat details"]').click()
  await expect(page.locator('.prefs-tab', { hasText: 'Share' })).toBeVisible({ timeout: 5_000 })
  await page.locator('.prefs-tab', { hasText: 'Share' }).click()

  await page.locator('button', { hasText: 'Create share link' }).click()

  // A successful create copies the link to the clipboard and lists it — assert both, since
  // either failing is exactly the "Not found" 404 regression this test guards against.
  await expect(page.locator('.share-list-item')).toHaveCount(1, { timeout: 10_000 })
  const shareUrl = await page.locator('.share-list-url').first().getAttribute('href')
  expect(shareUrl).toBeTruthy()

  // Open the share link in a brand-new, unauthenticated browser context (no Cognito session,
  // no localStorage) — this is the actual "paste the link anywhere" scenario.
  const publicContext = await context.browser()!.newContext()
  const publicPage = await publicContext.newPage()
  const res = await publicPage.goto(shareUrl!)
  expect(res?.status()).toBe(200)
  await expect(publicPage.locator('body')).toContainText('Share test answer', { timeout: 10_000 })
  await publicContext.close()

  // Revoke, then confirm the link is dead. The confirm() dialog fires synchronously as part of
  // the click, so the listener must be registered BEFORE clicking — Playwright auto-dismisses
  // any dialog with no listener attached yet, which would silently no-op the revoke.
  page.once('dialog', d => d.accept())
  await page.locator('.share-list-item .action-btn[title="Revoke"]').click()
  await expect(page.locator('.share-list-item')).toHaveCount(0, { timeout: 10_000 })

  // Browser navigation (not page.request.get — its APIRequestContext hits sporadic ECONNRESETs
  // against this CloudFront distribution, unrelated to the app) confirms the link is dead.
  const revokedContext = await context.browser()!.newContext()
  const revokedPage = await revokedContext.newPage()
  const revokedRes = await revokedPage.goto(shareUrl!)
  expect(revokedRes?.status()).toBe(404)
  await revokedContext.close()
})

test('Markdown export downloads a .md file with clear turn separators', async ({ page }) => {
  await sendOneMessage(page)

  await page.locator('.btn-icon[title="Chat details"]').click()
  await page.locator('.prefs-tab', { hasText: 'Share' }).click()

  const downloadPromise = page.waitForEvent('download')
  await page.locator('button', { hasText: 'Download Markdown' }).click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toMatch(/\.md$/)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf-8')

  expect(text).toContain('## User')
  expect(text).toContain('## Assistant')
  expect(text).toContain('Share test answer')
})
