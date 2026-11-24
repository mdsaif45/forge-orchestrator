#!/usr/bin/env tsx
import { runCli } from '@forge/cli'

const exitCode = await runCli(process.argv.slice(2))
process.exit(exitCode)
