import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const shared = resolve('packages/forge-shared/src')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@forge/shared': resolve('packages/forge-shared/src'),
        '@forge/core': resolve('packages/forge-core/src'),
        '@forge/runtimes': resolve('packages/forge-runtimes/src'),
        '@forge/cli': resolve('packages/forge-cli/src'),
        '@forge/desktop': resolve('packages/forge-desktop/src'),
        '@main': resolve('packages/forge-desktop/src/main'),
        '@shared': shared,
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('packages/forge-desktop/src/main/index.ts'),
          // The routing core is emitted separately so `npm run check:router` can
          // exercise the boundary rules in plain Node, with no window involved.
          router: resolve('packages/forge-desktop/src/main/ipc/router.ts'),
          // Emitted separately so the smoke check can apply and assert the real
          // policy instead of reimplementing it.
          security: resolve('packages/forge-desktop/src/main/security.ts'),
          // Standalone CLI entrypoint emitted for headless command-line execution.
          cli: resolve('packages/forge-cli/src/cli.ts'),
        },
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@forge/shared': resolve('packages/forge-shared/src'),
        '@shared': shared,
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('packages/forge-desktop/src/preload/index.ts') },
        // A sandboxed preload cannot be an ES module, so emit CommonJS and
        // keep the extension explicit rather than relying on the default.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('packages/forge-desktop/src/renderer'),
    plugins: [react(), tailwind()],
    resolve: {
      alias: {
        '@forge/shared': resolve('packages/forge-shared/src'),
        '@forge/ui/styles': resolve('packages/forge-ui/src/styles'),
        '@forge/ui': resolve('packages/forge-ui/src'),
        '@renderer': resolve('packages/forge-desktop/src/renderer/src'),
        '@shared': shared,
      },
    },
    // `check:ui` exercises the kitchen sink, which is development-only and eliminated
    // from a release build (#103), so it needs a bundle with `import.meta.env.DEV`
    // true. `--mode development` alone does not do that: for any `build` command Vite
    // keeps `DEV` false regardless of mode — measured, not assumed — so the flag is
    // replaced explicitly here.
    ...(process.env.FORGE_RENDERER_OUT_DIR === undefined
      ? {}
      : { define: { 'import.meta.env.DEV': 'true' } }),
    build: {
      // Emitted beside the release output rather than over it, so a development-mode
      // bundle can never become the thing electron-builder packages.
      outDir: process.env.FORGE_RENDERER_OUT_DIR ?? resolve('out/renderer'),
      rollupOptions: {
        input: { index: resolve('packages/forge-desktop/src/renderer/index.html') },
      },
    },
  },
})
