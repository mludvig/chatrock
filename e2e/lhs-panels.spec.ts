import { test, expect } from '@playwright/test'
import { openApp } from './ux.helpers'

test('projects and recent chats share navigation; settings has a clear return', async ({ page }) => {
  await openApp(page)
  await expect(page.locator('.projects-panel')).toBeVisible()
  await expect(page.locator('.chat-list')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.prefs-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Personal memory', exact: true }).click()
  await expect(page.locator('.memory-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Back to chats and projects', exact: false }).click()
  await expect(page.locator('.projects-panel')).toBeVisible()
  await expect(page.locator('.chat-list')).toBeVisible()
})
