import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifactIdSchema,
  compileLinearTemplateToGraph,
  BUG_FIX,
  FEATURE_IMPLEMENTATION,
  projectIdSchema,
  runIdSchema,
  runStatusSchema,
  stepIdSchema,
  workflowIdSchema,
  type ProjectId,
  type RunStatus,
  type WorkflowTemplateV2,
} from '@shared/domain'
import type { WorkflowDetailView, WorkflowSummaryView } from '@shared/views'
import { createForgeCore, resolveDataDir } from './core/forgeCore'
import { executeDirectTask, type DirectTaskEvent } from './core/taskRunner'
import { GitService } from './git'
import { discoverOllamaModels } from './providers/ollamaDiscovery'
import {
  probeRuntimeExecutable,
  runtimeDescription,
  runtimeExecutable,
  testRuntimeExecution,
} from './runtimes'
import {
  findForgeConfigFile,
  getForgeConfigValue,
  listForgeProfiles,
  loadForgeConfig,
  setForgeConfigValue,
  switchForgeProfile,
} from './config/forgeConfig'
import { auditForgeEnvironment } from './config/configDoctor'
import { exportRunArtifactArchive } from './artifacts'
import {
  auditDatabaseIntegrity,
  backupDatabase,
  compactRunEvents,
  getDatabaseStats,
  inspectProjectRegistry,
  pruneMissingProjects,
  pruneOrphanedDatabaseRecords,
  restoreDatabase,
  vacuumDatabase,
} from './db'
import { ProjectStore } from './db/projectStore'
import {
  auditArtifactChecksums,
  auditChangesetCoverage,
  auditRunChangesetConflicts,
  auditRunChangesetSecurity,
  executeVerificationPipeline,
  inspectRunDiff,
  parseLcov,
  rollbackRunChanges,
  scanDiffForSecretLeaks,
  synthesizeRunChangesetCommit,
  type FileCoverageData,
} from './evidence'
import { DEFAULT_TEMPLATES_V2 } from './templates/defaultTemplatesV2'
import {
  discoverCustomTemplates,
  validateCustomTemplateFile,
} from './templates/customTemplateLoader'
import {
  createWorkflowSnapshot,
  listDeadLetterQueue,
  listWorkflowSnapshots,
  planParallelBatches,
  planWorkflowExecution,
  profileWorkflowExecution,
  purgeDeadLetterQueue,
  restoreWorkflowSnapshot,
  StepTimeoutSupervisor,
} from './workflows'
import { validateTemplateGraph } from './workflows/validation'
import { auditRuntimeQuotas, createResourceBudget, sanitizeRuntimeEnvironment } from './runtimes'
import { calculateRunTokenAccounting } from './core/tokenAccounting'
import { optimizePromptPacket } from './core/promptOptimizer'
import {
  getMemoryStats,
  indexRunMemory,
  queryAgentMemory,
  ModelCircuitBreaker,
  ToolRateLimiter,
} from './core'
import {
  bootstrapForgeConfig,
  getVaultSecret,
  listVaultSecrets,
  setVaultSecret,
  auditConfigAgainstPolicies,
  interpolateEnvString,
  type PolicyLockRule,
} from './config'

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
  runs [list|inspect|events|cost] Inspect past runs, steps, token accounting, and event streams
  workflows [list|inspect|run|resume|cancel|approve|init|validate|plan|profile|templates|parallel|snapshot|dlq|timeout] Inspect, plan, profile, snapshot workflows, manage DLQ, and inspect step timeouts
  artifacts [list|cat|grep|verify|export] Inspect, view, search, verify, and export run artifacts
  diff [revert|security|secrets|commit|merge] <runId> [stepId|runIdB] Inspect physical diffs, rollback changes, security/secrets audit, commit synthesis, or merge conflicts
  processes [list]           Inspect active and completed background process metrics
  status                     Display current repository status and Forge control plane state
  models [list|scan|auto|set|fallback|circuit] Inspect, auto-select, fallback routing, and circuit breakers
  runtimes [list|test|env|quota|rate-limit] Inspect registered runtimes, test execution, sanitized environment, quotas, and tool rate limits
  context [inspect|optimize] Inspect prompt packet, context files, or prefix caching optimization
  memory [search|index|stats] Search, index, and inspect cross-run solution memory and semantic patterns
  projects [list|prune]      Inspect multi-project workspace registry, health, and prune missing projects
  verify [pipeline|coverage] Execute ordered verification pipeline or audit code coverage regression delta
  config [list|get|set|profile|doctor|vault|init|policy|interpolate] Inspect, profile, doctor, secret vault encryption, workspace bootstrap, policy lock, and env interpolation
  db [stats|vacuum|backup|restore|compact|audit] Inspect SQLite database storage, backup, restore, compaction, and integrity/orphan audit

${ANSI.bold}OPTIONS${ANSI.reset}
  -v, --version        Display Forge version
  -h, --help           Show this help message
  --cwd <path>         Working repository directory (defaults to current working directory)
  --data-dir <path>    Storage directory for Forge databases and logs (default: ~/.forge)
  -m, --model <name>   Model name override (e.g., qwen2.5-coder:7b, gpt-4o)
  -p, --provider <id>  Provider override (ollama, openai, openrouter)
  --endpoint <url>     Custom OpenAI/Ollama API endpoint URL
  --api-key <key>      API key for cloud model providers
  --passphrase <key>   Passphrase for secret vault encryption/decryption
  --before <date>      Cutoff timestamp for event compaction (ISO-8601)
  --max-rounds <n>     Maximum tool execution rounds (default: 15)
  --limit <n>          Maximum number of runs to list
  --status <s>         Filter runs by status (running, completed, failed, halted)
  --all                Show runs across all projects (default: current repository only)
  --from <seq>         Starting event sequence number for events inspection
  --offset <n>         Byte offset for reading artifact window
  --length <n>         Byte length for reading artifact window
  --project <path|id>  Target project path or ID for workflow operations
  --template <name>    Workflow template (feature, bugfix, refactor, spike)
  --objective <text>   Task objective summary for workflow initialization
  --run                Immediately execute initialized workflow
  -i, --ignore-case    Case-insensitive search for artifact grep
  --max-matches <n>    Maximum matches to output for artifact grep (default: 50)
  --pattern <pattern>  Regex or substring search pattern
  --stat               Display file statistics only for diff command
  --min-coverage <pct> Minimum required coverage percentage (default: 80)
  --profile <name>     Activate specific environment configuration profile
  --force              Force potentially destructive operations (e.g. database restore)
  --json               Output machine-readable JSON (NDJSON stream for 'run', JSON document for inspection commands)
  -y, --yes            Unattended mode (auto-confirm operations)

${ANSI.bold}EXAMPLES${ANSI.reset}
  forge run "Fix failing tests in src/parser.ts"
  forge run "Add unit test for auth token validation" --model gpt-4o
  forge workflows init --template feature --objective "Implement auth" --run
  forge workflows validate FEATURE_IMPLEMENTATION
  forge workflows run 123e4567-e89b-12d3-a456-426614174000
  forge artifacts grep 123e4567-e89b-12d3-a456-426614174000 "FAIL" -i
  forge context inspect 123e4567-e89b-12d3-a456-426614174000
  forge runtimes list
  forge runtimes test forge-native-agent
  forge config get logLevel
  forge config set logLevel debug
  forge db stats
  forge db vacuum
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
      reason: { type: 'string' },
      project: { type: 'string' },
      template: { type: 'string' },
      objective: { type: 'string' },
      task: { type: 'string' },
      run: { type: 'boolean', default: false },
      'ignore-case': { type: 'boolean', short: 'i', default: false },
      'max-matches': { type: 'string' },
      pattern: { type: 'string' },
      profile: { type: 'string' },
      stat: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      passphrase: { type: 'string' },
      before: { type: 'string' },
      'min-coverage': { type: 'string' },
      fix: { type: 'boolean', default: false },
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

  if (command === 'workflows' || command === 'workflow') {
    return handleWorkflows({
      action: positionals[1],
      targetId: positionals[2],
      extraParam: positionals[3],
      thirdParam: positionals[4],
      limit: values.limit,
      all: values.all,
      cwd,
      dataDir,
      json: values.json,
      reason: values.reason,
      project: values.project,
      template: values.template,
      objective: values.objective,
      task: values.task,
      run: values.run,
    })
  }

  if (command === 'artifacts') {
    return handleArtifacts({
      subcommandOrId: positionals[1],
      targetId: positionals[2],
      pattern: positionals[3] ?? values.pattern,
      offset: values.offset,
      length: values.length,
      ignoreCase: values['ignore-case'],
      maxMatches: values['max-matches'],
      dataDir,
      json: values.json,
    })
  }

  if (command === 'runtimes' || command === 'runtime') {
    return handleRuntimes({
      action: positionals[1],
      targetId: positionals[2],
      dataDir,
      json: values.json,
    })
  }

  if (command === 'context') {
    return handleContext({
      action: positionals[1],
      runId: positionals[2],
      stepId: positionals[3],
      dataDir,
      json: values.json,
    })
  }

  if (command === 'projects' || command === 'project') {
    return handleProjects({
      action: positionals[1] ?? 'list',
      targetId: positionals[2],
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'verify' || command === 'pipeline') {
    if (positionals[1] === 'coverage') {
      return handleVerifyCoverage({
        runId: positionals[2],
        reportPath: positionals[3],
        minCoverage: values['min-coverage'] ? parseFloat(values['min-coverage']) : undefined,
        cwd,
        dataDir,
        json: values.json,
      })
    }
    const configPathOrCommand = positionals[1] === 'pipeline' ? positionals[2] : positionals[1]
    return handleVerifyPipeline({
      configPathOrCommand,
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'config') {
    return handleConfig({
      action: positionals[1],
      key: positionals[2],
      val: positionals[3],
      extraParam: positionals[4],
      passphrase: values.passphrase,
      force: values.force,
      profile: values.profile,
      model: values.model,
      provider: values.provider,
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'diff') {
    if (positionals[1] === 'merge') {
      return handleDiffMerge({
        runIdA: positionals[2],
        runIdB: positionals[3],
        dryRun: values['dry-run'],
        dataDir,
        json: values.json,
      })
    }
    if (positionals[1] === 'commit') {
      return handleDiffCommit({
        runId: positionals[2],
        task: values.task,
        dryRun: values['dry-run'],
        dataDir,
        json: values.json,
      })
    }
    if (positionals[1] === 'security') {
      return handleDiffSecurity({
        runId: positionals[2],
        stepId: positionals[3],
        dataDir,
        json: values.json,
      })
    }
    if (positionals[1] === 'secrets') {
      return handleDiffSecrets({
        runId: positionals[2],
        stepId: positionals[3],
        dataDir,
        json: values.json,
      })
    }
    if (positionals[1] === 'revert') {
      return handleDiffRevert({
        runId: positionals[2],
        stepId: positionals[3],
        dryRun: values['dry-run'],
        cwd,
        dataDir,
        json: values.json,
      })
    }
    return handleDiff({
      runId: positionals[1],
      stepId: positionals[2],
      stat: values.stat,
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'memory') {
    return handleMemory({
      action: positionals[1],
      target: positionals[2],
      limit: values.limit,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'processes' || command === 'process') {
    return handleProcesses({
      action: positionals[1],
      cwd,
      dataDir,
      json: values.json,
    })
  }

  if (command === 'db') {
    return handleDb({
      action: positionals[1],
      targetPath: positionals[2],
      force: values.force,
      dryRun: values['dry-run'],
      beforeDate: values.before,
      fix: values.fix,
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
    if (opts.action === 'fallback') {
      const active = core.activeModel.read()
      const breaker = new ModelCircuitBreaker()
      const statuses = breaker.getAllStatuses()
      const fallbackConfig = {
        primary: {
          providerId: active?.providerId ?? 'ollama',
          model: active?.model ?? 'qwen2.5-coder:7b',
        },
        fallbacks: [
          { providerId: 'ollama', model: 'deepseek-coder:6.7b' },
          { providerId: 'openai', model: 'gpt-4o' },
        ],
      }
      if (opts.json) {
        console.log(JSON.stringify({ fallbackConfig, circuitStatuses: statuses }))
      } else {
        printBanner()
        console.log(`\n${ANSI.bold}MODEL FALLBACK CHAIN & CIRCUIT BREAKERS${ANSI.reset}`)
        console.log(
          `  Primary:    ${fallbackConfig.primary.providerId} (${fallbackConfig.primary.model})`,
        )
        for (const [i, fb] of fallbackConfig.fallbacks.entries()) {
          console.log(`  Fallback ${String(i + 1)}: ${fb.providerId} (${fb.model})`)
        }
      }
      return 0
    }

    if (opts.action === 'circuit') {
      const breaker = new ModelCircuitBreaker()
      const statuses = breaker.getAllStatuses()
      if (opts.json) {
        console.log(JSON.stringify({ circuits: statuses }))
      } else {
        printBanner()
        console.log(`\n${ANSI.bold}CIRCUIT BREAKER STATUS${ANSI.reset}`)
        if (statuses.length === 0) {
          console.log(`  All model provider circuits are CLOSED (healthy).`)
        } else {
          for (const s of statuses) {
            console.log(
              `  ${s.providerId}: ${s.state} (Failures: ${String(s.consecutiveFailures)})`,
            )
          }
        }
      }
      return 0
    }

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

    if (opts.action === 'auto') {
      const discovery = await discoverOllamaModels({
        endpointUrl: opts.endpoint,
        probeCapabilities: false,
      })

      if (!discovery.reachable) {
        const err = `Ollama is offline or unreachable at ${discovery.endpoint} (${discovery.error ?? 'Connection failed'})`
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: err }))
        } else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        }
        return 1
      }

      if (discovery.models.length === 0) {
        const err = `Connected to ${discovery.endpoint}, but no models are installed. Run 'ollama pull <model>' first.`
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: err }))
        } else {
          console.error(`${ANSI.yellow}Warning: ${err}${ANSI.reset}`)
        }
        return 1
      }

      // Priority: 1. Coding model with tools, 2. Any tool-capable model, 3. Any coding model, 4. First available
      const best =
        discovery.models.find((m) => m.isCodingModel && m.capabilities.tools) ??
        discovery.models.find((m) => m.capabilities.tools) ??
        discovery.models.find((m) => m.isCodingModel) ??
        discovery.models[0]

      if (!best) {
        const err = 'No suitable model could be selected.'
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      core.activeModel.write({
        providerId: 'ollama',
        model: best.name,
        ...(opts.endpoint ? { endpointUrl: opts.endpoint } : {}),
      })

      if (opts.json) {
        console.log(
          JSON.stringify({
            updated: true,
            provider: 'ollama',
            model: best.name,
            reason: 'auto-selected',
            details: best,
          }),
        )
      } else {
        console.log(
          `${ANSI.green}✓ Auto-selected active model: ${ANSI.bold}ollama (${best.name})${ANSI.reset} [coding=${best.isCodingModel ? 'yes' : 'no'}, tools=${best.capabilities.tools ? 'yes' : 'no'}]`,
        )
      }
      return 0
    }

    const active = core.activeModel.read()
    const discovery = await discoverOllamaModels({
      endpointUrl: opts.endpoint,
      probeCapabilities: false,
    })

    if (opts.json) {
      console.log(
        JSON.stringify({
          active,
          ollama: {
            reachable: discovery.reachable,
            endpoint: discovery.endpoint,
            models: discovery.models,
            error: discovery.error,
          },
        }),
      )
    } else {
      printBanner()
      console.log(`\n${ANSI.bold}ACTIVE MODEL${ANSI.reset}`)
      if (active === null) {
        console.log(`  ${ANSI.yellow}No active model configured.${ANSI.reset}`)
        console.log(
          `  Configure one with: ${ANSI.cyan}forge models set ollama qwen2.5-coder:7b${ANSI.reset} or ${ANSI.cyan}forge models auto${ANSI.reset}`,
        )
      } else {
        console.log(`  Provider: ${ANSI.cyan}${active.providerId}${ANSI.reset}`)
        console.log(`  Model:    ${ANSI.bold}${active.model}${ANSI.reset}`)
        if (active.endpointUrl) {
          console.log(`  Endpoint: ${ANSI.dim}${active.endpointUrl}${ANSI.reset}`)
        }
      }

      console.log(`\n${ANSI.bold}LOCAL OLLAMA MODELS${ANSI.reset} (${discovery.endpoint})`)
      if (!discovery.reachable) {
        console.log(`  ${ANSI.dim}Ollama daemon unreachable or offline.${ANSI.reset}`)
      } else if (discovery.models.length === 0) {
        console.log(`  ${ANSI.dim}No local models found on this Ollama instance.${ANSI.reset}`)
      } else {
        for (const m of discovery.models) {
          const isActive = active?.providerId === 'ollama' && active.model === m.name
          const marker = isActive ? `${ANSI.green}* ${ANSI.reset}` : '  '
          const codingTag = m.isCodingModel ? `${ANSI.cyan}[coding]${ANSI.reset}` : ''
          const toolTag = m.capabilities.tools ? `${ANSI.magenta}[tools]${ANSI.reset}` : ''
          const sizeStr = m.parameterSize ? `(${m.parameterSize})` : ''
          console.log(
            `${marker}${ANSI.bold}${m.name}${ANSI.reset} ${sizeStr} ${codingTag} ${toolTag}`,
          )
        }
        console.log(
          `\n  Tip: Run ${ANSI.cyan}forge models auto${ANSI.reset} to automatically configure the best coding model.`,
        )
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

    if (
      action !== 'list' &&
      action !== 'inspect' &&
      action !== 'events' &&
      action !== 'cost' &&
      action !== 'budget'
    ) {
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
          const normCwd = resolve(opts.cwd).toLowerCase()
          const match = projects.find(
            (p) => resolve(p.repository.absolutePath).toLowerCase() === normCwd,
          )
          if (!match) {
            const err = `Current directory "${opts.cwd}" is not a registered Forge project. Use --all to list runs across all projects.`
            if (opts.json) console.log(JSON.stringify({ error: err }))
            else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
            return 1
          }
          projectId = projectIdSchema.parse(match.id)
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          const err = `Failed to resolve current Forge project: ${msg}. Use --all to list runs across all projects.`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
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
      const rawRunId = targetId
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge runs inspect <runId> [--json]')
        }
        return 1
      }

      const parsedRunId = runIdSchema.safeParse(rawRunId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${rawRunId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const runId = parsedRunId.data

      const run = core.runs.getRun(runId)
      if (!run) {
        const err = `Run "${runId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const steps = core.runs.listStepsForRun(runId)
      const artifacts = core.artifacts.listArtifacts(runId)

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
      const rawRunId = targetId
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge runs events <runId> [--from <seq>] [--json]')
        }
        return 1
      }

      const parsedRunId = runIdSchema.safeParse(rawRunId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${rawRunId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const runId = parsedRunId.data

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

      const events = core.runs.listEventsForRun(runId, fromSeq)

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

    if (action === 'cost' || action === 'budget') {
      const rawRunId = targetId
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge runs cost <runId> [--json]')
        }
        return 1
      }

      const accounting = calculateRunTokenAccounting(core.runs, rawRunId)
      if (!accounting.valid) {
        if (opts.json) console.log(JSON.stringify(accounting))
        else {
          console.error(
            `${ANSI.red}Error: ${accounting.error ?? 'Token accounting failed'}${ANSI.reset}`,
          )
        }
        return 1
      }

      if (opts.json) {
        console.log(JSON.stringify(accounting))
        return 0
      }

      console.log(`\n${accounting.formattedSummary}\n`)
      return 0
    }

    const err = `Unknown runs action: ${action}`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else {
      console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      console.error('Usage: forge runs [list|inspect|events|cost] [options]')
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

function isTextArtifact(meta: { mimeType: string; name: string }, sample: Buffer): boolean {
  const mime = meta.mimeType.toLowerCase()
  if (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime.startsWith('font/') ||
    mime === 'application/pdf' ||
    mime === 'application/zip' ||
    mime === 'application/gzip' ||
    mime === 'application/x-tar' ||
    mime === 'application/octet-stream'
  ) {
    return false
  }

  const binaryExtensions = new Set([
    'bin',
    'exe',
    'dll',
    'so',
    'dylib',
    'iso',
    'zip',
    'tar',
    'gz',
    'bz2',
    '7z',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'ico',
    'webp',
    'mp3',
    'wav',
    'ogg',
    'mp4',
    'avi',
    'mov',
    'pdf',
    'wasm',
  ])
  const ext = meta.name.includes('.') ? meta.name.split('.').pop()?.toLowerCase() : undefined
  if (ext && binaryExtensions.has(ext)) {
    return false
  }

  // Null bytes are an immediate indicator of binary data
  if (sample.includes(0)) {
    return false
  }

  // Verify valid UTF-8 text encoding
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
    return true
  } catch {
    return false
  }
}

async function handleArtifacts(opts: {
  subcommandOrId?: string | undefined
  targetId?: string | undefined
  pattern?: string | undefined
  offset?: string | undefined
  length?: string | undefined
  ignoreCase?: boolean | undefined
  maxMatches?: string | undefined
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
    } else if (action === 'grep') {
      // id is targetId (runId)
    } else if (action === 'verify') {
      // id is targetId (runId)
    } else if (action === 'export') {
      // id is targetId (runId)
    } else if (action !== undefined && id === undefined) {
      // User invoked `forge artifacts <runId>`
      id = action
      action = 'list'
    } else if (action === undefined) {
      const err = 'No arguments provided.'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else {
        console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        console.error('Usage: forge artifacts [list|cat|grep] <id> [<pattern>]')
      }
      return 1
    }

    if (action === 'list') {
      const rawRunId = id
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts list <runId> [--json]')
        }
        return 1
      }

      const parsedRunId = runIdSchema.safeParse(rawRunId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${rawRunId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const runId = parsedRunId.data

      const artifacts = core.artifacts.listArtifacts(runId)

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
      const rawArtifactId = id
      if (!rawArtifactId) {
        const err = 'No artifact ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts cat <artifactId> [--offset <n>] [--length <n>]')
        }
        return 1
      }

      const parsedArtifactId = artifactIdSchema.safeParse(rawArtifactId)
      if (!parsedArtifactId.success) {
        const err = `Invalid artifact ID "${rawArtifactId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const artifactId = parsedArtifactId.data

      const meta = core.artifacts.getMetadata(artifactId)
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

        const window = await core.artifacts.readWindow(artifactId, offset, length)
        const isText = isTextArtifact(meta, window.data)

        if (opts.json) {
          console.log(
            JSON.stringify({
              artifactId,
              offset,
              length,
              totalBytes: window.totalBytes,
              encoding: isText ? 'utf-8' : 'base64',
              data: isText ? window.data.toString('utf-8') : window.data.toString('base64'),
              ...(isText ? {} : { mimeType: meta.mimeType }),
            }),
          )
        } else if (isText) {
          process.stdout.write(window.data.toString('utf-8'))
        } else if (process.stdout.isTTY) {
          console.error(
            `${ANSI.yellow}Warning: Binary artifact detected (${meta.mimeType}, window: ${String(window.data.length)} bytes). Output suppressed in TTY.${ANSI.reset}`,
          )
          console.error(
            `${ANSI.dim}Hint: Pipe to a file or command to stream raw bytes: forge artifacts cat ${artifactId} --offset ${String(offset)} --length ${String(length)} > chunk.bin${ANSI.reset}`,
          )
        } else {
          process.stdout.write(window.data)
        }
      } else {
        const buf = await core.artifacts.readArtifact(artifactId)
        const isText = isTextArtifact(meta, buf)

        if (opts.json) {
          console.log(
            JSON.stringify({
              artifactId,
              sizeBytes: meta.sizeBytes,
              encoding: isText ? 'utf-8' : 'base64',
              data: isText ? buf.toString('utf-8') : buf.toString('base64'),
              ...(isText ? {} : { mimeType: meta.mimeType }),
            }),
          )
        } else if (isText) {
          process.stdout.write(buf.toString('utf-8'))
        } else if (process.stdout.isTTY) {
          console.error(
            `${ANSI.yellow}Warning: Binary artifact detected (${meta.mimeType}, ${String(buf.length)} bytes). Output suppressed in TTY.${ANSI.reset}`,
          )
          console.error(
            `${ANSI.dim}Hint: Pipe to a file or command to stream raw bytes: forge artifacts cat ${artifactId} > file.bin${ANSI.reset}`,
          )
        } else {
          process.stdout.write(buf)
        }
      }
      return 0
    }

    if (action === 'grep') {
      const rawRunId = id
      const pattern = opts.pattern
      if (!rawRunId || !pattern) {
        const err =
          'Usage: forge artifacts grep <runId> <pattern> [-i] [--max-matches <n>] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: Missing runId or pattern.${ANSI.reset}`)
          console.error(err)
        }
        return 1
      }

      const parsedRunId = runIdSchema.safeParse(rawRunId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${rawRunId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const runId = parsedRunId.data

      let regex: RegExp
      try {
        regex = new RegExp(pattern, opts.ignoreCase ? 'i' : undefined)
      } catch (e) {
        const err = `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const maxMatches = opts.maxMatches ? parseInt(opts.maxMatches, 10) : 50
      if (isNaN(maxMatches) || maxMatches <= 0) {
        const err = `Invalid --max-matches value: ${opts.maxMatches ?? ''}`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const artifacts = core.artifacts.listArtifacts(runId)
      interface GrepMatch {
        readonly artifactId: string
        readonly artifactName: string
        readonly kind: string
        readonly line: number
        readonly content: string
      }
      const matches: GrepMatch[] = []

      for (const art of artifacts) {
        if (matches.length >= maxMatches) break
        try {
          const buf = await core.artifacts.readArtifact(art.id)
          const text = buf.toString('utf-8')
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxMatches) break
            const lineContent = lines[i]
            if (lineContent !== undefined && regex.test(lineContent)) {
              matches.push({
                artifactId: art.id,
                artifactName: art.name,
                kind: art.kind,
                line: i + 1,
                content: lineContent.trimEnd(),
              })
            }
          }
        } catch {
          // Skip unreadable or corrupted artifacts
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ runId, pattern, matchCount: matches.length, matches }))
        return 0
      }

      console.log(
        `\n${ANSI.bold}Grep results for run ${ANSI.cyan}${runId}${ANSI.reset} (pattern: "${pattern}"):`,
      )
      if (matches.length === 0) {
        console.log(`  ${ANSI.dim}No matches found.${ANSI.reset}\n`)
        return 0
      }

      for (const m of matches) {
        console.log(
          `  ${ANSI.cyan}${m.artifactName}${ANSI.reset}:${ANSI.yellow}${String(m.line)}${ANSI.reset} - ${m.content}`,
        )
      }
      if (matches.length >= maxMatches) {
        console.log(
          `\n  ${ANSI.dim}(Truncated at max matches limit: ${String(maxMatches)})${ANSI.reset}`,
        )
      }
      console.log('')
      return 0
    }

    if (action === 'verify') {
      const rawRunId = id
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts verify <runId> [--json]')
        }
        return 1
      }

      const report = await auditArtifactChecksums(core.artifacts, core.artifactStore, rawRunId)

      if (opts.json) {
        console.log(JSON.stringify(report))
        return report.valid ? 0 : 1
      }

      console.log(
        `\n${ANSI.bold}Artifact Cryptographic Checksum Audit for Run ${rawRunId}${ANSI.reset}:`,
      )
      console.log(
        `  Total: ${String(report.totalArtifacts)} | Verified: ${ANSI.green}${String(report.verifiedCount)}${ANSI.reset} | Tampered: ${report.tamperedCount > 0 ? ANSI.red : ANSI.dim}${String(report.tamperedCount)}${ANSI.reset} | Missing: ${report.missingCount > 0 ? ANSI.red : ANSI.dim}${String(report.missingCount)}${ANSI.reset}\n`,
      )

      for (const item of report.results) {
        const statusBadge = item.valid
          ? `${ANSI.green}✓ VALID${ANSI.reset}`
          : `${ANSI.red}✗ ${item.error?.toUpperCase() ?? 'INVALID'}${ANSI.reset}`
        console.log(`  ${statusBadge} ${ANSI.bold}${item.name}${ANSI.reset} (${item.kind})`)
        console.log(
          `    ID: ${item.artifactId} | Size: ${String(item.actualSize ?? item.recordedSize)} bytes`,
        )
        console.log(`    Hash: ${item.recordedHash}`)
        if (item.computedHash && item.computedHash !== item.recordedHash) {
          console.log(`    ${ANSI.red}Computed Hash: ${item.computedHash}${ANSI.reset}`)
        }
      }

      const overall = report.valid
        ? `\n${ANSI.green}✓ All artifacts verified authentic and intact.${ANSI.reset}\n`
        : `\n${ANSI.red}✗ Verification failed: discrepancies detected.${ANSI.reset}\n`
      console.log(overall)
      return report.valid ? 0 : 1
    }

    if (action === 'export') {
      const rawRunId = id
      if (!rawRunId) {
        const err = 'No run ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge artifacts export <runId> [outputPath] [--json]')
        }
        return 1
      }

      const res = await exportRunArtifactArchive(
        core.artifacts,
        core.artifactStore,
        core.runs,
        rawRunId,
        opts.pattern,
      )

      if (!res.valid) {
        if (opts.json) console.log(JSON.stringify(res))
        else console.error(`${ANSI.red}Error: ${res.error ?? 'Export failed'}${ANSI.reset}`)
        return 1
      }

      if (opts.json) {
        console.log(JSON.stringify(res))
      } else {
        console.log(`${ANSI.green}Artifact bundle exported successfully:${ANSI.reset}`)
        console.log(`  Path: ${res.outputPath}`)
        console.log(`  Artifacts: ${String(res.totalArtifacts)}`)
        console.log(`  Events: ${String(res.totalEvents)}`)
        console.log(`  Manifest SHA-256: ${res.manifestSha256}`)
      }
      return 0
    }

    const err = `Unknown artifacts action: ${action}`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else {
      console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      console.error(
        'Usage: forge artifacts [list] <runId> | forge artifacts cat <artifactId> | forge artifacts grep <runId> <pattern> | forge artifacts verify <runId>',
      )
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

async function handleWorkflows(opts: {
  action: string | undefined
  targetId: string | undefined
  extraParam?: string | undefined
  thirdParam?: string | undefined
  limit: string | undefined
  all: boolean
  cwd: string
  dataDir: string
  json: boolean
  reason?: string | undefined
  project?: string | undefined
  template?: string | undefined
  objective?: string | undefined
  task?: string | undefined
  run?: boolean | undefined
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })

  try {
    const KNOWN_ACTIONS = [
      'list',
      'inspect',
      'run',
      'resume',
      'cancel',
      'approve',
      'init',
      'validate',
      'plan',
      'profile',
      'templates',
      'template',
      'parallel',
      'snapshot',
      'dlq',
      'timeout',
    ] as const
    let action = opts.action ?? 'list'
    let targetId = opts.targetId

    if (!KNOWN_ACTIONS.includes(action as (typeof KNOWN_ACTIONS)[number])) {
      targetId = action
      action = 'inspect'
    }

    if (action === 'timeout') {
      const supervisor = new StepTimeoutSupervisor()
      const activeLeases = supervisor.getActiveLeases()
      const history = supervisor.getAuditHistory()
      if (opts.json) {
        console.log(
          JSON.stringify({
            supervisorStatus: 'active',
            activeLeases,
            history,
          }),
        )
        return 0
      }
      printBanner()
      console.log(`\n${ANSI.bold}WORKFLOW STEP TIMEOUT SUPERVISOR${ANSI.reset}`)
      console.log(`  Active leases: ${String(activeLeases.length)}`)
      console.log(`  Audit history: ${String(history.length)}`)
      return 0
    }

    if (action === 'dlq') {
      const subaction = targetId ?? 'list'
      if (subaction === 'list') {
        const report = await listDeadLetterQueue(opts.dataDir)
        if (opts.json) {
          console.log(JSON.stringify(report))
        } else {
          printBanner()
          console.log(`\n${report.formattedSummary}\n`)
        }
        return report.valid ? 0 : 1
      }
      if (subaction === 'purge') {
        const report = await purgeDeadLetterQueue(opts.dataDir)
        if (opts.json) {
          console.log(JSON.stringify(report))
        } else {
          console.log(`\n${report.formattedSummary}\n`)
        }
        return 0
      }
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

      let workflows: readonly (WorkflowSummaryView | WorkflowDetailView)[] = []
      if (opts.all) {
        const allProjects = core.projects.list()
        const accumulated: WorkflowSummaryView[] = []
        for (const proj of allProjects) {
          accumulated.push(...core.workflows.list(proj.id))
        }
        workflows = accumulated
      } else {
        const projects = core.projects.list()
        const normCwd = resolve(opts.cwd).toLowerCase()
        const match = projects.find(
          (p) => resolve(p.repository.absolutePath).toLowerCase() === normCwd,
        )
        if (!match) {
          if (opts.json) {
            console.log(JSON.stringify({ workflows: [] }))
            return 0
          }
          console.log(
            `\n${ANSI.yellow}Current directory is not a registered Forge project.${ANSI.reset}`,
          )
          console.log(
            `Use ${ANSI.bold}forge workflows --all${ANSI.reset} to view workflows across all projects.\n`,
          )
          return 0
        }
        workflows = core.workflows.list(match.id)
      }

      if (limit !== undefined) {
        workflows = workflows.slice(0, limit)
      }

      if (opts.json) {
        console.log(JSON.stringify({ workflows }))
        return 0
      }

      if (workflows.length === 0) {
        console.log(`\n${ANSI.dim}No workflows found.${ANSI.reset}\n`)
        return 0
      }

      console.log(`\n${ANSI.bold}Workflows (${String(workflows.length)})${ANSI.reset}:`)
      for (const wf of workflows) {
        const stateColor =
          wf.state === 'COMPLETED'
            ? ANSI.green
            : wf.state === 'FAILED' || wf.state === 'HALTED'
              ? ANSI.red
              : ANSI.yellow
        const stepsStr = 'stepCount' in wf ? String(wf.stepCount) : String(wf.steps.length)
        console.log(
          `  ${ANSI.bold}${wf.id}${ANSI.reset}  ${stateColor}${wf.state}${ANSI.reset}  template:${wf.templateId}  steps:${stepsStr}`,
        )
        console.log(`    Task: ${wf.taskId}`)
        console.log(`    Started: ${ANSI.dim}${wf.startedAt}${ANSI.reset}`)
      }
      console.log('')
      return 0
    }

    if (action === 'inspect') {
      const rawId = targetId
      if (!rawId) {
        const err = 'No workflow ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge workflows inspect <workflowId> [--json]')
        }
        return 1
      }

      const parsedId = workflowIdSchema.safeParse(rawId)
      if (!parsedId.success) {
        const err = `Invalid workflow ID "${rawId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const wf = core.workflows.get(parsedId.data)
      if (!wf) {
        const err = `Workflow "${rawId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      if (opts.json) {
        console.log(JSON.stringify(wf, null, 2))
        return 0
      }

      console.log(`\n${ANSI.bold}Workflow ${wf.id}${ANSI.reset}`)
      console.log(`  State:      ${wf.state}`)
      console.log(`  Task:       ${wf.taskId}`)
      console.log(`  Template:   ${wf.templateId}`)
      console.log(`  Iteration:  ${String(wf.iteration)}`)
      console.log(`  Started:    ${wf.startedAt}`)
      if (wf.finishedAt) console.log(`  Finished:   ${wf.finishedAt}`)
      if (wf.haltReason) console.log(`  Halt Reason: ${wf.haltReason}`)

      console.log(`\n  ${ANSI.bold}Steps (${String(wf.steps.length)}):${ANSI.reset}`)
      for (const st of wf.steps) {
        console.log(
          `    [${String(st.index)}] ${st.role} -> ${st.state} (runtime: ${st.runtimeId ?? 'system'})`,
        )
      }
      console.log('')
      return 0
    }

    if (action === 'run' || action === 'resume') {
      const rawId = targetId
      if (!rawId) {
        const err = 'No workflow ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else {
          console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          console.error('Usage: forge workflows run <workflowId> [--json]')
        }
        return 1
      }

      const parsedId = workflowIdSchema.safeParse(rawId)
      if (!parsedId.success) {
        const err = `Invalid workflow ID "${rawId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const wf = core.workflows.get(parsedId.data)
      if (!wf) {
        const err = `Workflow "${rawId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      if (wf.state === 'CANCELLED' || wf.state === 'COMPLETED' || wf.state === 'FAILED') {
        const err = `Cannot run or resume workflow in terminal state "${wf.state}".`
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err, state: wf.state }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      let updatedWf: WorkflowDetailView | null = null
      if (wf.state === 'WAITING_FOR_APPROVAL') {
        updatedWf = core.workflows.approveAndStartImplementation(parsedId.data)
      } else {
        updatedWf = core.workflows.resume(parsedId.data)
      }

      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: true,
            action,
            workflowId: parsedId.data,
            state: updatedWf?.state ?? wf.state,
          }),
        )
      } else {
        console.log(
          `${ANSI.green}✓ Triggered execution for workflow ${ANSI.bold}${parsedId.data}${ANSI.reset} (state: ${updatedWf?.state ?? wf.state})`,
        )
      }
      return 0
    }

    if (action === 'cancel') {
      const rawId = targetId
      if (!rawId) {
        const err = 'No workflow ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const parsedId = workflowIdSchema.safeParse(rawId)
      if (!parsedId.success) {
        const err = `Invalid workflow ID "${rawId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const reason = opts.reason ?? 'Cancelled by user via CLI'
      const updatedWf = core.workflows.cancel(parsedId.data, reason)
      if (!updatedWf) {
        const err = `Workflow "${rawId}" not found.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: true,
            cancelled: true,
            workflowId: parsedId.data,
            reason,
            state: updatedWf.state,
          }),
        )
      } else {
        console.log(
          `${ANSI.green}✓ Cancelled workflow ${ANSI.bold}${parsedId.data}${ANSI.reset} (${reason})`,
        )
      }
      return 0
    }

    if (action === 'approve') {
      const rawId = targetId
      if (!rawId) {
        const err = 'No workflow ID provided.'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const parsedId = workflowIdSchema.safeParse(rawId)
      if (!parsedId.success) {
        const err = `Invalid workflow ID "${rawId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      try {
        const updatedWf = core.workflows.approveAndStartImplementation(parsedId.data)
        if (opts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              approved: true,
              workflowId: parsedId.data,
              state: updatedWf.state,
            }),
          )
        } else {
          console.log(
            `${ANSI.green}✓ Approved plan and started implementation for workflow ${ANSI.bold}${parsedId.data}${ANSI.reset}`,
          )
        }
        return 0
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
        return 1
      }
    }

    if (action === 'init') {
      const targetPath = resolve(opts.project ?? opts.cwd)
      const projects = core.projects.list()
      let project = projects.find(
        (p) =>
          p.id === opts.project ||
          resolve(p.repository.absolutePath).toLowerCase() === targetPath.toLowerCase() ||
          p.name.toLowerCase() === (opts.project ?? '').toLowerCase(),
      )

      if (!project) {
        try {
          const git = new GitService({ repositoryPath: targetPath })
          const currentBranch = await git.currentBranch()
          project = await core.projects.create({
            name: basename(targetPath),
            repositoryPath: targetPath,
            defaultBranch: currentBranch ?? 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
            rules: [],
          })
        } catch (e) {
          const err = `Could not resolve or register project at "${targetPath}": ${e instanceof Error ? e.message : String(e)}`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
      }

      const templateId = opts.template ?? 'feature'
      const objective = opts.objective ?? `Headless workflow on ${project.name}`
      const autoRun = opts.run === true

      try {
        const wf = await core.workflows.start({
          projectId: project.id,
          taskId: opts.task,
          templateId,
          objective,
          autoRun,
        })

        if (opts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              workflowId: wf.id,
              projectId: project.id,
              templateId: wf.templateId,
              state: wf.state,
              objective,
              autoRun,
              workflow: wf,
            }),
          )
        } else {
          console.log(
            `\n${ANSI.green}✓${ANSI.reset} Initialized workflow ${ANSI.bold}${wf.id}${ANSI.reset}`,
          )
          console.log(`  Project:   ${project.name} (${project.id})`)
          console.log(`  Template:  ${wf.templateId}`)
          console.log(`  State:     ${wf.state}`)
          console.log(`  Objective: ${objective}`)
          console.log(`  Execution: ${autoRun ? 'Started in background' : 'Ready'}\n`)
        }
        return 0
      } catch (e) {
        const err = `Failed to initialize workflow: ${e instanceof Error ? e.message : String(e)}`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
    }

    if (action === 'validate') {
      const allKnownTemplates: WorkflowTemplateV2[] = [
        ...DEFAULT_TEMPLATES_V2,
        compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION),
        compileLinearTemplateToGraph(BUG_FIX),
      ]
      const templatesToValidate: WorkflowTemplateV2[] = []

      // If targetId is a file path that exists, load it
      if (targetId && existsSync(targetId)) {
        try {
          const raw: unknown = JSON.parse(readFileSync(targetId, 'utf8'))
          templatesToValidate.push(raw as WorkflowTemplateV2)
        } catch (err) {
          const msg = `Failed to parse template JSON at "${targetId}": ${err instanceof Error ? err.message : String(err)}`
          if (opts.json) console.log(JSON.stringify({ error: msg }))
          else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
          return 1
        }
      } else if (targetId && targetId !== 'all') {
        const normTarget = targetId.toLowerCase().replace(/[-_]/g, '')
        const found = allKnownTemplates.find((t) => {
          const normId = t.id.toLowerCase().replace(/[-_]/g, '')
          const normName = t.name.toLowerCase().replace(/[-_]/g, '')
          return (
            t.id.toLowerCase() === targetId.toLowerCase() ||
            t.name.toLowerCase() === targetId.toLowerCase() ||
            normId === normTarget ||
            normName === normTarget ||
            (normTarget.includes('feature') && normId.includes('feature')) ||
            (normTarget.includes('bug') && normId.includes('bug'))
          )
        })
        if (!found) {
          const msg = `Template "${targetId}" not found in default catalog or local path`
          if (opts.json) console.log(JSON.stringify({ error: msg }))
          else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
          return 1
        }
        templatesToValidate.push(found)
      } else {
        // Validate all default and compiled templates
        templatesToValidate.push(...allKnownTemplates)
      }

      const results = templatesToValidate.map((tmpl) => ({
        templateId: tmpl.id,
        name: tmpl.name,
        result: validateTemplateGraph(tmpl),
      }))

      if (opts.json) {
        console.log(JSON.stringify({ validations: results }))
        return results.every((r) => r.result.valid) ? 0 : 1
      }

      console.log(
        `\n${ANSI.bold}Workflow Graph Validation (${String(results.length)} template${results.length === 1 ? '' : 's'})${ANSI.reset}:`,
      )
      let hasError = false
      for (const item of results) {
        const statusBadge = item.result.valid
          ? `${ANSI.green}✓ VALID${ANSI.reset}`
          : `${ANSI.red}✗ INVALID${ANSI.reset}`
        console.log(`\n  ${statusBadge} ${ANSI.bold}${item.name}${ANSI.reset} (${item.templateId})`)
        console.log(
          `    Nodes: ${String(item.result.metrics.nodeCount)} | Edges: ${String(item.result.metrics.edgeCount)} | Feedback Loops: ${String(item.result.metrics.feedbackLoopCount)} | Sinks: ${String(item.result.metrics.terminalCount)}`,
        )
        if (item.result.topologicalOrder) {
          console.log(`    Topology: ${item.result.topologicalOrder.join(' → ')}`)
        }
        for (const warn of item.result.warnings) {
          console.log(`    ${ANSI.yellow}⚠ Warning: ${warn}${ANSI.reset}`)
        }
        for (const err of item.result.errors) {
          hasError = true
          console.log(`    ${ANSI.red}✖ Error: ${err}${ANSI.reset}`)
        }
      }
      console.log('')
      return hasError ? 1 : 0
    }

    if (action === 'plan') {
      const allKnownTemplates: WorkflowTemplateV2[] = [
        ...DEFAULT_TEMPLATES_V2,
        compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION),
        compileLinearTemplateToGraph(BUG_FIX),
      ]

      let targetTemplate: WorkflowTemplateV2 | undefined

      if (targetId && (targetId.endsWith('.json') || existsSync(resolve(opts.cwd, targetId)))) {
        const filePath = resolve(opts.cwd, targetId)
        try {
          const raw = readFileSync(filePath, 'utf-8')
          targetTemplate = JSON.parse(raw) as WorkflowTemplateV2
        } catch (err) {
          const msg = `Failed to parse template JSON at "${targetId}": ${err instanceof Error ? err.message : String(err)}`
          if (opts.json) console.log(JSON.stringify({ error: msg }))
          else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
          return 1
        }
      } else {
        const query = targetId ?? opts.template ?? 'feature'
        const normTarget = query.toLowerCase().replace(/[-_]/g, '')
        targetTemplate = allKnownTemplates.find((t) => {
          const normId = t.id.toLowerCase().replace(/[-_]/g, '')
          const normName = t.name.toLowerCase().replace(/[-_]/g, '')
          return (
            t.id.toLowerCase() === query.toLowerCase() ||
            t.name.toLowerCase() === query.toLowerCase() ||
            normId === normTarget ||
            normName === normTarget ||
            (normTarget.includes('feature') && normId.includes('feature')) ||
            (normTarget.includes('bug') && normId.includes('bug'))
          )
        })
      }

      if (!targetTemplate) {
        const msg = `Template "${targetId ?? opts.template ?? 'feature'}" not found in catalog or path`
        if (opts.json) console.log(JSON.stringify({ error: msg }))
        else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
        return 1
      }

      const plan = planWorkflowExecution(targetTemplate)

      if (opts.json) {
        console.log(JSON.stringify(plan))
        return plan.valid ? 0 : 1
      }

      console.log(`\n${plan.asciiDiagram}\n`)
      if (!plan.valid && plan.errors) {
        for (const err of plan.errors) {
          console.error(`  ${ANSI.red}✖ ${err}${ANSI.reset}`)
        }
        return 1
      }
      return 0
    }

    if (action === 'parallel') {
      const allKnownTemplates: WorkflowTemplateV2[] = [
        ...DEFAULT_TEMPLATES_V2,
        compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION),
        compileLinearTemplateToGraph(BUG_FIX),
      ]

      let targetTemplate: WorkflowTemplateV2 | undefined

      if (targetId && (targetId.endsWith('.json') || existsSync(resolve(opts.cwd, targetId)))) {
        const filePath = resolve(opts.cwd, targetId)
        try {
          const raw = readFileSync(filePath, 'utf-8')
          targetTemplate = JSON.parse(raw) as WorkflowTemplateV2
        } catch (err) {
          const msg = `Failed to parse template JSON at "${targetId}": ${err instanceof Error ? err.message : String(err)}`
          if (opts.json) console.log(JSON.stringify({ error: msg }))
          else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
          return 1
        }
      } else {
        const query = targetId ?? opts.template ?? 'feature'
        const normTarget = query.toLowerCase().replace(/[-_]/g, '')
        targetTemplate = allKnownTemplates.find((t) => {
          const normId = t.id.toLowerCase().replace(/[-_]/g, '')
          const normName = t.name.toLowerCase().replace(/[-_]/g, '')
          return (
            t.id.toLowerCase() === query.toLowerCase() ||
            t.name.toLowerCase() === query.toLowerCase() ||
            normId === normTarget ||
            normName === normTarget ||
            (normTarget.includes('feature') && normId.includes('feature')) ||
            (normTarget.includes('bug') && normId.includes('bug'))
          )
        })
      }

      if (!targetTemplate) {
        const msg = `Template "${targetId ?? opts.template ?? 'feature'}" not found in catalog or path`
        if (opts.json) console.log(JSON.stringify({ error: msg }))
        else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
        return 1
      }

      const parallelPlan = planParallelBatches(targetTemplate)

      if (opts.json) {
        console.log(JSON.stringify(parallelPlan))
        return parallelPlan.valid ? 0 : 1
      }

      console.log(`\n${parallelPlan.formattedSummary}\n`)
      return parallelPlan.valid ? 0 : 1
    }

    if (action === 'profile') {
      if (!targetId) {
        const msg = 'Run ID required: forge workflows profile <runId>'
        if (opts.json) console.log(JSON.stringify({ error: msg }))
        else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
        return 1
      }

      const report = profileWorkflowExecution(core.runs, targetId)
      if (!report.valid) {
        if (opts.json) console.log(JSON.stringify(report))
        else console.error(`${ANSI.red}Error: ${report.error ?? 'Profiling failed'}${ANSI.reset}`)
        return 1
      }

      if (opts.json) {
        console.log(JSON.stringify(report))
      } else {
        console.log(`\n${report.formattedSummary}\n`)
      }
      return 0
    }

    if (action === 'templates' || action === 'template') {
      const sub = targetId ?? 'list'
      if (sub === 'validate') {
        const filePath = opts.extraParam
        if (!filePath) {
          const err = 'Usage: forge workflows templates validate <filePath> [--json]'
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        const result = await validateCustomTemplateFile(filePath)
        if (opts.json) {
          console.log(JSON.stringify(result))
          return result.valid ? 0 : 1
        }
        if (result.valid) {
          console.log(`\n${ANSI.green}✓ Valid workflow template:${ANSI.reset} ${filePath}`)
          if (result.warnings.length > 0) {
            for (const w of result.warnings) {
              console.log(`  ${ANSI.yellow}⚠ Warning: ${w}${ANSI.reset}`)
            }
          }
          console.log('')
          return 0
        } else {
          console.error(`\n${ANSI.red}✗ Invalid workflow template:${ANSI.reset} ${filePath}`)
          for (const e of result.errors) {
            console.error(`  ${ANSI.red}✖ Error: ${e}${ANSI.reset}`)
          }
          console.log('')
          return 1
        }
      }

      const searchDirs = [
        resolve(opts.cwd, '.forge', 'templates'),
        resolve(opts.cwd, '.forge', 'workflows'),
        resolve(opts.dataDir, 'templates'),
      ]
      const discovery = await discoverCustomTemplates(searchDirs)
      if (opts.json) {
        console.log(JSON.stringify(discovery))
        return 0
      }
      printBanner()
      console.log(
        `\n${ANSI.bold}CUSTOM WORKFLOW TEMPLATES (${String(discovery.templates.length)})${ANSI.reset}:`,
      )
      if (discovery.templates.length === 0) {
        console.log(`  ${ANSI.dim}(No custom templates found in scanned directories)${ANSI.reset}`)
      } else {
        for (const t of discovery.templates) {
          console.log(`  • ${ANSI.bold}${t.id}${ANSI.reset} (${t.name}) - ${t.description}`)
        }
      }
      if (discovery.errors.length > 0) {
        console.log(
          `\n${ANSI.yellow}Template Discovery Warnings/Errors (${String(discovery.errors.length)}):${ANSI.reset}`,
        )
        for (const err of discovery.errors) {
          console.log(`  ${ANSI.red}✖ ${err.path}: ${err.error}${ANSI.reset}`)
        }
      }
      console.log('')
      return 0
    }

    if (action === 'snapshot') {
      const sub = targetId ?? 'list'

      if (sub === 'restore') {
        const targetRunId = opts.extraParam
        const snapshotId = opts.thirdParam
        if (!targetRunId || !snapshotId) {
          const err = 'Usage: forge workflows snapshot restore <runId> <snapshotId> [--json]'
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        const parsedRunId = runIdSchema.safeParse(targetRunId)
        if (!parsedRunId.success) {
          const err = `Invalid run ID "${targetRunId}". Expected a valid UUID.`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        const restoreRes = await restoreWorkflowSnapshot(core.dataDir, parsedRunId.data, snapshotId)
        if (opts.json) {
          console.log(JSON.stringify(restoreRes))
          return restoreRes.valid ? 0 : 1
        }
        console.log(`\n${restoreRes.formattedSummary}\n`)
        return restoreRes.valid ? 0 : 1
      }

      if (sub === 'create') {
        const targetRunId = opts.extraParam
        if (!targetRunId) {
          const err = 'Usage: forge workflows snapshot create <runId> [--json]'
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        const parsedRunId = runIdSchema.safeParse(targetRunId)
        if (!parsedRunId.success) {
          const err = `Invalid run ID "${targetRunId}". Expected a valid UUID.`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        const created = await createWorkflowSnapshot(core.dataDir, {
          runId: parsedRunId.data,
          nodeId: 'manual-checkpoint',
          iteration: 1,
          status: 'checkpointed',
          nodeOutputs: {},
          traversedEdges: [],
        })
        if (opts.json) {
          console.log(JSON.stringify({ valid: true, snapshot: created }))
          return 0
        }
        console.log(`\n${ANSI.green}✓ Snapshot created: ${created.snapshotId}${ANSI.reset}\n`)
        return 0
      }

      // Default: list snapshots for runId
      const targetRunId = sub === 'list' ? opts.extraParam : sub
      if (!targetRunId) {
        const err =
          'Usage: forge workflows snapshot [list|create|restore] <runId> [snapshotId] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const parsedRunId = runIdSchema.safeParse(targetRunId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${targetRunId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const listRes = await listWorkflowSnapshots(core.dataDir, parsedRunId.data)
      if (opts.json) {
        console.log(JSON.stringify(listRes))
        return 0
      }
      console.log(`\n${listRes.formattedSummary}\n`)
      return 0
    }

    console.error(`${ANSI.red}Unknown workflows action: "${action}"${ANSI.reset}`)
    console.error(
      'Usage: forge workflows [list|inspect|run|resume|cancel|approve|init|validate|plan|profile|templates|parallel|snapshot] [<id>] [--json]',
    )
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

async function handleRuntimes(opts: {
  action?: string | undefined
  targetId?: string | undefined
  dataDir: string
  json: boolean
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    if (opts.action === 'env' || opts.action === 'sandbox') {
      const report = sanitizeRuntimeEnvironment({
        context: {
          dataDir: opts.dataDir,
          runtimeId: opts.targetId,
        },
      })
      if (opts.json) {
        console.log(JSON.stringify(report))
        return 0
      }
      console.log(`\n${report.formattedSummary}\n`)
      return 0
    }

    if (opts.action === 'quota' || opts.action === 'limits') {
      const budget = createResourceBudget()
      const report = auditRuntimeQuotas(budget)
      if (opts.json) {
        console.log(JSON.stringify(report))
        return 0
      }
      console.log(`\n${report.formattedSummary}\n`)
      return 0
    }

    if (opts.action === 'rate-limit' || opts.action === 'limit') {
      const limiter = new ToolRateLimiter()
      const metrics = limiter.getMetrics()
      if (opts.json) {
        console.log(JSON.stringify(metrics))
        return 0
      }
      printBanner()
      console.log(`\n${ANSI.bold}TOOL RATE LIMITER & THROTTLER METRICS${ANSI.reset}`)
      console.log(`  Capacity:           ${String(metrics.capacity)} tokens`)
      console.log(`  Refill Rate:        ${String(metrics.refillRatePerSec)} tokens/sec`)
      console.log(`  Max Concurrency:    ${String(metrics.maxConcurrency)} active slots`)
      console.log(`  Current Tokens:     ${String(metrics.currentTokens)}`)
      console.log(`  Active In-Flight:   ${String(metrics.activeConcurrency)}`)
      console.log(`  Total Acquired:     ${String(metrics.totalAcquired)}`)
      console.log(`  Total Throttled:    ${String(metrics.totalThrottled)}`)
      return 0
    }

    if (opts.action === 'test') {
      const runtimeId = opts.targetId
      if (!runtimeId) {
        const err = 'Usage: forge runtimes test <runtimeId>'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const runtimesList = core.runtimes.list()
      const found = runtimesList.find((r) => r.id === runtimeId)
      if (!found) {
        const err = `Runtime "${runtimeId}" not found in registered runtimes`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }

      const named = runtimeExecutable(found.id)
      const executable = found.simulated || named === found.id ? null : named
      const result = await testRuntimeExecution(found.id, executable, {
        isSimulated: found.simulated,
      })

      if (opts.json) {
        console.log(JSON.stringify(result))
        return result.success ? 0 : 1
      }

      console.log(`\n${ANSI.bold}Runtime Execution Test${ANSI.reset}:`)
      console.log(`  Runtime:    ${result.runtimeId}`)
      console.log(`  Executable: ${result.executable ?? '[in-process]'}`)
      console.log(`  Duration:   ${String(result.durationMs)}ms`)
      console.log(
        `  Status:     ${result.success ? `${ANSI.green}SUCCESS${ANSI.reset}` : `${ANSI.red}FAILED${ANSI.reset}`}`,
      )
      if (result.output) console.log(`  Output:     ${result.output}`)
      if (result.error) console.log(`  Error:      ${ANSI.red}${result.error}${ANSI.reset}`)
      console.log('')
      return result.success ? 0 : 1
    }

    const runtimesList = core.runtimes.list()
    const probed = await Promise.all(
      runtimesList.map(async (r) => {
        const named = runtimeExecutable(r.id)
        const executable = r.simulated || named === r.id ? null : named
        const probe = await probeRuntimeExecutable(executable, { isSimulated: r.simulated })
        return {
          id: r.id,
          simulated: r.simulated,
          executable,
          available: probe.available,
          version: probe.version,
          health: probe.health,
          latencyMs: probe.latencyMs,
          capabilities: [...r.capabilities],
          label: runtimeDescription(r.id),
        }
      }),
    )

    if (opts.json) {
      console.log(JSON.stringify({ runtimes: probed }))
      return 0
    }

    console.log(`\n${ANSI.bold}REGISTERED RUNTIMES (${String(probed.length)})${ANSI.reset}:`)
    for (const p of probed) {
      const statusBadge =
        p.health === 'healthy'
          ? `${ANSI.green}HEALTHY${ANSI.reset}`
          : p.health === 'degraded'
            ? `${ANSI.yellow}DEGRADED${ANSI.reset}`
            : p.health === 'simulated'
              ? `${ANSI.cyan}SIMULATED${ANSI.reset}`
              : `${ANSI.red}UNAVAILABLE${ANSI.reset}`

      const name = p.label?.name ?? p.id
      const ver = p.version ? ` (v${p.version})` : ''
      const exec = p.executable ? ` [exec: ${p.executable}]` : ' [in-process]'
      console.log(`  • ${ANSI.bold}${name}${ANSI.reset}${ver} - ${statusBadge}${exec}`)
      if (p.label?.summary) {
        console.log(`    ${ANSI.dim}${p.label.summary}${ANSI.reset}`)
      }
      console.log(`    Capabilities: ${p.capabilities.join(', ')}`)
    }
    console.log('')
    return 0
  } finally {
    await core.close()
  }
}

async function handleContext(opts: {
  action: string | undefined
  runId: string | undefined
  stepId: string | undefined
  dataDir: string
  json: boolean
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })

  try {
    let action = opts.action ?? 'inspect'
    let runId = opts.runId
    const stepId = opts.stepId

    if (action !== 'inspect' && action !== 'optimize') {
      runId = action
      action = 'inspect'
    }

    if (!runId) {
      const err = 'Usage: forge context [inspect|optimize] <runId> [stepId]'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }

    const parsedRunId = runIdSchema.safeParse(runId)
    if (!parsedRunId.success) {
      const err = `Invalid run ID "${runId}". Expected a valid UUID.`
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }

    const allArtifacts = core.artifactStore.listForRun(parsedRunId.data)
    const promptPackets = allArtifacts.filter((a) => a.kind === 'prompt-packet')

    if (promptPackets.length === 0) {
      const err = `No prompt-packet artifacts found for run "${runId}"`
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }

    const targetPacket = stepId
      ? promptPackets.find((a) => a.stepId === stepId)
      : promptPackets[promptPackets.length - 1]

    if (!targetPacket) {
      const err = `No prompt-packet artifact found for run "${runId}" and step "${stepId ?? ''}"`
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }

    const content = await core.artifacts.readArtifactText(targetPacket.id)

    if (action === 'optimize') {
      const optimization = optimizePromptPacket(content)
      if (opts.json) {
        console.log(JSON.stringify(optimization))
        return optimization.valid ? 0 : 1
      }
      console.log(`\n${optimization.formattedSummary}\n`)
      return optimization.valid ? 0 : 1
    }

    let parsed: unknown = content
    try {
      parsed = JSON.parse(content)
    } catch {
      // Keep as string
    }

    if (opts.json) {
      console.log(
        JSON.stringify({
          runId,
          stepId: targetPacket.stepId,
          artifactId: targetPacket.id,
          createdAt: targetPacket.createdAt,
          packet: parsed,
        }),
      )
      return 0
    }

    console.log(`\n${ANSI.bold}Prompt Context Packet${ANSI.reset}:`)
    console.log(`  Run ID:      ${runId}`)
    console.log(`  Step ID:     ${targetPacket.stepId ?? 'none'}`)
    console.log(`  Artifact ID: ${targetPacket.id}`)
    console.log(`  Created At:  ${targetPacket.createdAt}`)
    const estTokens = Math.ceil(content.length / 4)
    console.log(`  Size:        ${String(content.length)} bytes (~${String(estTokens)} tokens)`)

    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>
      if (typeof p.objective === 'string') {
        console.log(`\n${ANSI.bold}Objective:${ANSI.reset} ${p.objective}`)
      }
      if (typeof p.systemPrompt === 'string') {
        const sys = p.systemPrompt.slice(0, 200)
        console.log(`\n${ANSI.bold}System Prompt Snippet:${ANSI.reset}\n${sys}...`)
      }
      if (Array.isArray(p.contextFiles)) {
        console.log(`\n${ANSI.bold}Context Files (${String(p.contextFiles.length)}):${ANSI.reset}`)
        for (const file of p.contextFiles.slice(0, 10)) {
          if (typeof file === 'string') {
            console.log(`  - ${file}`)
          }
        }
      }
    }
    console.log('')
    return 0
  } finally {
    await core.close()
  }
}

async function handleConfig(opts: {
  action?: string | undefined
  key?: string | undefined
  val?: string | undefined
  extraParam?: string | undefined
  passphrase?: string | undefined
  force?: boolean | undefined
  profile?: string | undefined
  model?: string | undefined
  provider?: string | undefined
  cwd: string
  dataDir: string
  json: boolean
}): Promise<number> {
  const action = opts.action ?? 'list'
  const configPath = findForgeConfigFile(opts.cwd)

  if (action === 'init') {
    const result = await bootstrapForgeConfig({
      cwd: opts.cwd,
      force: opts.force,
      activeProfile: opts.profile,
      model: opts.model,
      provider: opts.provider,
    })
    if (opts.json) {
      console.log(JSON.stringify(result))
      return result.valid ? 0 : 1
    }
    console.log(`\n${result.formattedSummary}\n`)
    return result.valid ? 0 : 1
  }

  if (action === 'interpolate') {
    const template = opts.key ?? ''
    if (!template) {
      const err = 'Usage: forge config interpolate <string> [--json]'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }
    try {
      const interpolated = interpolateEnvString(template)
      if (opts.json) {
        console.log(JSON.stringify({ template, interpolated, success: true }))
        return 0
      }
      console.log(interpolated)
      return 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (opts.json) {
        console.log(JSON.stringify({ template, error: msg, success: false }))
        return 1
      }
      console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
      return 1
    }
  }

  if (action === 'policy') {
    const loaded = loadForgeConfig({ searchFrom: opts.cwd, profile: opts.profile })
    const samplePolicies: PolicyLockRule[] = [
      {
        key: 'security.allowExecutionOutsideWorkspace',
        lockedValue: false,
        disallowOverride: true,
        description: 'Mandatory workspace sandbox isolation',
      },
    ]
    const audit = auditConfigAgainstPolicies(
      {
        global: loaded,
        workspace: loaded,
        profile: opts.profile && loaded.profiles ? loaded.profiles[opts.profile] : undefined,
      },
      samplePolicies,
    )
    if (opts.json) {
      console.log(JSON.stringify(audit))
      return audit.valid ? 0 : 1
    }
    console.log(`\n${audit.formattedSummary}\n`)
    return audit.valid ? 0 : 1
  }

  if (action === 'vault') {
    const subaction = opts.key ?? 'list'
    const vaultPath = join(opts.cwd, '.forgerc.vault')
    const passphrase = opts.passphrase ?? process.env.FORGE_VAULT_PASSPHRASE ?? 'forge-default-key'

    if (subaction === 'list') {
      const summary = await listVaultSecrets(vaultPath)
      if (opts.json) {
        console.log(JSON.stringify(summary))
        return 0
      }
      console.log(`\n${summary.formattedSummary}\n`)
      return 0
    }

    if (subaction === 'set') {
      const secretName = opts.val
      const secretVal = opts.extraParam
      if (!secretName || !secretVal) {
        const err = 'Usage: forge config vault set <key> <value> [--passphrase <key>] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      await setVaultSecret(vaultPath, secretName, secretVal, passphrase)
      if (opts.json) {
        console.log(JSON.stringify({ stored: true, key: secretName }))
        return 0
      }
      console.log(
        `\n${ANSI.green}✓ Encrypted secret "${secretName}" stored in ${vaultPath}${ANSI.reset}\n`,
      )
      return 0
    }

    if (subaction === 'get') {
      const secretName = opts.val
      if (!secretName) {
        const err = 'Usage: forge config vault get <key> [--passphrase <key>] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      try {
        const val = await getVaultSecret(vaultPath, secretName, passphrase)
        if (val === null) {
          const err = `Secret "${secretName}" not found in vault.`
          if (opts.json) console.log(JSON.stringify({ error: err }))
          else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
          return 1
        }
        if (opts.json) {
          console.log(JSON.stringify({ key: secretName, value: val }))
          return 0
        }
        console.log(`\n${secretName}=${val}\n`)
        return 0
      } catch (e) {
        const err = `Failed to decrypt secret: ${e instanceof Error ? e.message : String(e)}`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
    }

    const err = `Unknown vault action: "${subaction}". Available: list, set, get`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  if (action === 'doctor') {
    const core = createForgeCore({ dataDir: opts.dataDir })
    try {
      const config = loadForgeConfig({ searchFrom: opts.cwd, env: {} })
      const report = await auditForgeEnvironment({
        dataDir: core.dataDir,
        sqlite: core.sqlite,
        config,
        configPath: configPath ?? undefined,
      })

      if (opts.json) {
        console.log(JSON.stringify(report))
      } else {
        console.log(`\n${report.formattedSummary}\n`)
      }
      return report.healthy ? 0 : 1
    } finally {
      await core.close()
    }
  }

  if (action === 'list') {
    const config = loadForgeConfig({ searchFrom: opts.cwd, env: {} })
    if (opts.json) {
      console.log(JSON.stringify({ configPath, config }))
      return 0
    }
    console.log(`\n${ANSI.bold}FORGE CONFIGURATION${ANSI.reset}:`)
    console.log(
      `  Source: ${configPath ?? `${ANSI.dim}(no config file found, using defaults)${ANSI.reset}`}`,
    )
    console.log(`\n${JSON.stringify(config, null, 2)}\n`)
    return 0
  }

  if (action === 'get') {
    if (!opts.key) {
      const err = 'Usage: forge config get <key> [--json]'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: Missing configuration key.${ANSI.reset}\n${err}`)
      return 1
    }
    const config = loadForgeConfig({ searchFrom: opts.cwd, env: {} })
    const value = getForgeConfigValue(opts.key, config)
    if (opts.json) {
      console.log(JSON.stringify({ key: opts.key, value }))
      return 0
    }
    if (value === undefined) {
      console.log(`  ${ANSI.dim}Key "${opts.key}" is not set.${ANSI.reset}`)
    } else {
      const formatted =
        typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : typeof value === 'string'
            ? value
            : typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : JSON.stringify(value)
      console.log(`  ${ANSI.bold}${opts.key}${ANSI.reset} = ${formatted}`)
    }
    return 0
  }

  if (action === 'set') {
    if (!opts.key || opts.val === undefined) {
      const err = 'Usage: forge config set <key> <value> [--json]'
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: Missing key or value.${ANSI.reset}\n${err}`)
      return 1
    }
    try {
      const res = setForgeConfigValue(opts.key, opts.val, configPath ?? join(opts.cwd, '.forgerc'))
      if (opts.json) {
        console.log(JSON.stringify(res))
        return 0
      }
      console.log(
        `\n${ANSI.green}✓${ANSI.reset} Updated ${ANSI.bold}${opts.key}${ANSI.reset} in ${res.configPath}`,
      )
      console.log(`  Previous: ${String(res.previousValue)}`)
      console.log(`  New:      ${String(res.newValue)}\n`)
      return 0
    } catch (e) {
      const err = `Failed to set configuration: ${e instanceof Error ? e.message : String(e)}`
      if (opts.json) console.log(JSON.stringify({ error: err }))
      else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      return 1
    }
  }

  if (action === 'profile') {
    const subaction = opts.key ?? 'list'
    if (subaction === 'list') {
      const result = listForgeProfiles(opts.cwd, configPath ?? undefined, {})
      if (opts.json) {
        console.log(JSON.stringify(result))
        return 0
      }
      console.log(`\n${ANSI.bold}FORGE CONFIGURATION PROFILES${ANSI.reset}:`)
      console.log(`  Source: ${configPath ?? '(none)'}`)
      console.log(
        `  Active: ${result.activeProfile ? `${ANSI.green}${result.activeProfile}${ANSI.reset}` : `${ANSI.dim}default (none)${ANSI.reset}`}`,
      )
      console.log(`\n  Profiles (${String(result.profiles.length)}):`)
      for (const p of result.profiles) {
        const marker = p === result.activeProfile ? `${ANSI.green}* ${p}${ANSI.reset}` : `  ${p}`
        console.log(`    ${marker}`)
      }
      console.log('')
      return 0
    }

    if (subaction === 'use') {
      const profileName = opts.val
      if (!profileName) {
        const err = 'Usage: forge config profile use <profileName> [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: Missing profile name.${ANSI.reset}\n${err}`)
        return 1
      }
      try {
        const res = switchForgeProfile(profileName, configPath ?? join(opts.cwd, '.forgerc'))
        if (opts.json) {
          console.log(JSON.stringify(res))
          return 0
        }
        console.log(
          `\n${ANSI.green}✓${ANSI.reset} Switched active profile to ${ANSI.bold}${res.newProfile}${ANSI.reset} in ${res.configPath}`,
        )
        if (res.previousProfile) {
          console.log(`  Previous profile: ${res.previousProfile}`)
        }
        console.log('')
        return 0
      } catch (e) {
        const err = `Failed to switch profile: ${e instanceof Error ? e.message : String(e)}`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
    }

    if (subaction === 'show') {
      const profileName = opts.val
      const config = loadForgeConfig({
        searchFrom: opts.cwd,
        profile: profileName,
        env: {},
      })
      if (opts.json) {
        console.log(
          JSON.stringify({
            profile: profileName ?? config.activeProfile ?? 'default',
            config,
          }),
        )
        return 0
      }
      console.log(
        `\n${ANSI.bold}Configuration for profile: ${profileName ?? config.activeProfile ?? 'default'}${ANSI.reset}:`,
      )
      console.log(`\n${JSON.stringify(config, null, 2)}\n`)
      return 0
    }

    const err = `Unknown profile action: "${subaction}". Available: list, use, show`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const err = `Unknown config action: ${action}`
  if (opts.json) console.log(JSON.stringify({ error: err }))
  else {
    console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    console.error(
      'Usage: forge config [list|get|set|profile|doctor|vault|init|policy|interpolate] [<key>] [<value>] [--json]',
    )
  }
  return 1
}

async function handleDb(opts: {
  action?: string | undefined
  targetPath?: string | undefined
  force?: boolean | undefined
  dryRun?: boolean | undefined
  beforeDate?: string | undefined
  fix?: boolean | undefined
  dataDir: string
  json: boolean
}): Promise<number> {
  const action = opts.action ?? 'stats'
  const core = createForgeCore({ dataDir: opts.dataDir })
  const dbFile = join(core.dataDir, 'forge.db')

  try {
    if (action === 'stats') {
      const stats = getDatabaseStats(core.sqlite, dbFile)
      if (opts.json) {
        console.log(JSON.stringify({ dbFile, stats }))
        return 0
      }
      console.log(`\n${ANSI.bold}DATABASE STATISTICS${ANSI.reset}:`)
      console.log(`  File:           ${dbFile}`)
      console.log(
        `  Disk Size:      ${
          stats.diskSizeBytes !== null ? `${String(stats.diskSizeBytes)} bytes` : 'unknown'
        }`,
      )
      if (stats.walSizeBytes !== null) {
        console.log(`  WAL Size:       ${String(stats.walSizeBytes)} bytes`)
      }
      console.log(`  Page Size:      ${String(stats.pageSize)} bytes`)
      console.log(`  Page Count:     ${String(stats.pageCount)}`)
      console.log(`  Freelist Pages: ${String(stats.freelistCount)}`)
      console.log(`\n${ANSI.bold}Tables (${String(stats.tables.length)})${ANSI.reset}:`)
      for (const t of stats.tables) {
        console.log(`  • ${t.tableName}: ${String(t.rowCount)} rows`)
      }
      console.log('')
      return 0
    }

    if (action === 'vacuum') {
      const result = vacuumDatabase(core.sqlite, dbFile)
      if (opts.json) {
        console.log(JSON.stringify({ dbFile, result }))
        return 0
      }
      console.log(
        `\n${ANSI.green}✓${ANSI.reset} Database vacuum completed in ${String(result.durationMs)}ms`,
      )
      if (result.sizeBeforeBytes !== null && result.sizeAfterBytes !== null) {
        console.log(`  Size Before: ${String(result.sizeBeforeBytes)} bytes`)
        console.log(`  Size After:  ${String(result.sizeAfterBytes)} bytes`)
        console.log(`  Reclaimed:   ${String(result.reclaimedBytes)} bytes`)
      }
      console.log('')
      return 0
    }

    if (action === 'backup') {
      const destinationPath = opts.targetPath
      if (!destinationPath) {
        const err = 'Usage: forge db backup <targetPath> [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const result = await backupDatabase(core.sqlite, destinationPath)
      if (opts.json) {
        console.log(JSON.stringify(result))
        return result.valid ? 0 : 1
      }
      if (result.valid) {
        console.log(`\n${result.formattedSummary}\n`)
        return 0
      } else {
        console.error(`\n${ANSI.red}✗ ${result.formattedSummary}${ANSI.reset}\n`)
        return 1
      }
    }

    if (action === 'restore') {
      const sourcePath = opts.targetPath
      if (!sourcePath) {
        const err = 'Usage: forge db restore <sourcePath> [--force] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      await core.close()
      const result = await restoreDatabase(dbFile, sourcePath, { force: opts.force })
      if (opts.json) {
        console.log(JSON.stringify(result))
        return result.success ? 0 : 1
      }
      if (result.success) {
        console.log(`\n${result.formattedSummary}\n`)
        return 0
      } else {
        console.error(`\n${ANSI.red}✗ ${result.formattedSummary}${ANSI.reset}\n`)
        return 1
      }
    }

    if (action === 'compact') {
      const result = await compactRunEvents(core.sqlite, {
        dryRun: opts.dryRun,
        beforeDate: opts.beforeDate,
      })
      if (opts.json) {
        console.log(JSON.stringify(result))
        return result.valid ? 0 : 1
      }
      console.log(`\n${result.formattedSummary}\n`)
      return result.valid ? 0 : 1
    }

    if (action === 'audit') {
      if (opts.fix) {
        const result = pruneOrphanedDatabaseRecords(core.sqlite)
        if (opts.json) {
          console.log(JSON.stringify(result))
          return result.valid ? 0 : 1
        }
        console.log(`\n${result.formattedSummary}\n`)
        return result.valid ? 0 : 1
      }

      const report = auditDatabaseIntegrity(core.sqlite)
      if (opts.json) {
        console.log(JSON.stringify(report))
        return report.valid ? 0 : 1
      }
      console.log(`\n${report.formattedSummary}\n`)
      return report.valid ? 0 : 1
    }

    const err = `Unknown db action: ${action}`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else {
      console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
      console.error('Usage: forge db [stats|vacuum|backup|restore|compact|audit] [options]')
    }
    return 1
  } finally {
    await core.close()
  }
}

async function handleDiffRevert(opts: {
  readonly runId?: string | undefined
  readonly stepId?: string | undefined
  readonly dryRun?: boolean | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runId) {
    const err = 'Usage: forge diff revert <runId> [stepId] [--dry-run] [--json]'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: No run ID provided.${ANSI.reset}\n${err}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const res = await rollbackRunChanges(core.artifacts, core.artifactStore, opts.runId, opts.cwd, {
      stepId: opts.stepId,
      dryRun: opts.dryRun,
    })

    if (!res.success) {
      if (opts.json) console.log(JSON.stringify(res))
      else console.error(`${ANSI.red}Error: ${res.error ?? 'Rollback failed'}${ANSI.reset}`)
      return 1
    }

    if (opts.json) {
      console.log(JSON.stringify(res))
    } else {
      const modeStr = res.dryRun ? ' (dry-run)' : ''
      console.log(`${ANSI.green}Rollback completed successfully${modeStr}:${ANSI.reset}`)
      console.log(`  Files restored: ${res.appliedFiles.join(', ') || 'none'}`)
    }
    return 0
  } finally {
    await core.close()
  }
}

async function handleVerifyPipeline(opts: {
  readonly configPathOrCommand?: string | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    let steps: { name: string; command: string; timeoutMs?: number }[] = []

    if (
      opts.configPathOrCommand &&
      (opts.configPathOrCommand.endsWith('.json') ||
        existsSync(resolve(opts.cwd, opts.configPathOrCommand)))
    ) {
      const filePath = resolve(opts.cwd, opts.configPathOrCommand)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          steps = parsed as { name: string; command: string; timeoutMs?: number }[]
        } else if (
          parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as Record<string, unknown>).steps)
        ) {
          steps = (parsed as Record<string, unknown>).steps as {
            name: string
            command: string
            timeoutMs?: number
          }[]
        }
      } catch (err) {
        const msg = `Failed to read pipeline configuration file: ${err instanceof Error ? err.message : String(err)}`
        if (opts.json) console.log(JSON.stringify({ error: msg }))
        else console.error(`${ANSI.red}Error: ${msg}${ANSI.reset}`)
        return 1
      }
    } else if (opts.configPathOrCommand) {
      steps = [{ name: 'custom', command: opts.configPathOrCommand }]
    } else {
      steps = [
        { name: 'format:check', command: 'npm run format:check' },
        { name: 'lint', command: 'npm run lint' },
        { name: 'test', command: 'npm test' },
      ]
    }

    const report = await executeVerificationPipeline({
      cwd: opts.cwd,
      workflowId: workflowIdSchema.parse(randomUUID()),
      stepId: stepIdSchema.parse(randomUUID()),
      steps,
    })

    if (opts.json) {
      console.log(JSON.stringify(report))
      return report.allPassed ? 0 : 1
    }

    console.log(`\n${report.formattedSummary}\n`)
    return report.allPassed ? 0 : 1
  } finally {
    await core.close()
  }
}

async function handleVerifyCoverage(opts: {
  readonly runId?: string | undefined
  readonly reportPath?: string | undefined
  readonly minCoverage?: number | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    let diff = ''
    if (opts.runId) {
      try {
        const cs = (
          core.changeSets as unknown as { getLatestForRun?: (id: string) => { patch: string } }
        ).getLatestForRun?.(opts.runId)
        if (cs && 'patch' in cs && typeof cs.patch === 'string') {
          diff = cs.patch
        }
      } catch {
        diff = ''
      }
    }
    if (!diff) {
      const git = new GitService({ repositoryPath: opts.cwd })
      try {
        const diffRes = await git.diff('HEAD~1', 'HEAD')
        diff = diffRes.patch
      } catch {
        try {
          const diffRes = await git.diffWorktree('HEAD')
          diff = diffRes.patch
        } catch {
          diff = ''
        }
      }
    }

    const lcovFile = opts.reportPath
      ? resolve(opts.cwd, opts.reportPath)
      : resolve(opts.cwd, 'coverage/lcov.info')
    let lcovContent = ''
    if (existsSync(lcovFile)) {
      lcovContent = readFileSync(lcovFile, 'utf8')
    }

    const coverageMap = lcovContent ? parseLcov(lcovContent) : new Map<string, FileCoverageData>()

    if (!diff && coverageMap.size > 0) {
      const firstFile = coverageMap.keys().next().value
      if (typeof firstFile === 'string') {
        diff = `diff --git a/${firstFile} b/${firstFile}\n--- a/${firstFile}\n+++ b/${firstFile}\n@@ -0,0 +1,2 @@\n+line1\n+line2\n`
      }
    }

    const report = auditChangesetCoverage(diff, coverageMap, opts.minCoverage ?? 80)

    if (opts.json) {
      console.log(JSON.stringify(report))
      return report.meetsThreshold ? 0 : 1
    }

    console.log(`\n${report.formattedSummary}\n`)
    return report.meetsThreshold ? 0 : 1
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

async function handleProjects(opts: {
  readonly action: string
  readonly targetId?: string | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const projectStore = new ProjectStore(core.db)
    if (opts.action === 'prune') {
      const result = await pruneMissingProjects(projectStore, core.runs)
      if (opts.json) {
        console.log(JSON.stringify(result))
      } else {
        printBanner()
        console.log(`\n${result.formattedSummary}\n`)
      }
      return result.valid ? 0 : 1
    }

    const report = await inspectProjectRegistry(projectStore, core.runs)
    if (opts.json) {
      console.log(JSON.stringify(report))
    } else {
      printBanner()
      console.log(`\n${report.formattedSummary}\n`)
    }
    return report.valid ? 0 : 1
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

async function handleDiff(opts: {
  readonly runId?: string | undefined
  readonly stepId?: string | undefined
  readonly stat?: boolean | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runId) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'Usage: forge diff <runId> [stepId] [--stat] [--json]' }))
    } else {
      console.error(`${ANSI.red}Error: No run ID provided.${ANSI.reset}`)
      console.error('Usage: forge diff <runId> [stepId] [--stat] [--json]')
    }
    return 1
  }

  const parsedRunId = runIdSchema.safeParse(opts.runId)
  if (!parsedRunId.success) {
    const err = `Invalid run ID "${opts.runId}". Expected a valid UUID.`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const report = await inspectRunDiff(core.artifacts, core.artifactStore, parsedRunId.data, {
      stepId: opts.stepId,
    })

    if (!report.valid) {
      if (opts.json) {
        console.log(JSON.stringify(report))
      } else {
        console.error(`${ANSI.red}Error: ${report.error ?? 'Diff inspection failed'}${ANSI.reset}`)
      }
      return 1
    }

    if (opts.json) {
      console.log(JSON.stringify(report))
      return 0
    }

    console.log(
      `\n${ANSI.bold}Changeset Diff for Run ${report.runId}${report.stepId ? ` (Step ${report.stepId})` : ''}${ANSI.reset}:`,
    )
    console.log(
      `  Files changed: ${String(report.totalFiles)} | Additions: ${ANSI.green}+${String(report.totalAdditions)}${ANSI.reset} | Deletions: ${ANSI.red}-${String(report.totalDeletions)}${ANSI.reset}\n`,
    )

    for (const file of report.files) {
      const statusColor =
        file.status === 'added' ? ANSI.green : file.status === 'deleted' ? ANSI.red : ANSI.yellow
      const stats = file.isBinary
        ? '[binary]'
        : `+${String(file.additions)} / -${String(file.deletions)}`
      console.log(`  ${statusColor}${file.status.padEnd(8)}${ANSI.reset} ${file.path} (${stats})`)
    }

    if (report.scopeBreaches && report.scopeBreaches.length > 0) {
      console.log(`\n  ${ANSI.red}⚠ Change Scope Breaches:${ANSI.reset}`)
      for (const breach of report.scopeBreaches) {
        console.log(`    ${ANSI.red}✖ ${breach}${ANSI.reset}`)
      }
    }

    if (!opts.stat && report.rawPatch.trim() !== '') {
      console.log(`\n${ANSI.bold}--- Patch ---${ANSI.reset}`)
      console.log(report.rawPatch)
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
  } finally {
    await core.close()
  }
}

async function handleProcesses(opts: {
  readonly action?: string | undefined
  readonly cwd: string
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const metrics = core.processes.listMetrics()

    if (opts.json) {
      console.log(JSON.stringify({ processes: metrics }))
      return 0
    }

    console.log(`\n${ANSI.bold}Process Execution Metrics (${String(metrics.length)})${ANSI.reset}:`)

    if (metrics.length === 0) {
      console.log(`  ${ANSI.dim}(No active or recent processes recorded)${ANSI.reset}\n`)
      return 0
    }

    for (const proc of metrics) {
      const statusBadge =
        proc.status === 'running'
          ? `${ANSI.cyan}RUNNING${ANSI.reset}`
          : proc.outcomeReason === 'exited' && proc.exitCode === 0
            ? `${ANSI.green}EXITED (0)${ANSI.reset}`
            : `${ANSI.red}${proc.outcomeReason?.toUpperCase() ?? 'FAILED'}${proc.exitCode !== null && proc.exitCode !== undefined ? ` (${String(proc.exitCode)})` : ''}${ANSI.reset}`

      const pidStr = proc.pid !== null ? `PID ${String(proc.pid)}` : 'PID -'
      console.log(`\n  ${statusBadge} ${ANSI.bold}${proc.runId}${ANSI.reset} [${pidStr}]`)
      console.log(`    Command: ${proc.command} ${proc.args.join(' ')}`)
      console.log(
        `    Duration: ${String(proc.durationMs)}ms | Output: ${String(proc.outputBytes)} bytes`,
      )
    }
    console.log('')
    return 0
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

async function handleDiffSecurity(opts: {
  readonly runId?: string | undefined
  readonly stepId?: string | undefined
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runId) {
    const err = 'Usage: forge diff security <runId> [stepId] [--json]'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: No run ID provided.${ANSI.reset}\n${err}`)
    return 1
  }

  const parsedRunId = runIdSchema.safeParse(opts.runId)
  if (!parsedRunId.success) {
    const err = `Invalid run ID "${opts.runId}". Expected a valid UUID.`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const report = await auditRunChangesetSecurity(
      core.artifacts,
      core.artifactStore,
      parsedRunId.data,
      opts.stepId,
    )

    if (opts.json) {
      console.log(JSON.stringify(report))
      return report.clean ? 0 : 1
    }

    console.log(`\n${report.formattedSummary}\n`)
    return report.clean ? 0 : 1
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

async function handleDiffSecrets(opts: {
  readonly runId?: string | undefined
  readonly stepId?: string | undefined
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runId) {
    const err = 'Usage: forge diff secrets <runId> [stepId] [--json]'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: No run ID provided.${ANSI.reset}\n${err}`)
    return 1
  }

  const parsedRunId = runIdSchema.safeParse(opts.runId)
  if (!parsedRunId.success) {
    const err = `Invalid run ID "${opts.runId}". Expected a valid UUID.`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const artifacts = core.artifactStore.listForRun(parsedRunId.data)
    let filtered = artifacts
    if (opts.stepId) {
      filtered = filtered.filter((a) => a.stepId === opts.stepId)
    }
    const diffArtifact =
      filtered.find((a) => a.kind === 'changeset' || a.kind === 'diff') ??
      artifacts.find((a) => a.kind === 'changeset' || a.kind === 'diff')

    if (!diffArtifact) {
      const emptyResult = {
        valid: true,
        hasLeaks: false,
        violations: [],
        formattedSummary: `No changeset or diff artifacts found for run ${opts.runId}; nothing to audit.`,
      }
      if (opts.json) console.log(JSON.stringify(emptyResult))
      else console.log(`\n${emptyResult.formattedSummary}\n`)
      return 0
    }

    const rawDiff = await core.artifacts.readArtifactText(diffArtifact.id)
    const report = scanDiffForSecretLeaks(rawDiff)

    if (opts.json) {
      console.log(JSON.stringify(report))
      return report.hasLeaks ? 1 : 0
    }

    console.log(`\n${report.formattedSummary}\n`)
    return report.hasLeaks ? 1 : 0
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

async function handleDiffCommit(opts: {
  readonly runId?: string | undefined
  readonly task?: string | undefined
  readonly dryRun?: boolean | undefined
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runId) {
    const err = 'Usage: forge diff commit <runId> [--task <description>] [--dry-run] [--json]'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: No run ID provided.${ANSI.reset}\n${err}`)
    return 1
  }

  const parsedRunId = runIdSchema.safeParse(opts.runId)
  if (!parsedRunId.success) {
    const err = `Invalid run ID "${opts.runId}". Expected a valid UUID.`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const result = await synthesizeRunChangesetCommit(
      core.artifacts,
      core.artifactStore,
      parsedRunId.data,
      { task: opts.task },
    )

    if (opts.json) {
      console.log(JSON.stringify(result))
      return result.valid ? 0 : 1
    }

    console.log(`\n${result.formattedSummary}\n`)
    return result.valid ? 0 : 1
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

async function handleDiffMerge(opts: {
  readonly runIdA?: string | undefined
  readonly runIdB?: string | undefined
  readonly dryRun?: boolean | undefined
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  if (!opts.runIdA || !opts.runIdB) {
    const err = 'Usage: forge diff merge <runIdA> <runIdB> [--dry-run] [--json]'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: Two run IDs required.${ANSI.reset}\n${err}`)
    return 1
  }

  const parsedA = runIdSchema.safeParse(opts.runIdA)
  const parsedB = runIdSchema.safeParse(opts.runIdB)
  if (!parsedA.success || !parsedB.success) {
    const err = 'Invalid run ID provided. Both must be valid UUIDs.'
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  }

  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    const report = await auditRunChangesetConflicts(
      core.artifacts,
      core.artifactStore,
      parsedA.data,
      parsedB.data,
    )

    if (opts.json) {
      console.log(JSON.stringify(report))
      return report.hasConflicts ? 1 : 0
    }

    console.log(`\n${report.formattedSummary}\n`)
    return report.hasConflicts ? 1 : 0
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

async function handleMemory(opts: {
  readonly action?: string | undefined
  readonly target?: string | undefined
  readonly limit?: string | undefined
  readonly dataDir: string
  readonly json?: boolean | undefined
}): Promise<number> {
  const action = opts.action ?? 'stats'
  const core = createForgeCore({ dataDir: opts.dataDir })
  try {
    if (action === 'stats') {
      const stats = await getMemoryStats(core.runs)
      if (opts.json) {
        console.log(JSON.stringify(stats))
        return 0
      }
      console.log(`\n${stats.formattedSummary}\n`)
      return 0
    }

    if (action === 'index') {
      const runId = opts.target
      if (!runId) {
        const err = 'Usage: forge memory index <runId> [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const parsedRunId = runIdSchema.safeParse(runId)
      if (!parsedRunId.success) {
        const err = `Invalid run ID "${runId}". Expected a valid UUID.`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const entry = await indexRunMemory(core.runs, core.artifactStore, parsedRunId.data)
      if (!entry) {
        const err = `Run "${runId}" not eligible for memory index (must have status=completed and exitCode=0)`
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      if (opts.json) {
        console.log(JSON.stringify({ indexed: true, entry }))
        return 0
      }
      console.log(`\n${ANSI.green}✓ Run "${runId}" indexed into solution memory.${ANSI.reset}\n`)
      return 0
    }

    if (action === 'search') {
      const query = opts.target
      if (!query) {
        const err = 'Usage: forge memory search <query> [--limit <n>] [--json]'
        if (opts.json) console.log(JSON.stringify({ error: err }))
        else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
        return 1
      }
      const limit = opts.limit ? parseInt(opts.limit, 10) : 5
      const result = await queryAgentMemory(core.runs, core.artifactStore, {
        query,
        limit: isNaN(limit) ? 5 : limit,
      })
      if (opts.json) {
        console.log(JSON.stringify(result))
        return 0
      }
      console.log(`\n${result.formattedSummary}\n`)
      return 0
    }

    const err = `Unknown memory action: "${action}". Available: stats, search, index`
    if (opts.json) console.log(JSON.stringify({ error: err }))
    else console.error(`${ANSI.red}Error: ${err}${ANSI.reset}`)
    return 1
  } finally {
    await core.close()
  }
}
