import { expect, type Page } from '@playwright/test'

export async function request<T = Record<string, unknown>>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ method, path, body }) => {
    const key = Object.keys(localStorage).find(k => k.startsWith('oidc.user:'))
    if (!key) throw new Error('No authenticated session')
    const token = JSON.parse(localStorage.getItem(key)!).access_token
    const response = await fetch(`/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }, { method, path, body })
}
export async function openApp(page: Page) {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible()
  await expect(page.locator('.model-picker option').first()).toBeAttached()
}
export async function newProject(page: Page, suffix: string) {
  const name = `E2E UX ${suffix} ${Date.now()}`
  const { projectId } = await request<{ projectId: string }>(page, 'POST', '/projects', { name })
  return { projectId, name }
}
export async function newChat(page: Page, projectId?: string) {
  const { models } = await request<{ models: Array<{ id: string; name: string }> }>(page, 'GET', '/models')
  const model = models.find(m => /Haiku/.test(m.name))?.id ?? models[0].id
  return request<{ chatId: string }>(page, 'POST', '/chats', { model, projectId })
}
export async function assertFits(page: Page, selector: string) {
  for (const el of await page.locator(selector).all()) {
    if (!await el.isVisible()) continue
    const box = await el.boundingBox()
    if (!box) continue
    expect(box.x, `${selector} left edge`).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width, `${selector} right edge`).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  }
}
