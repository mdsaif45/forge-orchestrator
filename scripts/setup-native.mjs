/**
 * Fetches or builds the native binaries `.npmrc` deliberately skips.
 *
 * `ignore-scripts=true` is set because npm runs `node-gyp rebuild` for any dependency
 * shipping a `binding.gyp` — including `better-sqlite3`, which also ships working
 * prebuilds, so the compile is pure waste and fails without a C++ toolchain. The cost of
 * that choice is that the binaries which genuinely need a step must be handled here.
 *
 * Three packages, three different situations:
 *
 * ```
 * electron         ships no postinstall of its own      -> install-electron
 * better-sqlite3   ships N-API prebuilds for every OS   -> nothing to do
 * node-pty         ships prebuilds for darwin + win32   -> BUILD on linux only
 * ```
 *
 * `node-pty@1.1.0` has no `linux-x64` prebuild. Measured on CI: requiring it there fails
 * with `Cannot find module './prebuilds/linux-x64//pty.node'`, and since Forge ships on
 * Linux as well as Windows that is a real gap rather than a tolerable one. Windows and
 * macOS are left alone, because building there would reintroduce the toolchain
 * requirement this whole arrangement exists to avoid.
 *
 * Usage:
 *
 * ```
 * node scripts/setup-native.mjs          electron + pty  (npm run setup)
 * node scripts/setup-native.mjs --pty    pty only        (npm run setup:pty)
 * ```
 *
 * The `--pty` form exists for the lint/test CI job, which never launches the app and so
 * has no reason to download Electron's ~100MB binary, but does run the process tests.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ptyOnly = process.argv.includes('--pty')

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
}

if (!ptyOnly) {
  // Electron's binary. Its own package provides the fetcher; npm just never runs it.
  run('install-electron', [])
}

const ptyRoot = dirname(require.resolve('node-pty/package.json'))
const prebuild = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node')

if (existsSync(prebuild)) {
  console.log(`node-pty: using the shipped prebuild for ${process.platform}-${process.arch}`)
} else {
  // Built in place rather than via `npm rebuild`, which re-runs install scripts for the
  // whole tree and would drag better-sqlite3's pointless compile back in.
  //
  // Invoked through `npm exec` because `node-gyp` is not a dependency of this project and
  // so has no entry in `node_modules/.bin` — calling it directly fails with "command not
  // found". npm bundles its own copy, which `npm exec` resolves.
  console.log(`node-pty: no prebuild for ${process.platform}-${process.arch}, building`)
  run('npm', ['exec', '--yes', '--', 'node-gyp', 'rebuild'], { cwd: ptyRoot })
}
