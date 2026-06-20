import { test, expect } from '@playwright/test'

test.describe('AgentCore web search provider', () => {
  test.use({ storageState: '.auth/state.json' })

  test('switching to AgentCore in Defaults and asking a current-events question returns real search results', async ({ page }) => {
    await page.goto('/c/new')
    await page.waitForLoadState('networkidle')

    // Switch the Defaults web search provider to AgentCore
    await page.locator('[data-panel="prefs"]').click()
    await page.locator('.prefs-tab', { hasText: 'Defaults' }).click()
    await page.locator('.pref-section', { hasText: 'Web search provider' })
      .locator('.effort-btn', { hasText: 'AgentCore' })
      .click()
    await page.waitForTimeout(1200) // debounced save

    // Ask something that forces a real web_search tool call
    await page.locator('[data-panel="chats"]').click()
    await page.locator('.message-input').fill(
      'Use the web_search tool to find AWS’s announcement of "Web Search on Amazon Bedrock AgentCore" and summarize it in one sentence.',
    )
    await page.locator('.btn-send').click()

    // A web_search tool pill should appear and resolve (not stay pending/error)
    const pill = page.locator('.tool-pill', { hasText: 'Search:' }).first()
    await expect(pill).toBeVisible({ timeout: 60000 })
    await expect(pill).not.toHaveClass(/pending/, { timeout: 60000 })
    await expect(pill).not.toHaveClass(/error/)

    // Expand it and confirm real result cards came back (not an empty/failed call)
    await pill.locator('.tool-pill-header').click()
    await expect(page.locator('.search-result-card').first()).toBeVisible({ timeout: 10000 })

    // The assistant should produce a final answer grounded in those results
    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60000 })
  })
})
