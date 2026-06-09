import { defineConfig, devices } from '@playwright/test'
import * as dotenv from 'dotenv'

// Load .env so COGNITO_USERNAME / COGNITO_PASSWORD are available in global-setup
dotenv.config()

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,    // generous — Bedrock + web search can be slow
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'https://chatrock.ccxdemo.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
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
