/**
 * Builds a development-mode renderer for `check:ui`.
 *
 * `check:ui` exercises the kitchen sink, which is development-only and eliminated
 * from a release build (#103), so it cannot run against `out/renderer`. This emits a
 * parallel bundle with `import.meta.env.DEV` true.
 *
 * Emitted to `out-dev/` rather than over `out/`, so a development-mode bundle can
 * never become the thing electron-builder packages — the failure mode that would
 * otherwise be introduced here is shipping the very code this issue removes.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const result = spawnSync(
  process.execPath,
  [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build', '--mode', 'development'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Read by electron.vite.config.ts to redirect only the renderer output.
      FORGE_RENDERER_OUT_DIR: resolve('out-dev/renderer'),
    },
  },
)

process.exit(result.status ?? 1)
