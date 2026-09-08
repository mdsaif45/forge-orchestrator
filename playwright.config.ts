import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests against the built Electron app.
 *
 * No browser download is required: `_electron` drives the app's own Chromium, so
 * CI does not need `playwright install`. The tests assume `npm run build` has run.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch:
    process.env['FORGE_AUDIT'] === '1'
      ? /transparency-audit\.spec\.ts/
      : process.env['FORGE_DRIVE'] === '1'
        ? /drive\.spec\.ts/
        : /app\.spec\.ts/,
  // Electron launches one app instance per worker; serial keeps them from
  // contending over the same user-data directory.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  timeout: 30_000,
  expect: { timeout: 8_000 },
})
