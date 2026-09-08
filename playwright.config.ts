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
  // Generous on purpose, and only on CI. A GitHub Windows runner was measured
  // taking 5m09s for a job that normally finishes in 2m19s — about 2.2x slower
  // — which turns an 8s expect budget into roughly 3.6s of normal-speed work.
  // Two tests then failed with "element(s) not found" on text the previous step
  // had just submitted, in a PR that changed one unit test file.
  //
  // The assertions themselves already wait on conditions rather than sleeping;
  // it is this outer budget that fails first under load. Widening it cannot
  // mask a real regression — a genuinely missing element still never appears —
  // it only stops a slow machine being reported as a broken feature.
  //
  // Left at the shorter local values so a developer gets fast feedback.
  timeout: process.env['CI'] === undefined ? 30_000 : 90_000,
  expect: { timeout: process.env['CI'] === undefined ? 8_000 : 30_000 },
})
