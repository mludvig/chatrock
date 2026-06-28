/**
 * One-shot cleanup: delete all leftover "E2E *" test projects from the live
 * test account. Run once, then delete this file.
 *
 *   npm run test:e2e -- e2e/cleanup-e2e-projects.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'

test.use({ storageState: '.auth/state.json' })

async function deleteVisibleE2EProjects(page: Page): Promise<number> {
  let deleted = 0
  // Keep looping until no more E2E items are visible
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const items = page.locator('.project-item').filter({ hasText: /^E2E / })
    const count = await items.count()
    if (count === 0) break
    // Snapshot a stable reference: nth(0) on the live locator still resolves
    // dynamically, so instead capture the count and wait for it to drop.
    const item = items.first()
    const name = await item.locator('span').first().textContent()
    // Wait for the DELETE API response as the reliable completion signal —
    // checking item visibility is unreliable because `items.first()` resolves
    // to a new element after the deleted one is removed.
    const deleteDone = page.waitForResponse(
      r => r.request().method() === 'DELETE' && /\/api\/projects\//.test(r.url()),
      { timeout: 8000 }
    )
    page.once('dialog', d => d.accept())
    await item.hover()
    await item.locator('button[title="Delete project"]').click()
    await deleteDone
    deleted++
    console.log(`Deleted: ${name?.trim() ?? '(unknown)'}`)
    // Small pause so the UI can re-render the list before the next iteration
    await page.waitForTimeout(300)
  }
  return deleted
}

test('delete all leftover E2E test projects', async ({ page }) => {
  await page.goto('/c/new')
  await page.waitForLoadState('networkidle')
  await page.click('[data-panel="projects"]')
  await expect(page.locator('.projects-panel')).toBeVisible()

  const deleted = await deleteVisibleE2EProjects(page)
  console.log(`Total deleted: ${deleted}`)

  // Confirm none remain
  await expect(page.locator('.project-item').filter({ hasText: /^E2E / })).toHaveCount(0)

  // Also delete "CCIT" if present
  const ccit = page.locator('.project-item').filter({ hasText: 'CCIT' })
  if (await ccit.count() > 0) {
    const deleteDone = page.waitForResponse(
      r => r.request().method() === 'DELETE' && /\/api\/projects\//.test(r.url()),
      { timeout: 8000 }
    )
    page.once('dialog', d => d.accept())
    await ccit.hover()
    await ccit.locator('button[title="Delete project"]').click()
    await deleteDone
    console.log('Deleted: CCIT')
  }
})
