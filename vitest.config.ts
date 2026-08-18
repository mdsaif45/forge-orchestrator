import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

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
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/{main,shared}/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        // Icons are static markup, and the kitchen sink is itself a test surface.
        'src/renderer/src/app/icons.tsx',
        'src/renderer/src/dev/**',
      ],
    },
  },
})
