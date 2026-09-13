import { test, expect } from '@playwright/test'
import { openApp, assertFits, newProject, request } from './ux.helpers'

test('phone dialogs trap focus and restore navigation after Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  await page.getByTitle('Chat details', { exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTitle('Chat details', { exact: true })).toBeFocused()
  await assertFits(page, '.chat-header button, .composer-toolbar > *')
})

test('long project names and reasoning controls fit a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await openApp(page)
  const p = await newProject(page, 'A very long project name with several words that must not displace navigation')
  try {
    await page.goto(`/c/new?project=${p.projectId}`)
    await expect(page.getByLabel('Project', { exact: true })).toHaveValue(p.projectId)
    await assertFits(page, '.chat-header button, .chat-header select, .composer-toolbar > *')
    await page.locator('.message-input').focus()
    await expect(page.locator('.chat-header')).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('cached models remain available if model refresh fails', async ({ page }) => {
  await openApp(page)
  await page.route('**/api/models', route => route.abort())
  await page.reload()
  await expect(page.locator('.model-picker option').first()).toBeAttached()
  expect(await page.locator('.model-picker option').count()).toBeGreaterThan(1)
})
