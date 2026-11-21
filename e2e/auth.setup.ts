/**
 * Authentication setup for Playwright E2E tests.
 *
 * Drives the Cognito Hosted UI once, saves localStorage (which now holds the
 * oidc-client-ts token, thanks to the WebStorageStateStore config) as
 * .auth/state.json so all tests can reuse it without logging in again.
 *
 * Credentials come from COGNITO_USERNAME / COGNITO_PASSWORD in .env (gitignored).
 * Use a dedicated throwaway test user in the Cognito pool — never use admin creds.
 */
import { test as setup, expect } from '@playwright/test'
import * as path from 'path'
import { signInOnHostedUi } from './ux.helpers'

const STATE_FILE = path.join(__dirname, '../.auth/state.json')

setup('authenticate', async ({ page }) => {
  const username = process.env.COGNITO_USERNAME
  const password = process.env.COGNITO_PASSWORD
  if (!username || !password) {
    throw new Error('COGNITO_USERNAME and COGNITO_PASSWORD must be set in .env')
  }

  // Navigate to the app — it will redirect to Cognito Hosted UI
  await page.goto('/')

  // The app shows a login button; click it to initiate the OAuth flow
  const loginButton = page.getByRole('button', { name: /sign in|log in/i })
  await loginButton.waitFor({ timeout: 15_000 })
  await loginButton.click()

  await signInOnHostedUi(page, username, password)

  // Wait for redirect back to the app
  await page.waitForURL('**/c/new', { timeout: 30_000 })
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 10_000 })

  // Save the authenticated state (localStorage + cookies)
  await page.context().storageState({ path: STATE_FILE })
})
