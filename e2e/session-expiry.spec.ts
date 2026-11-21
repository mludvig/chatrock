/**
 * A refresh token Cognito rejects (`invalid_grant` — expired or revoked) must send the
 * user to the Hosted UI and, after signing in, back to the page they were on — not to a
 * dead-end "Auth error" screen.
 */
import { test, expect } from '@playwright/test'
import { newChat, openApp, request, signInOnHostedUi } from './ux.helpers'

test('rejected refresh token redirects to sign-in and returns to the open chat', async ({ page, context }) => {
  await openApp(page)
  const { chatId } = await newChat(page)
  try {
    await page.goto(`/c/${chatId}`)
    await expect(page.locator('.chat-view')).toBeVisible()

    // Simulate a refresh token Cognito no longer honours, behind an expired access token.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith('oidc.user:'))!
      const user = JSON.parse(localStorage.getItem(key)!)
      localStorage.setItem(key, JSON.stringify({ ...user, refresh_token: 'revoked', expires_at: Math.floor(Date.now() / 1000) - 60 }))
    })
    // Drop the Hosted UI session cookie so Cognito shows its login form instead of
    // signing straight back in.
    await context.clearCookies()

    await page.reload()
    await page.waitForSelector('#signInFormUsername', { state: 'attached', timeout: 30_000 })

    await signInOnHostedUi(page, process.env.COGNITO_USERNAME!, process.env.COGNITO_PASSWORD!)
    await page.waitForURL(`**/c/${chatId}`, { timeout: 30_000 })
    await expect(page.locator('.chat-view')).toBeVisible()
    await expect(page.locator('.splash.error')).toHaveCount(0)
  } finally {
    await request(page, 'DELETE', `/chats/${chatId}`).catch(() => {})
  }
})
