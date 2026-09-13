import { test, expect } from '@playwright/test'
import { openApp, newProject, newChat, request } from './ux.helpers'

test('creation is explicit, rename persists, and deletion keeps member chats', async ({ page }) => {
  await openApp(page)
  const name = `E2E UX lifecycle ${Date.now()}`
  await page.getByTitle('New project', { exact: true }).first().click()
  await page.getByLabel('Project name', { exact: true }).fill(name)
  await page.getByRole('heading').first().click()
  await expect(page.getByLabel('Project name', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/p\//)
  const id = page.url().split('/p/')[1]
  const c = await newChat(page, id)
  let deleted = false
  try {
    await page.getByLabel('Project actions', { exact: true }).click()
    await page.getByRole('button', { name: 'Rename project', exact: true }).click()
    await page.getByLabel('Edit text').fill(`${name} renamed`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('heading', { name: `${name} renamed` })).toBeVisible()
    await page.reload()
    const row = page.locator('.project-item').filter({ hasText: `${name} renamed` })
    await row.locator('summary').click()
    page.once('dialog', async d => { expect(d.message()).toContain('chats will be kept'); await d.accept() })
    await page.getByRole('button', { name: 'Delete project', exact: true }).click()
    await expect(row).toHaveCount(0)
    deleted = true
    const chat = await request<{ projectId?: string }>(page, 'GET', `/chats/${c.chatId}`)
    expect(chat.projectId).toBeUndefined()
    await expect(page.locator(`.chat-list a[href="/c/${c.chatId}"]`)).toBeVisible()
  } finally { await request(page, 'DELETE', `/chats/${c.chatId}`); if (!deleted) await request(page, 'DELETE', `/projects/${id}`) }
})

test('existing chats can be added from a project and removed without deleting', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'organize')
  const c = await newChat(page)
  const title = `E2E movable ${Date.now()}`
  try {
    await request(page, 'PATCH', `/chats/${c.chatId}`, { title })
    await page.goto(`/p/${p.projectId}`)
    await page.getByRole('button', { name: 'Add existing chats' }).click()
    await page.getByRole('dialog').getByRole('button', { name: title, exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: title, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const row = page.locator('.project-chat-row').filter({ hasText: title })
    await expect(row).toBeVisible()
    await row.locator('summary').click()
    await page.getByRole('button', { name: 'Remove from project' }).click()
    await expect(row).toHaveCount(0)
    await expect(page.locator(`.chat-list a[href="/c/${c.chatId}"]`)).toBeVisible()
  } finally { await request(page, 'DELETE', `/chats/${c.chatId}`); await request(page, 'DELETE', `/projects/${p.projectId}`) }
})
