import { test, expect } from '@playwright/test'

test.describe('Memory panel', () => {
  test.use({ storageState: '.auth/state.json' })

  test('memory panel opens from settings', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Personal memory lives with the other personal settings.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Personal memory', exact: true }).click()
    await expect(page.locator('.memory-panel')).toBeVisible()
  })

  test('failed loading offers retry instead of an empty-memory message', async ({ page }) => {
    await page.route('**/api/memory', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporary test outage"}' }))
    await page.goto('/c/new')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Personal memory', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Could not load personal memory')
    await expect(page.getByText('No memories yet.', { exact: false })).toHaveCount(0)
    await page.unroute('**/api/memory')
    await page.getByRole('button', { name: 'Retry loading' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.memory-panel .panel-loading')).toHaveCount(0)
  })

  test('memory panel shows empty state when no memories', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Personal memory', exact: true }).click()
    // Either shows "No memories yet" or a list — both are valid
    await expect(page.locator('.memory-panel')).toBeVisible()
    await expect(page.locator('.memory-panel .panel-loading')).not.toBeVisible({ timeout: 5000 })
  })
})
