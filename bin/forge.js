#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const compiledCli = join(__dirname, '../out/main/cli.js')

if (existsSync(compiledCli)) {
  const { runCli } = await import(compiledCli)
  const exitCode = await runCli(process.argv.slice(2))
  process.exit(exitCode)
} else {
  const tsEntry = join(__dirname, 'forge.ts')
  const proc = spawn(process.execPath, ['--import', 'tsx', tsEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  proc.on('exit', (code) => process.exit(code ?? 0))
}
