import { test, expect } from '@playwright/test'
import { openApp, newProject, newChat, request } from './ux.helpers'

test('search scope keeps results in the selected project', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'scoped-search')
  const inside = await newChat(page, p.projectId)
  const outside = await newChat(page)
  const key = `ScopeKey${Date.now()}`
  try {
    await request(page, 'PATCH', `/chats/${inside.chatId}`, { title: `${key} inside` })
    await request(page, 'PATCH', `/chats/${outside.chatId}`, { title: `${key} outside` })
    await page.goto(`/p/${p.projectId}`)
    await page.getByTitle('Search chats and files', { exact: true }).click()
    await expect(page.getByLabel('Search scope')).toHaveValue(p.projectId)
    await page.getByRole('dialog').getByLabel('Search chats and files').fill(key)
    await expect(page.getByRole('dialog').getByText(`${key} inside`, { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog').getByText(`${key} outside`, { exact: true })).toHaveCount(0)
    await page.getByLabel('Search scope').selectOption('')
    await expect(page.getByRole('dialog').getByText(`${key} outside`, { exact: true })).toBeVisible()
  } finally {
    await request(page, 'DELETE', `/chats/${inside.chatId}`); await request(page, 'DELETE', `/chats/${outside.chatId}`); await request(page, 'DELETE', `/projects/${p.projectId}`)
  }
})
