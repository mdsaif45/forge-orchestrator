#!/usr/bin/env tsx
import { runCli } from '../src/index'

const exitCode = await runCli(process.argv.slice(2))
process.exit(exitCode)
