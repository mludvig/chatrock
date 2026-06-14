import { test, expect } from '@playwright/test'

test('chat list is shown by default in the LHS panel', async ({ page }) => {
  await page.goto('/c/new')
  await expect(page.locator('.chat-list')).toBeVisible()
})

test('clicking Memory icon switches to memory panel', async ({ page }) => {
  await page.goto('/c/new')
  await page.locator('[data-panel="memory"]').click()
  await expect(page.locator('.memory-panel')).toBeVisible()
})

test('clicking Prefs icon switches to preferences panel', async ({ page }) => {
  await page.goto('/c/new')
  await page.locator('[data-panel="prefs"]').click()
  await expect(page.locator('.prefs-panel')).toBeVisible()
})

test('clicking Chats icon returns to chat list', async ({ page }) => {
  await page.goto('/c/new')
  await page.locator('[data-panel="memory"]').click()
  await page.locator('[data-panel="chats"]').click()
  await expect(page.locator('.chat-list')).toBeVisible()
})
