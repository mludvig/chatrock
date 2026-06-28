/**
 * End-to-end test: the "Search" feature (header search box → forced search_history
 * tool turn → internal-link result cards). Distinct from "Web search".
 *
 * Strategy: seed a deterministic corpus without an LLM by creating a project with
 * ONE chat and setting that chat's summary inline (Phase-3 editable summary). A
 * project-scoped search then ranks over a single-item corpus, so the seeded chat
 * reliably surfaces — we assert mechanics (tool resolves, cards render + link
 * internally), not exact ranking. Also exercises the forced-toolChoice +
 * thinking-disabled round against real Bedrock.
 */
import { test, expect, type Page, type Response } from '@playwright/test'

test.use({ storageState: '.auth/state.json' })

async function createProject(page: Page, name: string) {
  await page.goto('/c/new')
  await page.waitForLoadState('networkidle')
  await page.click('[data-panel="projects"]')
  await expect(page.locator('.projects-panel')).toBeVisible()
  await page.click('.panel-header-btn')
  await page.locator('.new-project-bar input').waitFor({ state: 'visible' })
  await page.fill('.new-project-bar input', name)
  await page.keyboard.press('Enter')
  await page.locator('.new-project-bar input').waitFor({ state: 'hidden', timeout: 5000 })
  await page.waitForURL(/\/p\//, { timeout: 10000 })
  await expect(page.locator('.project-view')).toBeVisible()
}

async function deleteProject(page: Page, name: string) {
  await page.click('[data-panel="projects"]')
  const item = page.locator('.project-item').filter({ hasText: name })
  page.once('dialog', d => d.accept())
  await item.hover()
  await item.locator('button[title="Delete project"]').click()
}

test('header Search (project scope) forces search_history, renders internal-link cards', async ({ page }) => {
  const projectName = `E2E Search Seed ${Date.now()}`
  const SUMMARY = 'Detailed field notes on quokka habitat conservation on Rottnest Island.'

  await createProject(page, projectName)
  const projectUrl = page.url()

  // Seed: one chat in the project, then set its summary inline (no LLM needed).
  await page.locator('.project-view-header .btn-action').click()
  await page.waitForURL(/\/c\/(?!new)/, { timeout: 10000 })
  await expect(page.locator('.chat-view')).toBeVisible()
  const seededChatId = page.url().match(/\/c\/([^/?]+)/)![1]

  await page.goto(projectUrl)
  await expect(page.locator('.project-view')).toBeVisible()
  const chatsSection = page.locator('.project-section').filter({ has: page.locator('.project-section-header', { hasText: 'Chats' }) })
  const seededItem = chatsSection.locator('.chat-item').first()
  await expect(seededItem).toBeVisible({ timeout: 5000 })
  await seededItem.locator('.chat-summary').click()
  const summaryTextarea = seededItem.locator('.inline-edit-textarea')
  const isChatPatch = (resp: Response) =>
    resp.request().method() === 'PATCH' && /\/api\/chats\/[^/]+$/.test(resp.url())
  await summaryTextarea.fill(SUMMARY)
  await Promise.all([page.waitForResponse(isChatPatch), summaryTextarea.blur()])
  await expect(seededItem.locator('.chat-summary')).toHaveText(SUMMARY, { timeout: 5000 })

  // Trigger Search from the project view (project scope, "Project only" on by
  // default). Triggering from /p/:id — a different route than /c/new — guarantees
  // ChatView remounts and consumes pendingSearch. Project scope keeps the corpus
  // to this project's summarized chats (just the seeded one), so it surfaces
  // deterministically.
  await expect(page.locator('.search-scope-toggle')).toHaveClass(/active/)
  await page.locator('.search-input').fill('quokka habitat conservation Rottnest')
  await page.locator('.search-input').press('Enter')

  // A new chat is created and the search_history tool is forced on turn 0.
  await page.waitForURL(/\/c\/(?!new)/, { timeout: 15000 })
  const pill = page.locator('.tool-pill', { hasText: 'Search history:' }).first()
  await expect(pill).toBeVisible({ timeout: 60000 })
  await expect(pill).not.toHaveClass(/pending/, { timeout: 60000 })
  await expect(pill).not.toHaveClass(/error/)

  // Result cards render (internal links). Expand the pill and assert >=1 card.
  await pill.locator('.tool-pill-header').click()
  const cards = page.locator('.search-history-result-card')
  await expect(cards.first()).toBeVisible({ timeout: 10000 })

  // The seeded chat should surface in a single-item corpus and link to /c/:id.
  const seededCard = page.locator(`a.search-history-result-card[href="/c/${seededChatId}"]`)
  await expect(seededCard).toBeVisible({ timeout: 5000 })

  // The model narrates the result (round 1, free choice) — assistant message appears.
  await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })

  await page.screenshot({ path: `.screenshots/${new Date().toISOString().slice(0, 10)}-search-history.jpg` })

  // Clicking the card navigates internally to the seeded chat.
  await seededCard.click()
  await page.waitForURL(new RegExp(`/c/${seededChatId}`), { timeout: 10000 })
  await expect(page.locator('.chat-view')).toBeVisible()

  // Cleanup
  try {
    await deleteProject(page, projectName)
  } catch { /* cleanup failure is acceptable */ }
})
