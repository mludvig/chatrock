import { test, expect } from '@playwright/test'
import { openApp } from './ux.helpers'

test('personal defaults and advanced browsing have clear homes', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.prefs-panel')).toBeVisible()
  await expect(page.locator('.prefs-panel .pref-textarea')).toBeVisible()
  await page.getByText('Advanced browsing options', { exact: true }).click()
  await expect(page.getByText('Web search provider', { exact: true })).toBeVisible()
})

test('chat settings and reasoning remain available without crowding the composer', async ({ page }) => {
  await openApp(page)
  await page.getByTitle('Chat details', { exact: true }).click()
  await expect(page.getByRole('dialog').locator('.pref-textarea')).toBeVisible()
  await page.getByRole('dialog').getByText('Advanced tools', { exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Browse websites', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.model-picker')).toBeVisible()
  await expect(page.locator('.composer-research-picker')).toBeVisible()
})
