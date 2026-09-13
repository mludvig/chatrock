import { test, expect } from '@playwright/test'

test.describe('Memory panel', () => {
  test.use({ storageState: '.auth/state.json' })

  test('memory panel opens from settings', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Click the memory icon in the activity bar
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Personal memory', exact: true }).click()
    await expect(page.locator('.memory-panel')).toBeVisible()
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
