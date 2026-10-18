import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'

// Load .env so COGNITO_USERNAME / COGNITO_PASSWORD / E2E_BASE_URL are available
dotenv.config()

if (!process.env.E2E_BASE_URL) throw new Error('Set E2E_BASE_URL in .env (e.g. https://chat.example.com)')

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,    // generous — Bedrock + web search can be slow
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.E2E_PROXY ? { proxy: { server: process.env.E2E_PROXY } } : {}),
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/state.json',
      },
      dependencies: ['setup'],
    },
  ],
})
