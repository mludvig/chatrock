/**
 * A Deep Research run outlives the WebSocket: it finishes in Step Functions, and its
 * `research_done` frame is best-effort (backend/src/research/CLAUDE.md, "Progress frames and
 * reconnect"). Backgrounding a phone for the length of a run therefore loses the frame outright
 * and used to leave the progress panel spinning forever.
 *
 * Driving a real run here would take ~20 minutes, so the run endpoint is mocked instead: the
 * chat mounts against a `running` run, the mock flips to `done` while "away", and refocus must
 * reconcile from the run row.
 */
import { test, expect, type Page } from '@playwright/test'

const RUNNING = {
  runId: 'test-run', status: 'running', question: 'Test question',
  plan: { subQuestions: [{ id: 'sq1', question: 'A sub-question' }], clarifyingQuestions: [] },
  findings: [], gapsNotPursued: [], roundsSpent: 1, reportText: null,
}

// Reuse whatever chat the account already has — this exercises the reconcile path, which
// doesn't care what the transcript contains.
async function openAnyChat(page: Page) {
  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  const firstChat = page.locator('.chat-item').first()
  await expect(firstChat).toBeVisible({ timeout: 15_000 })
  await firstChat.click()
  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 15_000 })
}

test('a run that finishes while the tab is backgrounded is reconciled on refocus', async ({ page }) => {
  let status: 'running' | 'done' = 'running'
  await page.route('**/api/chats/*/research', route =>
    route.fulfill({ json: { run: { ...RUNNING, status } } }),
  )

  await openAnyChat(page)
  await expect(page.locator('.research-panel')).toBeVisible({ timeout: 15_000 })

  // The run completes while the tab is hidden — no WS frame is delivered.
  status = 'done'
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('.research-panel')).toBeVisible()  // still stale while away

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  // Reconciled from the run row: the spinner is gone and the transcript takes over.
  await expect(page.locator('.research-panel')).toHaveCount(0, { timeout: 15_000 })
})

test('an in-flight run survives refocus rather than being cleared', async ({ page }) => {
  await page.route('**/api/chats/*/research', route => route.fulfill({ json: { run: RUNNING } }))

  await openAnyChat(page)
  await expect(page.locator('.research-panel')).toBeVisible({ timeout: 15_000 })

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(1500)
  await expect(page.locator('.research-panel')).toBeVisible()
})
