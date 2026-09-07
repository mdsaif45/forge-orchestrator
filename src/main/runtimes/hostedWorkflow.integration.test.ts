import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compileContext,
  FEATURE_IMPLEMENTATION,
  projectIdSchema,
  repositoryIdSchema,
  taskIdSchema,
  workflowIdSchema,
  workflowLimitsSchema,
  type ProjectId,
  type TaskId,
  type WorkflowId,
} from '@shared/domain'
import { removeTempDir } from '../../test/tempDir'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { PacketStore } from '../context/packetStore'
import type { ProcessHandle, ProcessManager } from '../process/processManager'
import { bindRole, BindingSet } from './bindings'
import { HostedClaudeRuntime } from './hostedClaudeRuntime'
import { Orchestrator } from './orchestrator'
import { RuntimeRegistry } from './registry'

/**
 * A whole workflow driven through the HOSTED runtime, not the mock.
 *
 * Everything else that exercises the orchestrator binds `MockAgentRuntime`,
 * which returns a structured report directly and never spawns, types, or reads
 * a hook. So the hosted path — the one `src/main/index.ts` actually wires — was
 * only ever proven for a single turn in isolation. Five stages with role
 * handoffs, three separate sessions, and a correction retry were not covered
 * anywhere.
 *
 * These are deliberately not a second copy of the unit tests in
 * `hostedClaudeRuntime.test.ts`. Those cover one turn's three race outcomes and
 * are what catch the watcher leak (verified: reverting that fix makes them
 * report `EPERM: watch`, while these still pass, because a workflow's turns all
 * end on the winning hook arm). What these cover instead is the loop — that
 * three sessions are opened and disposed in role order, that each role's own
 * prompt arrives whole, and that a malformed report is re-prompted on the same
 * session and the run still reaches DONE.
 *
 * The pty is faked; the hook mechanism is NOT. Each stage's reply travels
 * through a real `ClaudeHookBridge` — a real receiver script, a real merged
 * `settings.local.json`, and a real appended JSONL line that a real `fs.watch`
 * picks up. What is stubbed is only the CLI itself: a screen to read and a
 * process to write to.
 *
 * The fake reacts to what the runtime writes rather than pre-staging answers,
 * so the ordering is the real one — a hook that fired before the prompt was
 * submitted would prove nothing about the sequencing that two measured bugs
 * (boot noise, undermarked paste) were both about.
 */

const ESC = String.fromCharCode(27)
const CLEAR = `${ESC}[2J${ESC}[H`
/** A TUI repaints in place, so a fixture that only appends never clears the busy line. */
const READY = `${CLEAR}----\r\n> Try "edit"\r\n----\r\n? for shortcuts\r\n`
const WORKING = `${CLEAR}> working\r\n* Searching...\r\nesc to interrupt\r\n`

/** The bracketed-paste markers the runtime wraps a prompt in, as the CLI sees them. */
const PASTE_BEGIN = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`

const NOW = '2026-08-19T10:00:00.000Z'

let dbFile: string
let db: ForgeDatabase
let closeDb: () => void
let repoPath: string
let packetDir: string
let receiverDir: string
const tempDirs: string[] = []

let projectId: ProjectId
let taskId: TaskId
let workflowId: WorkflowId

const OBJECTIVE = 'Correct the constant in src/math.ts'

function task() {
  return {
    id: taskId,
    objective: OBJECTIVE,
    constraints: [],
    completionCriteria: [{ kind: 'tests' as const, description: 'the tests pass', params: {} }],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: NOW,
  }
}

beforeEach(() => {
  // A plain directory, not a git repository. `orchestrator.test.ts` initialises
  // one because it diffs the worktree; `measureChange` here returns null, so
  // nothing reads git — verified by removing the init and watching all six
  // still pass. Keeping it would add an external `git` dependency to a suite
  // that never uses it.
  repoPath = mkdtempSync(join(tmpdir(), 'forge-hosted-wf-repo-'))

  packetDir = mkdtempSync(join(tmpdir(), 'forge-hosted-wf-packets-'))
  receiverDir = mkdtempSync(join(tmpdir(), 'forge-hosted-wf-recv-'))
  const dbDir = mkdtempSync(join(tmpdir(), 'forge-hosted-wf-db-'))
  dbFile = join(dbDir, 'forge.db')
  tempDirs.push(repoPath, packetDir, receiverDir, dbDir)

  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close

  projectId = projectIdSchema.parse(randomUUID())
  taskId = taskIdSchema.parse(randomUUID())
  workflowId = workflowIdSchema.parse(randomUUID())

  new ProjectStore(db).create(
    {
      id: projectId,
      name: 'Subject',
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoPath.split('\\').join('/'),
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: null,
        tech: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    'user',
  )

  applyEvent(
    db,
    new EventStore(db).append(
      { type: 'task.created', payload: { task: task() } },
      { projectId, actor: 'user', occurredAt: NOW },
    ),
  )

  new WorkflowStore(db).start(
    { workflowId, projectId, taskId, templateId: 'feature', startedAt: NOW },
    'user',
  )
})

afterEach(async () => {
  closeDb()
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir)
})

/** The report an honest agent prints, fenced the way the protocol requires. */
function fencedReport(summary: string, filesChanged: readonly string[] = []): string {
  return [
    'Reading the file now.',
    '',
    'FORGE_REPORT_BEGIN',
    JSON.stringify(
      {
        status: 'completed',
        summary,
        filesChanged,
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      },
      null,
      2,
    ),
    'FORGE_REPORT_END',
  ].join('\n')
}

interface SpawnRecord {
  readonly cwd: string
  readonly args: readonly string[]
}

/**
 * A `ProcessManager` that fakes the CLI but drives the real hook bridge.
 *
 * `replyFor` is called with the prompt the runtime actually submitted, so a
 * test can assert on what the agent was told and vary the reply per stage. The
 * hook line is appended only once that submission is observed — mirroring the
 * real CLI, where `Stop` cannot fire before a turn has begun.
 */
function makeProcesses(replyFor: (prompt: string, spawnIndex: number) => string): {
  processes: ProcessManager
  spawns: SpawnRecord[]
  prompts: string[]
} {
  const spawns: SpawnRecord[] = []
  const prompts: string[] = []

  const processes = {
    spawn: (request: { command: string; args: readonly string[]; cwd: string }) => {
      const index = spawns.length
      spawns.push({ cwd: request.cwd, args: request.args })

      const listeners: ((text: string) => void)[] = []
      let pasteBuffer = ''
      let inPaste = false

      const emit = (text: string): void => {
        for (const listener of listeners) listener(text)
      }

      // Painted on the next tick so the session is subscribed first: the runtime
      // attaches its listener after `spawn` resolves, and a screen emitted
      // synchronously here would be written to nobody.
      setTimeout(() => {
        emit(READY)
      }, 0)

      const handle: ProcessHandle = {
        runId: `run-${String(index)}`,
        onData: (listener) => {
          listeners.push(listener)
          return () => undefined
        },
        onRawData: (listener) => {
          listeners.push(listener)
          return () => undefined
        },
        completed: new Promise(() => undefined),
        write: (input: string) => {
          // Reassemble the bracketed paste the runtime sends, exactly as the
          // CLI's own input does: markers delimit the text, and a bare `\r`
          // afterwards is the submission.
          if (input.includes(PASTE_BEGIN)) {
            inPaste = true
            pasteBuffer += input.slice(input.indexOf(PASTE_BEGIN) + PASTE_BEGIN.length)
            if (pasteBuffer.includes(PASTE_END)) {
              pasteBuffer = pasteBuffer.slice(0, pasteBuffer.indexOf(PASTE_END))
              inPaste = false
            }
            return
          }
          if (inPaste) {
            pasteBuffer += input
            return
          }
          if (input !== '\r') return

          const prompt = pasteBuffer
          prompts.push(prompt)
          pasteBuffer = ''

          // Busy first, then the hook. The busy screen deliberately carries no
          // caret, so a runtime reading the screen for completion would still be
          // waiting — the hook is what ends the turn.
          emit(WORKING)
          appendFileSync(
            join(request.cwd, '.claude', 'forge-hooks.jsonl'),
            `${JSON.stringify({
              kind: 'stop',
              at: Date.now(),
              raw: JSON.stringify({
                session_id: `sess-${String(index)}`,
                last_assistant_message: replyFor(prompt, index),
              }),
            })}\n`,
            'utf8',
          )

          // Back to the prompt box, which is what a real session does after
          // answering. Without it a second turn on the same session waits
          // forever for a caret that never returns — how the retry case first
          // failed here, and a fidelity gap in the fake rather than a defect.
          setTimeout(() => {
            emit(READY)
          }, 0)
        },
        resize: () => undefined,
        cancel: () => Promise.resolve(),
      }

      return Promise.resolve(handle)
    },
  } as unknown as ProcessManager

  return { processes, spawns, prompts }
}

function hostedRegistry(processes: ProcessManager): {
  registry: RuntimeRegistry
  bindings: BindingSet
} {
  const registry = new RuntimeRegistry()
  registry.register(
    new HostedClaudeRuntime({
      processes,
      hookReceiverDir: receiverDir,
      // Scaled, not flattened: `runTurnByHook` races a 600s deadline against a
      // 500ms dialog poll, and a sleep that ignores its argument collapses them
      // so the deadline can win a race it must never win.
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, Math.round(ms / 1000)))),
    }),
  )

  const bindings = new BindingSet([
    bindRole(registry, { role: 'planner', runtimeId: 'claude-cli-hosted' }),
    bindRole(registry, { role: 'implementer', runtimeId: 'claude-cli-hosted' }),
    bindRole(registry, { role: 'reviewer', runtimeId: 'claude-cli-hosted' }),
  ])

  return { registry, bindings }
}

function orchestrator(registry: RuntimeRegistry): Orchestrator {
  return new Orchestrator({
    registry,
    workflows: new WorkflowStore(db),
    packets: new PacketStore({ directory: packetDir }),
    compilePacket: (context) =>
      Promise.resolve(
        compileContext({
          role: context.role,
          task: task(),
          rules: [],
          lockedDecisions: [],
          files: [{ path: 'src/math.ts', mentionedInTask: true, inScope: true }],
          previousAttempt: context.previousAttempt,
          reviewFindings: context.reviewFindings,
          answeredQuestions: [],
        }).packet,
      ),
    // The diff is irrelevant to what these tests assert, and reading it would
    // add a git dependency to every one of them.
    measureChange: () => Promise.resolve(null),
  })
}

function runOptions(bindings: BindingSet, overrides: Record<string, unknown> = {}) {
  return {
    workflowId,
    template: FEATURE_IMPLEMENTATION,
    bindings,
    repositoryPath: repoPath,
    limits: workflowLimitsSchema.parse({ maxIterations: 2 }),
    approve: () => Promise.resolve(true),
    verify: () => Promise.resolve({ passed: true, detail: 'build and tests passed' }),
    ...overrides,
  }
}

describe('a full workflow on the hosted runtime', () => {
  it('reaches DONE with every agent turn completed from its own Stop hook', async () => {
    const { processes, spawns } = makeProcesses((_prompt, index) =>
      fencedReport(`Stage ${String(index)} done`, index === 1 ? ['src/math.ts'] : []),
    )
    const { registry, bindings } = hostedRegistry(processes)

    const outcome = await orchestrator(registry).run(runOptions(bindings))

    expect(outcome.state).toBe('DONE')
    expect(outcome.steps.map((step) => step.role)).toEqual([
      'planner',
      'user',
      'implementer',
      'system',
      'reviewer',
    ])
    // One spawn per agent role, and none for the `user`/`system` steps — a
    // hosted session is expensive, so a Forge step must not open one.
    expect(spawns).toHaveLength(3)
  }, 60_000)

  it('gives each role its own session, and never reuses a disposed one', async () => {
    // Three sessions rather than one kept warm across roles: a planner's
    // transcript reaching the reviewer would defeat the point of a review, and
    // the orchestrator disposes each session in a `finally`.
    const { processes, spawns } = makeProcesses((_prompt, index) =>
      fencedReport(`Stage ${String(index)} done`),
    )
    const { registry, bindings } = hostedRegistry(processes)

    await orchestrator(registry).run(runOptions(bindings))

    const sessionIds = spawns.map((spawn) => {
      const at = spawn.args.indexOf('--session-id')
      return at === -1 ? null : spawn.args[at + 1]
    })

    expect(sessionIds.every((id) => id !== null)).toBe(true)
    expect(new Set(sessionIds).size).toBe(3)
  }, 60_000)

  it('sends each role the prompt for that role, whole', async () => {
    // The paste-truncation bug (#169) was invisible at unit level: the prompt
    // was written, the turn completed, and only the model's reply revealed that
    // just the tail had arrived. Asserting the reassembled paste per stage is
    // what would catch it returning.
    const { processes, prompts } = makeProcesses((_prompt, index) =>
      fencedReport(`Stage ${String(index)} done`),
    )
    const { registry, bindings } = hostedRegistry(processes)

    await orchestrator(registry).run(runOptions(bindings))

    expect(prompts).toHaveLength(3)
    // The objective survives the flatten-and-paste round trip in every prompt,
    // not merely in the first.
    for (const prompt of prompts) {
      expect(prompt).toContain(OBJECTIVE)
      expect(prompt).toContain('FORGE_REPORT_BEGIN')
    }
    expect(prompts[0]).toContain('planner')
    expect(prompts[1]).toContain('implementer')
    expect(prompts[2]).toContain('reviewer')
  }, 60_000)

  it('retries a malformed report on the same session and still reaches DONE', async () => {
    // `exchange` sends a second packet on the SAME session when the first reply
    // carries no report fence, so `hooks.next()` is entered twice for one
    // session and the second turn must find a prompt box again. Nothing
    // exercised that before: the single-turn tests dispose after one send.
    const seen: number[] = []
    const { processes, prompts } = makeProcesses((_prompt, index) => {
      seen.push(index)
      const attempt = seen.filter((value) => value === index).length
      // The planner's first reply is prose with no fence; its retry is valid.
      if (index === 0 && attempt === 1) return 'I had a look and it seems fine.'
      return fencedReport(`Stage ${String(index)} done`)
    })
    const { registry, bindings } = hostedRegistry(processes)

    const outcome = await orchestrator(registry).run(runOptions(bindings))

    expect(outcome.state).toBe('DONE')
    // Four turns over three sessions: the planner was prompted twice.
    expect(prompts).toHaveLength(4)
    // The correction has to reach the AGENT, not just the transcript. It used to
    // be concatenated onto a local string while the packet was sent unchanged,
    // so no adapter ever rendered it and two identical attempts read as the
    // agent ignoring the correction (#135). Asserting it on the delivered
    // prompt is what makes that unfakeable on this path.
    expect(prompts[0]).not.toContain('YOUR PREVIOUS REPLY WAS REJECTED')
    expect(prompts[1]).toContain('YOUR PREVIOUS REPLY WAS REJECTED')
    expect(prompts[1]).toContain('FORGE_REPORT_BEGIN')
  }, 60_000)

  it('installs its hooks into each session’s own worktree settings', async () => {
    // Merged, never blind-written: this file can carry a user's own hooks and
    // permissions, and three sessions install into the same worktree in turn.
    const { processes } = makeProcesses((_prompt, index) =>
      fencedReport(`Stage ${String(index)} done`),
    )
    const { registry, bindings } = hostedRegistry(processes)

    await orchestrator(registry).run(runOptions(bindings))

    const settings = JSON.parse(
      readFileSync(join(repoPath, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks?: Record<string, readonly unknown[]> }

    expect(Object.keys(settings.hooks ?? {})).toContain('Stop')
    // Installed three times, still one entry: a duplicate would make every
    // turn's log carry the same event twice.
    expect(settings.hooks?.Stop).toHaveLength(1)
  }, 60_000)

  it('records the run in the event log, as it does on any other runtime', async () => {
    // A6 read off the log: which runtime held a role is a binding, and the
    // recorded shape of a run must not depend on it.
    const { processes } = makeProcesses((_prompt, index) =>
      fencedReport(`Stage ${String(index)} done`),
    )
    const { registry, bindings } = hostedRegistry(processes)

    await orchestrator(registry).run(runOptions(bindings))

    const types = new EventStore(db)
      .read(projectId)
      .map((event) => event.type)
      .filter((type) => type.startsWith('workflow.') || type.startsWith('step.'))

    expect(types).toContain('workflow.transitioned')
    expect(types).toContain('workflow.checkpointed')
    expect(types).toContain('step.started')
    expect(types).toContain('step.finished')
    expect(types).toContain('workflow.finished')
  }, 60_000)
})
