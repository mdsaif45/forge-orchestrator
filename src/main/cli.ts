import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createForgeCore, resolveDataDir } from './core/forgeCore'
import { executeDirectTask, type DirectTaskEvent } from './core/taskRunner'
import { GitService } from './git'

const VERSION = '0.3.0-alpha.1'

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function printBanner(): void {
  console.log(
    `${ANSI.bold}${ANSI.cyan}Forge${ANSI.reset} ${ANSI.dim}v${VERSION}${ANSI.reset} - AI Engineering Control Plane & Autonomous Coding Agent`,
  )
}

function printHelp(): void {
  printBanner()
  console.log(`
${ANSI.bold}USAGE${ANSI.reset}
  forge <command> [options]

${ANSI.bold}COMMANDS${ANSI.reset}
  run <task>           Execute an autonomous coding task against the current repository
  status               Display current repository status and Forge control plane state
  models [list|set]    Inspect or configure the active AI model and provider

${ANSI.bold}OPTIONS${ANSI.reset}
  -v, --version        Display Forge version
  -h, --help           Show this help message
  --cwd <path>         Working repository directory (defaults to current working directory)
  --data-dir <path>    Storage directory for Forge databases and logs (default: ~/.forge)
  -m, --model <name>   Model name override (e.g., qwen2.5-coder:7b, gpt-4o)
  -p, --provider <id>  Provider override (ollama, openai, openrouter)
  --endpoint <url>     Custom OpenAI/Ollama API endpoint URL
  --api-key <key>      API key for cloud model providers
  --max-rounds <n>     Maximum tool execution rounds (default: 15)
  --json               Output machine-readable NDJSON events (ideal for CI and subagents)
  -y, --yes            Unattended mode (auto-confirm operations)

${ANSI.bold}EXAMPLES${ANSI.reset}
  forge run "Fix failing tests in src/parser.ts"
  forge run "Add unit test for auth token validation" --model gpt-4o
  forge run "Refactor database migrations" --json
  forge models set ollama qwen2.5-coder:7b
`)
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      cwd: { type: 'string' },
      model: { type: 'string', short: 'm' },
      provider: { type: 'string', short: 'p' },
      endpoint: { type: 'string' },
      'api-key': { type: 'string' },
      'data-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      'max-rounds': { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: true,
  })

  if (values.version) {
    if (values.json) {
      console.log(JSON.stringify({ version: VERSION }))
    } else {
      console.log(`forge v${VERSION}`)
    }
    return 0
  }

  const command = positionals[0]

  if (values.help || command === undefined || command === 'help') {
    printHelp()
    return 0
  }

  const cwd = resolve(values.cwd ?? process.cwd())
  const dataDir = resolveDataDir(values['data-dir'])

  if (command === 'status') {
    return handleStatus({ cwd, dataDir, json: values.json })
  }

  if (command === 'models') {
    return handleModels({
      action: positionals[1] ?? 'list',
      provider: positionals[2],
      model: positionals[3],
      endpoint: values.endpoint,
      apiKey: values['api-key'],
      dataDir,
      json: values.json,
    })
  }

  if (command === 'run') {
    const taskObjective = positionals.slice(1).join(' ').trim()
    if (taskObjective === '') {
      console.error(`${ANSI.red}Error: No task description provided.${ANSI.reset}`)
      console.error('Usage: forge run "<task description>"')
      return 1
    }

    const maxRounds = values['max-rounds'] ? parseInt(values['max-rounds'], 10) : 15

    return handleRun({
      cwd,
      dataDir,
      task: taskObjective,
      model: values.model,
      providerId: values.provider,
      endpointUrl: values.endpoint,
      apiKey: values['api-key'],
      maxRounds,
      json: values.json,
    })
  }

  console.error(`${ANSI.red}Unknown command: ${command}${ANSI.reset}`)
  printHelp()
  return 1
}

async function handleStatus(opts: {
  cwd: string
  dataDir: string
  json: boolean
}): Promise<number> {
  const git = new GitService({ repositoryPath: opts.cwd })
  try {
    const status = await git.status()
    const head = await git.headSha()
    const branch = await git.currentBranch()

    if (opts.json) {
      console.log(
        JSON.stringify({
          repository: opts.cwd,
          dataDir: opts.dataDir,
          head,
          branch,
          clean: status.entries.length === 0 && status.untracked.length === 0,
          entries: status.entries,
          untracked: status.untracked,
        }),
      )
      return 0
    }

    printBanner()
    console.log(`\n${ANSI.bold}REPOSITORY STATUS${ANSI.reset}`)
    console.log(`  Path:    ${opts.cwd}`)
    console.log(`  Branch:  ${ANSI.cyan}${branch ?? 'detached'}${ANSI.reset}`)
    console.log(`  HEAD:    ${ANSI.dim}${head ?? 'none'}${ANSI.reset}`)
    console.log(`  Data:    ${ANSI.dim}${opts.dataDir}${ANSI.reset}`)

    const dirtyCount = status.entries.length + status.untracked.length
    if (dirtyCount === 0) {
      console.log(`  Working: ${ANSI.green}Clean (0 uncommitted changes)${ANSI.reset}`)
    } else {
      console.log(
        `  Working: ${ANSI.yellow}${String(dirtyCount)} uncommitted change(s)${ANSI.reset} (${String(status.entries.length)} tracked, ${String(status.untracked.length)} untracked)`,
      )
    }

    return 0
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (opts.json) {
      console.log(JSON.stringify({ error: msg }))
    } else {
      console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
    }
    return 1
  }
}

async function handleModels(opts: {
  action: string
  provider?: string | undefined
  model?: string | undefined
  endpoint?: string | undefined
  apiKey?: string | undefined
  dataDir: string
  json: boolean
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    if (opts.action === 'set') {
      if (!opts.provider || !opts.model) {
        console.error(`${ANSI.red}Usage: forge models set <provider> <model>${ANSI.reset}`)
        return 1
      }

      core.activeModel.write({
        providerId: opts.provider,
        model: opts.model,
        ...(opts.endpoint ? { endpointUrl: opts.endpoint } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      })

      if (opts.json) {
        console.log(
          JSON.stringify({
            updated: true,
            provider: opts.provider,
            model: opts.model,
          }),
        )
      } else {
        console.log(
          `${ANSI.green}✓ Updated active model to ${ANSI.bold}${opts.provider} (${opts.model})${ANSI.reset}`,
        )
      }
      return 0
    }

    const active = core.activeModel.read()
    if (opts.json) {
      console.log(JSON.stringify({ active }))
    } else {
      printBanner()
      console.log(`\n${ANSI.bold}ACTIVE MODEL${ANSI.reset}`)
      if (active === null) {
        console.log(`  ${ANSI.yellow}No active model configured.${ANSI.reset}`)
        console.log(
          `  Configure one with: ${ANSI.cyan}forge models set ollama qwen2.5-coder:7b${ANSI.reset}`,
        )
      } else {
        console.log(`  Provider: ${ANSI.cyan}${active.providerId}${ANSI.reset}`)
        console.log(`  Model:    ${ANSI.bold}${active.model}${ANSI.reset}`)
        if (active.endpointUrl) {
          console.log(`  Endpoint: ${ANSI.dim}${active.endpointUrl}${ANSI.reset}`)
        }
      }
    }
    return 0
  } finally {
    await core.close()
  }
}

async function handleRun(opts: {
  cwd: string
  dataDir: string
  task: string
  model?: string | undefined
  providerId?: string | undefined
  endpointUrl?: string | undefined
  apiKey?: string | undefined
  maxRounds: number
  json: boolean
}): Promise<number> {
  if (!opts.json) {
    printBanner()
    console.log(`\n${ANSI.bold}TASK OBJECTIVE${ANSI.reset}`)
    console.log(`  ${opts.task}\n`)
  }

  const core = createForgeCore({ dataDir: opts.dataDir })

  const handleEvent = (event: DirectTaskEvent): void => {
    if (opts.json) {
      console.log(JSON.stringify(event))
      return
    }

    switch (event.kind) {
      case 'status':
        console.log(`${ANSI.dim}▸ ${event.text}${ANSI.reset}`)
        break
      case 'tool_start':
        console.log(`${ANSI.cyan}⚙ ${event.name}${ANSI.reset} ${event.detail ?? ''}`)
        break
      case 'tool_end':
        console.log(
          event.ok
            ? `${ANSI.green}✓ ${event.name}${ANSI.reset}`
            : `${ANSI.red}✗ ${event.name}${ANSI.reset}`,
        )
        break
      case 'reasoning':
        console.log(`${ANSI.magenta}🧠 ${event.text}${ANSI.reset}`)
        break
      case 'content':
        process.stdout.write(event.text)
        break
      case 'discrepancy':
        console.log(`${ANSI.yellow}⚠ Discrepancy: ${event.detail}${ANSI.reset}`)
        break
      case 'verification':
        console.log(
          event.verdict === 'pass'
            ? `${ANSI.green}✓ Verification (${event.verdict}): ${event.detail}${ANSI.reset}`
            : `${ANSI.red}✗ Verification (${event.verdict}): ${event.detail}${ANSI.reset}`,
        )
        break
    }
  }

  try {
    const result = await executeDirectTask(core, {
      workspacePath: opts.cwd,
      task: opts.task,
      model: opts.model,
      providerId: opts.providerId,
      endpointUrl: opts.endpointUrl,
      apiKey: opts.apiKey,
      maxRounds: opts.maxRounds,
      onEvent: handleEvent,
    })

    if (opts.json) {
      console.log(JSON.stringify({ type: 'result', result }))
      return result.exitCode
    }

    // Render Authoritative Verification and Physical Evidence Summary
    console.log(`\n${ANSI.bold}==================================================${ANSI.reset}`)
    console.log(`${ANSI.bold}FORGE EVIDENCE & RECONCILIATION REPORT${ANSI.reset}`)
    console.log(`${ANSI.bold}==================================================${ANSI.reset}`)
    console.log(
      `  Status:       ${result.ok ? ANSI.green + 'SUCCESS' : ANSI.red + 'FAILED'}${ANSI.reset}`,
    )
    console.log(`  Run ID:       ${ANSI.dim}${result.runId}${ANSI.reset}`)
    console.log(`  Evidence ID:  ${ANSI.dim}${result.evidence.id}${ANSI.reset}`)
    console.log(`  Exit Code:    ${String(result.exitCode)}`)
    console.log(`  Rounds Used:  ${String(result.rounds)}`)
    console.log(`  Duration:     ${(result.durationMs / 1000).toFixed(2)}s`)
    console.log(`  Base SHA:     ${ANSI.dim}${result.baseSha}${ANSI.reset}`)

    console.log(
      `\n${ANSI.bold}Physical Git Changes (${String(result.physicalDiff.files.length)} file(s)):${ANSI.reset}`,
    )
    if (result.physicalDiff.files.length === 0) {
      console.log(`  ${ANSI.dim}(No physical changes detected on disk)${ANSI.reset}`)
    } else {
      for (const file of result.physicalDiff.files) {
        console.log(
          `  ${ANSI.cyan}${file.path}${ANSI.reset} ${ANSI.green}+${String(file.insertions)}${ANSI.reset} ${ANSI.red}-${String(file.deletions)}${ANSI.reset}`,
        )
      }
    }

    if (result.discrepancies.length > 0) {
      console.log(`\n${ANSI.bold}${ANSI.yellow}Reconciliation Discrepancies:${ANSI.reset}`)
      for (const d of result.discrepancies) {
        console.log(`  ${ANSI.yellow}• [${d.kind}] ${d.path}: ${d.detail}${ANSI.reset}`)
      }
    } else {
      console.log(
        `\n${ANSI.green}✓ Ground-Truth Reconciliation: Claim matches physical git reality perfectly.${ANSI.reset}`,
      )
    }

    if (result.outOfScopeFiles.length > 0) {
      console.log(`\n${ANSI.bold}${ANSI.red}Scope Policy Violations:${ANSI.reset}`)
      for (const f of result.outOfScopeFiles) {
        console.log(`  ${ANSI.red}• File modified outside permitted scope: ${f}${ANSI.reset}`)
      }
    }

    if (result.verification !== undefined) {
      console.log(`\n${ANSI.bold}Independent Verification:${ANSI.reset}`)
      console.log(
        result.verification.passed
          ? `  ${ANSI.green}✓ Verdict: ${result.verification.verdict} (All completion criteria satisfied)${ANSI.reset}`
          : `  ${ANSI.red}✗ Verdict: ${result.verification.verdict}${ANSI.reset}`,
      )
      if (result.verification.findings.length > 0) {
        for (const finding of result.verification.findings) {
          console.log(`    ${ANSI.red}• ${finding}${ANSI.reset}`)
        }
      }
    }

    console.log(`${ANSI.bold}==================================================${ANSI.reset}\n`)
    return result.exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (opts.json) {
      console.log(JSON.stringify({ type: 'error', error: message }))
    } else {
      console.error(`\n${ANSI.red}${ANSI.bold}Execution Error:${ANSI.reset} ${message}\n`)
    }
    return 1
  } finally {
    await core.close()
  }
}
