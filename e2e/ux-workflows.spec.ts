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
    await page.getByTitle('New chat', { exact: true }).first().click()
    await expect(page.getByLabel('Project', { exact: true })).toHaveValue(p.projectId)
    await expect(page.locator('.message-input')).toHaveValue('')
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('failed preferences do not hide chats or projects and can be retried', async ({ page }) => {
  await openApp(page)
  const p = await newProject(page, 'partial-load')
  try {
    await page.route('**/api/preferences', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporary test outage"}' }))
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('Could not refresh preferences')
    await expect(page.locator('.project-item').filter({ hasText: p.name })).toBeVisible()
    await page.unroute('**/api/preferences')
    await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally { await page.unroute('**/api/preferences'); await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('project instructions save when a phone closes settings with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  const p = await newProject(page, 'instruction-save')
  try {
    await page.goto(`/p/${p.projectId}?settings=1`)
    await page.getByPlaceholder('Custom instructions applied to every chat in this project…').fill('Keep project answers concise and use metric units.')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(async () => (await request<{ project: { instructions?: string } }>(page, 'GET', `/projects/${p.projectId}`)).project.instructions).toBe('Keep project answers concise and use metric units.')
    await page.reload()
    await expect(page.getByPlaceholder('Custom instructions applied to every chat in this project…')).toHaveValue('Keep project answers concise and use metric units.')
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
    const downloaded = await page.evaluate(async url => { const r = await fetch(url); if (!r.ok) throw new Error(`File download: ${r.status}`); return r.text() }, url!)
    expect(downloaded).toContain('green widget')
    await page.reload()
    await page.getByRole('button', { name: /Knowledge/ }).click()
    await expect(page.getByText('Use metric units for this project.', { exact: true })).toBeVisible()
  } finally { await request(page, 'DELETE', `/projects/${p.projectId}`) }
})

test('a failed file-processing request can be retried without another upload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  const p = await newProject(page, 'upload-recovery')
  const route = `**/api/projects/${p.projectId}/files/*`
  try {
    await page.goto(`/p/${p.projectId}`)
    await page.getByRole('button', { name: /Knowledge/ }).click()
    await page.route(route, intercepted => intercepted.request().method() === 'PUT'
      ? intercepted.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporary test outage"}' })
      : intercepted.continue())
    await page.locator('input[type=file]').setInputFiles({ name: 'retry-reference.txt', mimeType: 'text/plain', buffer: Buffer.from('The recovered project reference uses metric units.') })
    const file = page.locator('.project-file-item').filter({ hasText: 'retry-reference.txt' })
    await expect(file.getByRole('button', { name: 'Retry processing' })).toBeVisible()
    await page.unroute(route)
    await file.getByRole('button', { name: 'Retry processing' }).click()
    await expect(file.getByText('Used when relevant', { exact: false })).toBeVisible({ timeout: 90_000 })
    await page.reload()
    await page.getByRole('button', { name: /Knowledge/ }).click()
    await expect(file.getByText('Used when relevant', { exact: false })).toBeVisible()
    expect((await request<{ files: unknown[] }>(page, 'GET', `/projects/${p.projectId}/files`)).files).toHaveLength(1)
  } finally { await page.unroute(route); await request(page, 'DELETE', `/projects/${p.projectId}`) }
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

test('recent chats remain in the visible sidebar and effort is a direct control', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 })
  await openApp(page)
  const c = await newChat(page)
  try {
    await request(page, 'PATCH', `/chats/${c.chatId}`, { title: 'E2E visible recent chat' })
    await page.reload()
    await expect(page.locator(`.chat-list a[href="/c/${c.chatId}"]`)).toBeInViewport()
    const thinkingModel = await page.locator('.model-picker option').filter({ hasText: /Sonnet|Opus/ }).first().getAttribute('value')
    await page.locator('.model-picker').selectOption(thinkingModel!)
    await expect(page.getByLabel('Thinking effort', { exact: true })).toBeVisible()
    await expect(page.locator('.scroll-fabs')).toHaveCount(0)
    await expect(page.getByTitle('Chat list filters')).not.toHaveClass(/active/)
    expect(await page.getByLabel('Thinking effort', { exact: true }).inputValue()).not.toBe('')
    const style = await page.getByTitle('Search chats and files', { exact: true }).evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))
    expect(style.background).toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: '.screenshots/2026-09-16-sidebar-and-controls.jpg' })
  } finally { await request(page, 'DELETE', `/chats/${c.chatId}`) }
})

test('a phone can rerun, fork, export, and share a conversation', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  const c = await newChat(page)
  const chatIds = [c.chatId]
  let releaseChatList: () => void = () => {}
  const chatListReady = new Promise<void>(resolve => { releaseChatList = resolve })
  try {
    await request(page, 'PATCH', `/chats/${c.chatId}`, { modelSettings: { memoryEnabled: false, webSearchEnabled: false } })
    await page.route('**/api/chats', async route => { await chatListReady; await route.continue() })
    await page.goto(`/c/${c.chatId}`)
    await page.locator('.message-input').fill('Reply with exactly: GREEN_WIDGET')
    await expect(page.locator('.btn-send')).toBeDisabled()
    await page.locator('.message-input').press('Enter')
    await expect(page.locator('.message-input')).toHaveValue('Reply with exactly: GREEN_WIDGET')
    releaseChatList()
    await page.locator('.btn-send').click()
    await expect(page.locator('.message.assistant')).toContainText('GREEN_WIDGET', { timeout: 90_000 })
    await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 90_000 })
    await page.getByTitle('Re-run this answer', { exact: true }).click()
    await expect(page.locator('.btn-stop')).toBeVisible()
    await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 90_000 })
    await page.reload()
    await expect(page.locator('.message.assistant')).toContainText('GREEN_WIDGET')
    page.once('dialog', d => d.accept())
    await page.locator('.message.assistant').getByTitle('Fork to a new chat (up to here)').click()
    await expect(page).not.toHaveURL(new RegExp(c.chatId))
    const forkId = page.url().split('/c/')[1]
    expect(forkId).toMatch(/^[a-z0-9]+$/)
    chatIds.push(forkId)
    await expect(page.locator('.message.assistant')).toContainText('GREEN_WIDGET')
    await page.getByLabel('Chat actions', { exact: true }).click()
    await page.getByRole('button', { name: 'Share / export', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Download Markdown' })).toBeVisible()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download Markdown' }).click()
    const stream = await (await downloading).createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toContain('GREEN_WIDGET')
    await page.getByRole('button', { name: 'Create share link' }).click()
    const link = page.locator('.share-list-url').first()
    await expect(link).toBeVisible()
    const url = (await link.getAttribute('href'))!
    const publicContext = await browser.newContext()
    try {
      const publicPage = await publicContext.newPage()
      await publicPage.goto(url)
      await expect(publicPage.locator('body')).toContainText('GREEN_WIDGET')
      page.once('dialog', d => d.accept())
      await page.getByTitle('Revoke', { exact: true }).click()
      await expect(link).toHaveCount(0)
      expect((await publicPage.reload())?.status()).toBe(404)
    } finally { await publicContext.close() }
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByTitle('Chat details', { exact: true }).click()
    await expect(page.locator('.prefs-tab.active')).toHaveText('Settings')
    await assertFits(page, '.dialog input, .dialog select, .dialog button')
  } finally {
    releaseChatList()
    await page.unroute('**/api/chats')
    for (const id of chatIds) await request(page, 'DELETE', `/chats/${id}`)
  }
})

test('a phone sends with the selected project model and restores the answer after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openApp(page)
  const p = await newProject(page, 'real-send')
  let chatId: string | undefined
  try {
    const { models } = await request<{ models: Array<{ id: string; name: string }> }>(page, 'GET', '/models')
    const model = models.find(m => /Haiku/.test(m.name))!.id
    await request(page, 'PATCH', `/projects/${p.projectId}`, { defaultModel: model, instructions: 'When asked for the project code, answer GREEN_WIDGET.', modelSettings: { memoryEnabled: false, webSearchEnabled: false, browserCoreEnabled: false } })
    await page.goto(`/c/new?project=${p.projectId}`)
    await expect(page.locator('.model-picker')).toHaveValue(model)
    await page.locator('.message-input').fill('What is the project code? Reply with only that code.')
    await page.locator('.btn-send').click()
    await expect(page).toHaveURL(/\/c\/(?!new)[a-z0-9]+/)
    chatId = page.url().split('/c/')[1]
    await expect(page.locator('.message.assistant')).toContainText('GREEN_WIDGET', { timeout: 90_000 })
    await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 90_000 })
    const saved = await request<{ model: string; projectId: string }>(page, 'GET', `/chats/${chatId}`)
    expect(saved.model).toBe(model); expect(saved.projectId).toBe(p.projectId)
    await page.reload()
    await expect(page.locator('.message.assistant')).toContainText('GREEN_WIDGET')
    await assertFits(page, '.chat-header button, .chat-header select, .composer-toolbar > *')
  } finally { if (chatId) await request(page, 'DELETE', `/chats/${chatId}`); await request(page, 'DELETE', `/projects/${p.projectId}`) }
})
