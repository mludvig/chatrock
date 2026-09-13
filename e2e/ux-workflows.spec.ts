import { test, expect } from '@playwright/test'
import { request, openApp, newProject, newChat, assertFits } from './ux.helpers'

test('project defaults survive reload and can be reset; project creation stays a draft', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'defaults')
  try {
    const { models } = await request<{ models: Array<{ id: string }> }>(page, 'GET', '/models')
    await request(page, 'PATCH', `/projects/${p.projectId}`, { defaultModel: models[0].id, modelSettings: { researchDepth: 'deep', answerLength: 'short' } })
    await page.goto(`/p/${p.projectId}`)
    await expect(page.getByRole('heading', { name: p.name })).toBeVisible()
    const before = await request<{ chats: unknown[] }>(page, 'GET', '/chats')
    await page.getByRole('button', { name: '+ New chat', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/c/new\\?project=${p.projectId}`))
    await expect(page.locator('.model-picker')).toHaveValue(models[0].id)
    await expect(page.locator('.composer-research-picker')).toHaveValue('deep')
    expect((await request<{ chats: unknown[] }>(page, 'GET', '/chats')).chats.length).toBe(before.chats.length)
    await page.goto(`/p/${p.projectId}?settings=1`)
    await expect(page.getByRole('dialog')).toBeVisible()
    const selector = page.getByRole('dialog').locator('select.pref-select')
    await expect(selector).toHaveValue(models[0].id)
    await selector.selectOption('')
    await expect.poll(async () => (await request<{ project: { defaultModel?: string } }>(page, 'GET', `/projects/${p.projectId}`)).project.defaultModel).toBeUndefined()
    await page.reload()
    await expect(page.getByRole('dialog').locator('select.pref-select')).toHaveValue('')
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('project home carries a question into a draft without sending it', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'composer')
  try {
    await page.goto(`/p/${p.projectId}`)
    await page.getByLabel('What would you like to work on?').fill('Help me plan the next release')
    await page.getByRole('button', { name: 'Start chat →' }).click()
    await expect(page.locator('.message-input')).toHaveValue('Help me plan the next release')
    await expect(page.getByLabel('Project', { exact: true })).toHaveValue(p.projectId)
    await expect(page.locator('.btn-stop')).toHaveCount(0)
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('search finds a project chat without creating another chat', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'search')
  const c = await newChat(page, p.projectId)
  try {
    await request(page, 'PATCH', `/chats/${c.chatId}`, { title: `${p.name} reference` })
    await page.reload()
    const before = await request<{ chats: unknown[] }>(page, 'GET', '/chats')
    await page.getByTitle('Search chats and files', { exact: true }).click()
    await page.getByRole('dialog').getByLabel('Search chats and files').fill(p.name)
    await page.getByRole('button', { name: new RegExp(`${p.name} reference`) }).click()
    await expect(page).toHaveURL(new RegExp(c.chatId))
    expect((await request<{ chats: unknown[] }>(page, 'GET', '/chats')).chats.length).toBe(before.chats.length)
  } finally { await request(page, 'DELETE', `/chats/${c.chatId}`); await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('private project chats stay hidden in lists and search', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'private')
  const c = await newChat(page, p.projectId)
  try {
    const title = `SECRET ${Date.now()}`
    await request(page, 'PATCH', `/chats/${c.chatId}`, { title, sensitive: true })
    await page.goto(`/p/${p.projectId}`)
    await expect(page.getByRole('heading', { name: p.name })).toBeVisible()
    await expect(page.getByText(title)).toHaveCount(0)
    const detail = await request<{ chats: Array<{ sensitive?: boolean }> }>(page, 'GET', `/projects/${p.projectId}`)
    expect(detail.chats[0].sensitive).toBe(true)
    await page.getByTitle('Search chats and files', { exact: true }).click()
    await page.getByRole('dialog').getByLabel('Search chats and files').fill(title)
    await expect(page.getByRole('dialog').locator('.search-result')).toHaveCount(0)
  } finally { await request(page, 'DELETE', `/chats/${c.chatId}`); await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('project facts can be added and edited and files can be opened', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'knowledge')
  try {
    await page.goto(`/p/${p.projectId}`)
    await page.getByRole('button', { name: /Knowledge/ }).click()
    await page.getByRole('button', { name: 'Add fact', exact: true }).click()
    await page.getByLabel('Fact', { exact: true }).fill('Use metric units for this project.')
    await page.getByRole('button', { name: 'Save fact' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Maintained by you', { exact: false })).toBeVisible()
    await page.locator('input[type=file]').setInputFiles({ name: 'project-reference.txt', mimeType: 'text/plain', buffer: Buffer.from('This project uses metric units and ships a green widget every Friday.') })
    const file = page.locator('.project-file-item').filter({ hasText: 'project-reference.txt' })
    await expect(file.getByText('Used when relevant', { exact: false })).toBeVisible({ timeout: 90_000 })
    await file.getByLabel('Actions for project-reference.txt').click()
    const url = await file.getByRole('link', { name: 'Open / download file' }).getAttribute('href')
    expect(url).toMatch(/^https:/)
    const downloaded = await page.request.get(url!)
    expect(downloaded.ok()).toBe(true)
    expect(await downloaded.text()).toContain('green widget')
    await page.reload()
    await page.getByRole('button', { name: /Knowledge/ }).click()
    await expect(page.getByText('Use metric units for this project.', { exact: true })).toBeVisible()
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

for (const width of [320, 390, 768, 1440]) {
  test(`navigation and project actions are reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await openApp(page)
    const p = await newProject(page, `mobile ${width}`)
    try {
      await page.goto(`/p/${p.projectId}`)
      await expect(page.getByRole('heading', { name: p.name })).toBeVisible()
      await assertFits(page, '.project-view-header button, .project-view-header summary, .project-tabs button')
      if (width <= 720) {
        await page.getByTitle('Open sidebar').click()
        await expect(page.locator('.layout')).toHaveClass(/sidebar-open/)
      }
      await page.getByTitle('Search chats and files', { exact: true }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await assertFits(page, '.dialog input, .dialog select, .dialog button')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      if (width <= 720) await page.locator('.sidebar-backdrop').click({ position: { x: width - 5, y: 400 } })
      await page.getByRole('button', { name: '+ New chat', exact: true }).click()
      await assertFits(page, '.chat-header button, .chat-header select, .composer-toolbar > *')
      await page.locator('.message-input').fill('Draft on a phone')
      await expect(page.locator('.chat-header')).toBeInViewport()
      await page.screenshot({ path: `.screenshots/2026-09-16-ux-${width}.jpg`, fullPage: true })
    } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
  })
}
