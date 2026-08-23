/**
 * End-to-end test: generate_image tool (Stability AI via Bedrock, us-west-2).
 *
 * Scenario:
 *  1. Start a new chat, enable Image generation in the Chat details dialog (opt-in, off by default)
 *  2. Ask the assistant to generate an image
 *  3. Verify the tool pill resolves with a real thumbnail, not raw JSON
 *  4. Reload and confirm the thumbnail still renders via GET /messages
 */
import { test, expect } from '@playwright/test'
import { THINKING_MODEL_LABEL } from './testConfig'

test.describe('generate_image tool', () => {
  test.use({ storageState: '.auth/state.json' })

  test('generates an image and renders it as a clickable thumbnail', async ({ page }) => {
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

    // Pin an explicit, known-valid model — a stale persisted lastModel can otherwise trigger
    // a server-side "Invalid model" rejection unrelated to this test.
    await page.locator('.model-picker').selectOption({ label: THINKING_MODEL_LABEL })

    // Enable Image generation for this chat (opt-in — off by default)
    await page.locator('.chat-header .btn-icon[title="Chat details"]').click()
    await expect(page.locator('.dialog-title')).toHaveText('Chat details')
    const imageGenRow = page.locator('.dialog .model-setting-row').filter({ hasText: 'Image generation' })
    await expect(imageGenRow.locator('.toggle-btn')).toHaveText('Off')
    await imageGenRow.locator('.toggle-btn').click()
    await expect(imageGenRow.locator('.toggle-btn')).toHaveText('On')
    await page.keyboard.press('Escape')

    await page.locator('.message-input').fill(
      'Use the generate_image tool to create a picture of a red panda skateboarding, studio lighting, product photo.',
    )
    await page.locator('.btn-send').click()

    const pill = page.locator('.tool-pill', { hasText: 'Image:' }).first()
    await expect(pill).toBeVisible({ timeout: 60_000 })
    await expect(pill).not.toHaveClass(/pending/, { timeout: 60_000 })
    await expect(pill).not.toHaveClass(/error/)

    // generate_image auto-expands (unlike a browser screenshot, the image IS the point) —
    // confirm a real thumbnail rendered with no click needed, never the raw JSON envelope.
    const thumbnail = pill.locator('.browser-screenshots img').first()
    await expect(thumbnail).toBeVisible({ timeout: 10_000 })
    await expect(pill.locator('.tool-result-body')).not.toContainText('screenshotUrls')

    // The full prompt the model actually used must be visible in the expanded body — not just
    // the 60-char-truncated pill header label.
    const promptText = pill.locator('.tool-result-body pre')
    await expect(promptText).toBeVisible({ timeout: 10_000 })
    const fullPrompt = (await promptText.textContent()) ?? ''
    expect(fullPrompt.length).toBeGreaterThan(60)
    expect(fullPrompt.toLowerCase()).toContain('panda')

    await expect(page.locator('.message.assistant')).toBeVisible({ timeout: 60_000 })

    // Reload and confirm the same thumbnail still renders via GET /messages (no re-stream),
    // still auto-expanded, still with no click needed.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const reloadedPill = page.locator('.tool-pill', { hasText: 'Image:' }).first()
    await expect(reloadedPill.locator('.browser-screenshots img').first()).toBeVisible({ timeout: 10_000 })
  })
})
