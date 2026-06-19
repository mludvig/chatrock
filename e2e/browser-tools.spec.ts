import { test, expect } from '@playwright/test'

test.describe('AgentCore Browser tools (take_screenshot / get_rendered_page)', () => {
  test.use({ storageState: '.auth/state.json' })

  test('take_screenshot resolves with a clickable thumbnail, not raw JSON', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    await page.locator('.message-input').fill(
      'Use the take_screenshot tool to take a screenshot of https://example.com.',
    )
    await page.locator('.btn-send').click()

    const pill = page.locator('.tool-pill', { hasText: 'Screenshot:' }).first()
    await expect(pill).toBeVisible({ timeout: 60000 })
    await expect(pill).not.toHaveClass(/pending/, { timeout: 60000 })
    await expect(pill).not.toHaveClass(/error/)

    // Expand it and confirm a real thumbnail rendered — never the raw {"texts":...} envelope.
    await pill.locator('.tool-pill-header').click()
    const thumbnail = pill.locator('.browser-screenshots img').first()
    await expect(thumbnail).toBeVisible({ timeout: 10000 })
    await expect(pill.locator('.tool-result-body')).not.toContainText('screenshotUrls')

    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })

    // Reload and confirm the same thumbnail still renders via GET /messages (no re-stream).
    await page.reload()
    await page.waitForLoadState('networkidle')
    const reloadedPill = page.locator('.tool-pill', { hasText: 'Screenshot:' }).first()
    await reloadedPill.locator('.tool-pill-header').click()
    await expect(reloadedPill.locator('.browser-screenshots img').first()).toBeVisible({ timeout: 10000 })
  })

  test('get_rendered_page resolves with a Fetch-style result card (not the raw Playwright trace)', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    await page.locator('.message-input').fill(
      'Use the get_rendered_page tool to load https://example.com and tell me its page title.',
    )
    await page.locator('.btn-send').click()

    const pill = page.locator('.tool-pill', { hasText: 'Page:' }).first()
    await expect(pill).toBeVisible({ timeout: 60000 })
    await expect(pill).not.toHaveClass(/pending/, { timeout: 60000 })
    await expect(pill).not.toHaveClass(/error/)

    await pill.locator('.tool-pill-header').click()
    // Reuses the same SearchResultCard as web_fetch — not a raw <pre> trace dump, and never
    // the navigate step's noise (code echo / dead /tmp file link).
    const card = pill.locator('.search-result-card').first()
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(pill.locator('.tool-result-body')).not.toContainText('Ran Playwright code')
    await expect(pill.locator('.tool-result-body')).not.toContainText('/tmp/')

    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })
  })
})
