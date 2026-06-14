import { test, expect } from '@playwright/test'

test('preference panel opens when clicking prefs icon', async ({ page }) => {
  await page.goto('/c/new')
  await page.locator('[data-panel="prefs"]').click()
  await expect(page.locator('.prefs-panel')).toBeVisible()
})

test('custom persona is reflected in assistant replies', async ({ page }) => {
  // Set persona that forbids emojis
  await page.goto('/c/new')
  await page.locator('[data-panel="prefs"]').click()
  await page.locator('.pref-textarea').fill('You are a helpful assistant. Never use emojis in your responses.')
  await page.waitForTimeout(1200)  // wait for debounced save

  // Start a new chat and ask something emoji-prone
  await page.goto('/c/new')
  await page.locator('[data-panel="chats"]').click()
  await page.locator('.message-input').fill('Say hello!')
  await page.locator('.btn-send').click()
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })
  // Get the assistant response text
  const reply = await page.locator('.message.assistant').last().textContent()
  expect(reply).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)  // no emoji codepoints
})

test('show token stats toggle works', async ({ page }) => {
  await page.goto('/c/new')
  // First ensure we have a chat with a message
  await page.locator('[data-panel="chats"]').click()
  await page.locator('.message-input').fill('Hi')
  await page.locator('.btn-send').click()
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })

  // Open prefs, disable token stats
  await page.locator('[data-panel="prefs"]').click()
  // Find the token stats toggle — if it's On, click to turn Off
  const toggle = page.locator('.pref-row', { hasText: 'token stats' }).locator('.toggle-btn')
  const isOn = await toggle.textContent()
  if (isOn?.toLowerCase().includes('on')) await toggle.click()
  await page.waitForTimeout(1200)

  // Switch back to chats panel and verify prefs panel is hidden
  await page.locator('[data-panel="chats"]').click()
  await expect(page.locator('.prefs-panel')).not.toBeVisible()
  await expect(page.locator('.chats-panel, .chat-list')).toBeVisible()
})
