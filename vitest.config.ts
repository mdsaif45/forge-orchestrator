import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

process.env.ELECTRON_OVERRIDE_DIST_PATH =
  process.env.ELECTRON_OVERRIDE_DIST_PATH || resolve('node_modules/electron/dist')

/**
 * Unit and component tests.
 *
 * Two projects, because the code under test runs in two different environments:
 * main and shared are Node, the renderer is a DOM. Splitting them keeps a Node
 * global from leaking into a renderer test and passing for the wrong reason.
 *
 * Electron-dependent behaviour is not tested here — it needs a real Electron
 * process, which is what `scripts/smoke.cjs` and `scripts/ui-check.cjs` provide.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@forge/shared': resolve('packages/forge-shared/src'),
      '@forge/core': resolve('packages/forge-core/src'),
      '@forge/runtimes': resolve('packages/forge-runtimes/src'),
      '@forge/cli': resolve('packages/forge-cli/src'),
      '@forge/desktop': resolve('packages/forge-desktop/src'),
      '@main': resolve('packages/forge-desktop/src/main'),
      '@shared': resolve('packages/forge-shared/src'),
      '@renderer': resolve('packages/forge-desktop/src/renderer/src'),
    },
  },
  test: {
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/**/*.test.ts'],
          exclude: ['packages/forge-desktop/src/renderer/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['packages/forge-desktop/src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/**/*.{ts,tsx}'],
      exclude: [
        'packages/**/*.test.{ts,tsx}',
        'test/**',
        // Icons are static markup, and the kitchen sink is itself a test surface.
        'packages/forge-desktop/src/renderer/src/app/icons.tsx',
        'packages/forge-desktop/src/renderer/src/dev/**',
      ],
    },
  },
})
