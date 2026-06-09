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

  // On Cognito Hosted UI — fill in credentials.
  // The Hosted UI injects both a mobile form (CSS-hidden) and a desktop form.
  // Both have the same IDs, so strict-mode locators fail. We wait for the DOM
  // to be ready (state: attached), then fill via evaluate() to hit the visible form.
  await page.waitForSelector('#signInFormUsername', { state: 'attached', timeout: 15_000 })
  await page.evaluate(
    ([user, pass]: string[]) => {
      const userInputs = document.querySelectorAll<HTMLInputElement>('#signInFormUsername')
      const passInputs = document.querySelectorAll<HTMLInputElement>('#signInFormPassword')
      // Pick the visible one (offsetParent === null means hidden)
      const visibleUser = Array.from(userInputs).find(el => el.offsetParent !== null) ?? userInputs[userInputs.length - 1]
      const visiblePass = Array.from(passInputs).find(el => el.offsetParent !== null) ?? passInputs[passInputs.length - 1]
      visibleUser.value = user
      visibleUser.dispatchEvent(new Event('input', { bubbles: true }))
      visiblePass.value = pass
      visiblePass.dispatchEvent(new Event('input', { bubbles: true }))
    },
    [username, password],
  )
  // Click the submit button — also duplicated; pick the visible one
  await page.evaluate(() => {
    const buttons = document.querySelectorAll<HTMLInputElement>('[name="signInSubmitButton"]')
    const visible = Array.from(buttons).find(el => el.offsetParent !== null) ?? buttons[buttons.length - 1]
    visible.click()
  })

  // Wait for redirect back to the app
  await page.waitForURL('**/c/new', { timeout: 30_000 })
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 10_000 })

  // Save the authenticated state (localStorage + cookies)
  await page.context().storageState({ path: STATE_FILE })
})
