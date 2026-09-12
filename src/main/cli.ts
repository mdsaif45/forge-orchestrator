import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  runStatusSchema,
  type ArtifactId,
  type ProjectId,
  type RunId,
  type RunStatus,
} from '@shared/domain'
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
  run <task>                 Execute an autonomous coding task against the current repository
  runs [list|inspect|events] Inspect past runs, steps, and event streams
  artifacts [list|cat]       Inspect and view run artifacts (patches, stdout, tool logs)
  status                     Display current repository status and Forge control plane state
  models [list|set]          Inspect or configure the active AI model and provider

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
  --limit <n>          Maximum number of runs to list
  --status <s>         Filter runs by status (running, completed, failed, halted)
  --all                Show runs across all projects (default: current repository only)
  --from <seq>         Starting event sequence number for events inspection
  --offset <n>         Byte offset for reading artifact window
  --length <n>         Byte length for reading artifact window
  --json               Output machine-readable NDJSON events (ideal for CI and subagents)
  -y, --yes            Unattended mode (auto-confirm operations)

${ANSI.bold}EXAMPLES${ANSI.reset}
  forge run "Fix failing tests in src/parser.ts"
  forge run "Add unit test for auth token validation" --model gpt-4o
  forge runs
  forge runs inspect 123e4567-e89b-12d3-a456-426614174000
  forge runs events 123e4567-e89b-12d3-a456-426614174000 --from 1
  forge artifacts list 123e4567-e89b-12d3-a456-426614174000
  forge artifacts cat 123e4567-e89b-12d3-a456-426614174000 --offset 0 --length 1024
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
      limit: { type: 'string' },
      status: { type: 'string' },
      all: { type: 'boolean', default: false },
      from: { type: 'string' },
      offset: { type: 'string' },
      length: { type: 'string' },
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

  if (command === 'runs') {
    return handleRuns({
      action: positionals[1],
      targetId: positionals[2],
      limit: values.limit,
      status: values.status,
      all: values.all,
      from: values.from,
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'artifacts') {
    return handleArtifacts({
      subcommandOrId: positionals[1],
      targetId: positionals[2],
      offset: values.offset,
      length: values.length,
      dataDir,
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
      console.log(`\n${ANSI.bold}Independent Verification & Criteria:${ANSI.reset}`)
      console.log(
        result.verification.passed
          ? `  ${ANSI.green}✓ Verdict: ${result.verification.verdict} (All completion criteria satisfied)${ANSI.reset}`
          : `  ${ANSI.red}✗ Verdict: ${result.verification.verdict}${ANSI.reset}`,
      )
      if (result.verification.criteria && result.verification.criteria.length > 0) {
        for (const crit of result.verification.criteria) {
          const icon =
            crit.verdict === 'pass'
              ? `${ANSI.green}✓${ANSI.reset}`
              : crit.verdict === 'fail'
                ? `${ANSI.red}✗${ANSI.reset}`
                : `${ANSI.yellow}?${ANSI.reset}`
          console.log(`    ${icon} [${crit.kind}] ${crit.description}: ${crit.reason}`)
        }
      }
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

function formatStatus(status: string): string {
  switch (status) {
    case 'completed':
      return `${ANSI.green}COMPLETED${ANSI.reset}`
    case 'failed':
      return `${ANSI.red}FAILED${ANSI.reset}`
    case 'running':
      return `${ANSI.cyan}RUNNING${ANSI.reset}`
    case 'halted':
      return `${ANSI.yellow}HALTED${ANSI.reset}`
    default:
      return status
  }
}

async function handleRuns(opts: {
  action?: string | undefined
  targetId?: string | undefined
  limit?: string | undefined
  status?: string | undefined
  all?: boolean | undefined
  from?: string | undefined
  cwd: string
  dataDir: string
  json: boolean
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    let action = opts.action ?? 'list'
    let targetId = opts.targetId

    if (action !== 'list' && action !== 'inspect' && action !== 'events') {
      targetId = action
      action = 'inspect'
    }

    if (action === 'list') {
      let limit: number | undefined
      if (opts.limit !== undefined) {
        limit = parseInt(opts.limit, 10)
        if (isNaN(limit) || limit < 0) {
          const err = `Invalid limit: ${opts.limit}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
      }

      let status: RunStatus | undefined
      if (opts.status !== undefined) {
        const parsed = runStatusSchema.safeParse(opts.status)
        if (!parsed.success) {
          const err = `Invalid status "${opts.status}". Valid statuses: ${runStatusSchema.options.join(', ')}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        status = parsed.data
      }

      let projectId: ProjectId | undefined
      if (!opts.all) {
        try {
          const projects = core.projects.list()
          const normCwd = resolve(opts.cwd)
          const match = projects.find((p) => resolve(p.repository.absolutePath) === normCwd)
          if (match) {
            projectId = match.id as ProjectId
          }
        } catch {
          // If project resolution fails, list runs unconstrained
        }
      }

      const runs = core.runs.listRuns({ limit, status, projectId })

      if (opts.json) {
        console.log(JSON.stringify({ runs }))
        return 0
      }

      printBanner()
      console.log(`\n${ANSI.bold}FORGE RUNS${ANSI.reset}`)
      if (runs.length === 0) {
        console.log(`  ${ANSI.dim}No runs found.${ANSI.reset}\n`)
        return 0
      }

      for (const run of runs) {
        const statusStr = formatStatus(run.status)
        const exitStr = run.exitCode !== null ? String(run.exitCode) : '-'
        let durationStr = '-'
        if (run.startedAt && run.finishedAt) {
          const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
          durationStr = `${(ms / 1000).toFixed(1)}s`
        }
        const taskText =
          typeof run.metadata.task === 'string'
            ? run.metadata.task
            : (run.summary ?? '(No description)')
        const obj = taskText.length > 50 ? taskText.slice(0, 47) + '...' : taskText

        console.log(
          `  ${ANSI.bold}${run.id}${ANSI.reset}  ${statusStr}  exit:${exitStr}  dur:${durationStr}`,
        )
        console.log(`    Task: ${obj}`)
        console.log(`    Date: ${ANSI.dim}${run.startedAt}${ANSI.reset}`)
      }
      console.log('')
      return 0
    }

    if (action === 'inspect') {
      const runId = targetId
      if (!runId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge runs inspect <runId> [--json]')
        }
        return 1
      }

      const run = core.runs.getRun(runId as RunId)
      if (!run) {
        const err = `Run "${runId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const steps = core.runs.listStepsForRun(runId as RunId)
      const artifacts = core.artifacts.listArtifacts(runId as RunId)

      if (opts.json) {
        console.log(JSON.stringify({ run, steps, artifacts }))
        return 0
      }

      printBanner()
      console.log(`\n${ANSI.bold}RUN DETAILS: ${ANSI.cyan}${run.id}${ANSI.reset}`)
      console.log(`  Project ID:  ${run.projectId}`)
      console.log(`  Status:      ${formatStatus(run.status)}`)
      const taskText =
        typeof run.metadata.task === 'string'
          ? run.metadata.task
          : (run.summary ?? '(No description)')
      console.log(`  Objective:   ${taskText}`)
      if (typeof run.metadata.baseSha === 'string') {
        console.log(`  Base SHA:    ${ANSI.dim}${run.metadata.baseSha}${ANSI.reset}`)
      }
      console.log(`  Exit Code:   ${run.exitCode !== null ? String(run.exitCode) : '-'}`)
      console.log(`  Started:     ${ANSI.dim}${run.startedAt}${ANSI.reset}`)
      console.log(`  Finished:    ${ANSI.dim}${run.finishedAt ?? '-'}${ANSI.reset}`)
      if (run.error) {
        console.log(`  Error:       ${ANSI.red}${run.error}${ANSI.reset}`)
      }

      console.log(`\n${ANSI.bold}STEPS (${String(steps.length)})${ANSI.reset}`)
      if (steps.length === 0) {
        console.log(`  ${ANSI.dim}(No steps recorded)${ANSI.reset}`)
      } else {
        for (const s of steps) {
          let dur = ''
          if (s.startedAt && s.finishedAt) {
            const ms = new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()
            dur = ` (${(ms / 1000).toFixed(2)}s)`
          }
          console.log(
            `  • #${String(s.index)} [${ANSI.cyan}${s.role}${ANSI.reset}] ${formatStatus(s.status)}${dur} - id: ${ANSI.dim}${s.id}${ANSI.reset}`,
          )
        }
      }

      console.log(`\n${ANSI.bold}ARTIFACTS (${String(artifacts.length)})${ANSI.reset}`)
      if (artifacts.length === 0) {
        console.log(`  ${ANSI.dim}(No artifacts recorded)${ANSI.reset}`)
      } else {
        for (const a of artifacts) {
          console.log(
            `  • ${ANSI.bold}${a.id}${ANSI.reset} [${ANSI.cyan}${a.kind}${ANSI.reset}] ${a.name} (${String(a.sizeBytes)} bytes)`,
          )
        }
      }
      console.log('')
      return 0
    }

    if (action === 'events') {
      const runId = targetId
      if (!runId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge runs events <runId> [--from <seq>] [--json]')
        }
        return 1
      }

      let fromSeq: number | undefined
      if (opts.from !== undefined) {
        fromSeq = parseInt(opts.from, 10)
        if (isNaN(fromSeq) || fromSeq < 0) {
          const err = `Invalid --from sequence: ${opts.from}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
      }

      const events = core.runs.listEventsForRun(runId as RunId, fromSeq)

      if (opts.json) {
        console.log(JSON.stringify({ events }))
        return 0
      }

      printBanner()
      console.log(`\n${ANSI.bold}RUN EVENTS: ${ANSI.cyan}${runId}${ANSI.reset}`)
      if (events.length === 0) {
        console.log(`  ${ANSI.dim}No events found.${ANSI.reset}\n`)
        return 0
      }

      for (const ev of events) {
        console.log(
          `  #${String(ev.seq)} [${ANSI.dim}${ev.occurredAt}${ANSI.reset}] ${ANSI.cyan}${ev.type}${ANSI.reset}`,
        )
        const payloadStr = typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload)
        if (payloadStr !== '{}' && payloadStr !== '') {
          const truncated = payloadStr.length > 80 ? payloadStr.slice(0, 77) + '...' : payloadStr
          console.log(`    ${ANSI.dim}${truncated}${ANSI.reset}`)
        }
      }
      console.log('')
      return 0
    }

    const err = `Unknown runs action: ${action}`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else {
      console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      console.error('Usage: forge runs [list|inspect|events] [options]')
    }
    return 1
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (opts.json) {
      console.log(JSON.stringify({ error: msg }))
    } else {
      console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
    }
    return 1
  } finally {
    await core.close()
  }
}

async function handleArtifacts(opts: {
  subcommandOrId?: string | undefined
  targetId?: string | undefined
  offset?: string | undefined
  length?: string | undefined
  dataDir: string
  json: boolean
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    let action = opts.subcommandOrId
    let id = opts.targetId

    if (action === 'cat') {
      // id is targetId
    } else if (action === 'list') {
      // id is targetId
    } else if (action !== undefined && id === undefined) {
      // User invoked `forge artifacts <runId>`
      id = action
      action = 'list'
    } else if (action === undefined) {
      const err = 'No arguments provided.'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else {
        console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        console.error('Usage: forge artifacts [list] <runId> | forge artifacts cat <artifactId>')
      }
      return 1
    }

    if (action === 'list') {
      const runId = id
      if (!runId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts list <runId> [--json]')
        }
        return 1
      }

      const artifacts = core.artifacts.listArtifacts(runId as RunId)

      if (opts.json) {
        console.log(JSON.stringify({ artifacts }))
        return 0
      }

      printBanner()
      console.log(`\n${ANSI.bold}ARTIFACTS FOR RUN: ${ANSI.cyan}${runId}${ANSI.reset}`)
      if (artifacts.length === 0) {
        console.log(`  ${ANSI.dim}No artifacts found for run ${runId}.${ANSI.reset}\n`)
        return 0
      }

      for (const art of artifacts) {
        console.log(
          `  • ${ANSI.bold}${art.id}${ANSI.reset} [${ANSI.cyan}${art.kind}${ANSI.reset}] ${art.name} (${String(art.sizeBytes)} bytes)`,
        )
        console.log(
          `    SHA256: ${ANSI.dim}${art.sha256}${ANSI.reset}  Path: ${ANSI.dim}${art.relativePath}${ANSI.reset}`,
        )
      }
      console.log('')
      return 0
    }

    if (action === 'cat') {
      const artifactId = id
      if (!artifactId) {
        const err = 'No artifact ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts cat <artifactId> [--offset <n>] [--length <n>]')
        }
        return 1
      }

      const meta = core.artifacts.getMetadata(artifactId as ArtifactId)
      if (!meta) {
        const err = `Artifact "${artifactId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const hasOffset = opts.offset !== undefined
      const hasLength = opts.length !== undefined

      if (hasOffset || hasLength) {
        const offset = opts.offset !== undefined ? parseInt(opts.offset, 10) : 0
        const length = opts.length !== undefined ? parseInt(opts.length, 10) : 65536

        if (isNaN(offset) || offset < 0) {
          const err = `Invalid offset: ${String(opts.offset)}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        if (isNaN(length) || length <= 0) {
          const err = `Invalid length: ${String(opts.length)}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }

        const window = await core.artifacts.readWindow(artifactId as ArtifactId, offset, length)
        const content = window.data.toString('utf-8')
        if (opts.json) {
          console.log(
            JSON.stringify({
              artifactId,
              offset,
              length,
              totalBytes: window.totalBytes,
              data: content,
            }),
          )
        } else {
          process.stdout.write(content)
        }
      } else {
        const text = await core.artifacts.readArtifactText(artifactId as ArtifactId)
        if (opts.json) {
          console.log(JSON.stringify({ artifactId, sizeBytes: meta.sizeBytes, data: text }))
        } else {
          process.stdout.write(text)
        }
      }
      return 0
    }

    const err = `Unknown artifacts action: ${action}`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else {
      console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      console.error('Usage: forge artifacts [list] <runId> | forge artifacts cat <artifactId>')
    }
    return 1
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (opts.json) {
      console.log(JSON.stringify({ error: msg }))
    } else {
      console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
    }
    return 1
  } finally {
    await core.close()
  }
}
