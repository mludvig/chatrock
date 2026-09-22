/**
 * The chat list is ordered by the last message, not by metadata edits, and composer choices
 * are saved only when a message is sent with them.
 * See docs/adr/0049-sort-chats-by-last-message-and-save-composer-choices-on-send.md.
 */
import { test, expect } from '@playwright/test'
import { openApp, newChat, newProject, request } from './ux.helpers'

test('renaming a chat or moving it to a project does not reorder the chat list', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'order')
  const older = await newChat(page)
  const newer = await newChat(page)
  try {
    await request(page, 'PATCH', `/chats/${older.chatId}`, { title: 'E2E order renamed' })
    await request(page, 'PATCH', `/chats/${older.chatId}`, { projectId: p.projectId })
    await page.reload()
    const recent = page.getByRole('region', { name: 'Recent chats', exact: true })
    await expect(recent.locator(`a[href="/c/${older.chatId}"]`)).toBeVisible()
    const hrefs = await recent.locator('a[href^="/c/"]').evaluateAll(els => els.map(e => e.getAttribute('href')))
    expect(hrefs.indexOf(`/c/${newer.chatId}`)).toBeLessThan(hrefs.indexOf(`/c/${older.chatId}`))
  } finally {
    await request(page, 'DELETE', `/chats/${older.chatId}`)
    await request(page, 'DELETE', `/chats/${newer.chatId}`)
    await request(page, 'DELETE', `/projects/${p.projectId}`)
  }
})

test('picking a model is not saved until a message is sent', async ({ page }) => {
  await openApp(page)
  const chat = await newChat(page)
  try {
    const before = await request<{ model: string }>(page, 'GET', `/chats/${chat.chatId}`)
    await page.goto(`/c/${chat.chatId}`)
    await expect(page.locator(`.sidebar a[href="/c/${chat.chatId}"]`)).toBeVisible()
    await page.locator('.model-picker').selectOption({ label: 'GPT-5.6 Terra' })
    await page.reload()
    const after = await request<{ model: string }>(page, 'GET', `/chats/${chat.chatId}`)
    expect(after.model).toBe(before.model)
  } finally {
    await request(page, 'DELETE', `/chats/${chat.chatId}`)
  }
})

test('switching model keeps the selected thinking effort', async ({ page }) => {
  await openApp(page)
  await page.locator('.model-picker').selectOption({ label: 'GPT-5.6 Sol' })
  const effort = page.getByLabel('Thinking effort', { exact: true })
  await effort.selectOption('medium')
  await page.locator('.model-picker').selectOption({ label: 'GPT-5.6 Terra' })
  await expect(effort).toHaveValue('medium')
})

test('sending a message saves the model and effort and moves the chat to the top', async ({ page }) => {
  await openApp(page)
  const chat = await newChat(page)
  const newer = await newChat(page)
  try {
    await page.goto(`/c/${chat.chatId}`)
    const recent = page.getByRole('region', { name: 'Recent chats', exact: true })
    await expect(recent.locator(`a[href="/c/${chat.chatId}"]`)).toBeVisible()
    await page.locator('.model-picker').selectOption({ label: 'GPT-6 Luna' })
    await page.getByLabel('Thinking effort', { exact: true }).selectOption('medium')
    await page.locator('.message-input').fill('Reply with the single word: ok')
    await page.locator('.message-input').press('Enter')
    await expect(recent.locator('a[href^="/c/"]').first()).toHaveAttribute('href', `/c/${chat.chatId}`)
    await expect(page.locator('.btn-send:not(.btn-stop)')).toBeVisible({ timeout: 120_000 })
    const saved = await request<{ model: string; lastMessageAt?: string; modelSettings?: { thinkingEffort?: string } }>(page, 'GET', `/chats/${chat.chatId}`)
    expect(saved.model).toBe('global.openai.gpt-6-luna')
    expect(saved.modelSettings?.thinkingEffort).toBe('medium')
    expect(saved.lastMessageAt).toBeTruthy()
    await page.reload()
    await expect(recent.locator('a[href^="/c/"]').first()).toHaveAttribute('href', `/c/${chat.chatId}`)
  } finally {
    await request(page, 'DELETE', `/chats/${chat.chatId}`)
    await request(page, 'DELETE', `/chats/${newer.chatId}`)
  }
})
