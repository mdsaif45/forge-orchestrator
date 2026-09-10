import { execFile } from 'node:child_process'
import { assessCommandPolicy, type Permissions } from '@shared/domain'
import { runAgentLoop, type AgentLoopResult } from './agentLoop'
import { cachedCapabilities, type ModelCapabilities } from './capabilities'
import { completeWithTools } from './toolCompletion'
import { TOOL_DEFINITIONS, type ToolContext } from './tools'

/**
 * Runs one tool-using turn against a project's repository.
 *
 * The seam between the IPC handler and the loop: it decides the workspace, the
 * scope and what `run_command` is permitted to do, so none of that is settled
 * by the renderer or by the model.
 */

export interface AgentTurnRequest {
  readonly providerId: string
  readonly model: string
  readonly endpointUrl?: string | undefined
  readonly apiKey?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly repositoryPath: string
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  /**
   * What this turn may write, when the caller knows.
   *
   * A chat turn carries no task and so has no declared scope; it gets
   * `CHAT_WRITE_SCOPE` below. A workflow step does carry one — `allowedPaths`
   * on the packet IS the restriction (A7) — and ignoring it would let a step
   * write outside the scope its own task declared, which is the opposite of
   * what the packet is for. Empty is not the same as absent: a packet may
   * legitimately allow nothing, so this is undefined when unknown rather than
   * an empty array meaning "everything".
   */
  readonly allowedPaths?: readonly string[] | undefined
  readonly forbiddenPaths?: readonly string[] | undefined
  /**
   * Tool rounds this turn may use, when the caller knows better than the
   * default.
   *
   * A turn that is only being asked to reformat an answer it already gave
   * does not need a working budget, and giving it one is actively harmful:
   * measured, a model re-ran `edit_file` on a file it had already changed,
   * failed because the old text was gone, and then wrote the file three more
   * times trying to recover. Undefined keeps the loop's own default.
   */
  readonly maxRounds?: number | undefined
  /**
   * Set false when this turn must not use tools, whatever the model supports.
   *
   * A turn asked only to reformat an answer it already gave has nothing to do
   * with a tool, and measurement showed offering one is harmful: the model
   * re-ran an edit against text it had already replaced and then rewrote the
   * file trying to recover. Undefined leaves the decision to the model's
   * reported capability, which is the normal case.
   */
  readonly useTools?: boolean | undefined
  readonly projectId?: string | undefined
  readonly setRule?: ((scope: string, key: string, statement: string) => Promise<void>) | undefined
  readonly getRules?: (() => Promise<readonly { readonly scope: string; readonly key: string; readonly statement: string }[]>) | undefined
  readonly activeFilePath?: string | undefined
}

export interface AgentTurnEvent {
  readonly kind: 'reasoning' | 'content' | 'tool'
  readonly text: string
}

/** What the turn decided before it began, so a caller can report it. */
export interface AgentTurnPlan {
  readonly capabilities: ModelCapabilities
  /** False when the model cannot call tools; the turn is plain chat instead. */
  readonly usedTools: boolean
}

/** Long enough for a test suite, short enough that a hung command ends the turn. */
const COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_OUTPUT = 100_000

/**
 * What a chat-driven agent may do with a shell.
 *
 * Deliberately narrow. `assessCommandPolicy` still refuses the destructive
 * patterns it knows about — force push, hard reset, force clean — but this turn
 * has no workflow, no worktree and no reviewer behind it, so it is granted
 * reads and checks rather than the full permission set a bound implementer
 * gets inside a verified workflow.
 */
const CHAT_AGENT_PERMISSIONS: Permissions = {
  readFiles: true,
  writeFiles: false,
  runTests: true,
  runBuild: true,
  installPackages: false,
  gitRead: true,
  gitWrite: false,
  network: false,
}

/**
 * Runs a command in the workspace, refusing what policy forbids.
 *
 * Its own implementation rather than `evidence/commandRunner`, which requires a
 * workflow and step id to attach an evidence artifact to. Inventing those for a
 * chat turn would put fabricated ids in the audit trail, which is worse than a
 * second small runner.
 */
function makeCommandRunner(): NonNullable<ToolContext['runCommand']> {
  return (command, cwd) =>
    new Promise((resolve) => {
      const verdict = assessCommandPolicy(command, CHAT_AGENT_PERMISSIONS)
      if (!verdict.allowed) {
        resolve({
          output: `Refused by policy: ${verdict.violation?.detail ?? 'not permitted here'}`,
          code: 126,
        })
        return
      }

      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
      const args =
        process.platform === 'win32'
          ? ['-NoProfile', '-NonInteractive', '-Command', command]
          : ['-lc', command]

      execFile(
        shell,
        args,
        { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_COMMAND_OUTPUT, windowsHide: true },
        (error, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim()
          // A non-zero exit is a normal result the model should see, not an
          // exception — it is usually the failing test output it needs.
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
          resolve({ output, code })
        },
      )
    })
}

/**
 * Where writes may land in a chat-driven turn.
 *
 * Source and documentation, not the whole tree. A chat turn carries no task
 * declaring scope, so this is the standing scope for one, and it is
 * deliberately not `**`.
 */
const CHAT_WRITE_SCOPE = [
  'src/**',
  'docs/**',
  'test/**',
  'tests/**',
  'scripts/**',
  'examples/**',
  'assets/**',
  'installer/**',
  // Root-level documentation and config, and the same names anywhere below.
  // `*.md` alone matched `README.md` but not `assets/README.md` — measured
  // against a real repository, where the model found two READMEs, was refused
  // on the nested one and on `LICENSE`, and abandoned the turn.
  '*.md',
  '**/*.md',
  '*.txt',
  '**/*.txt',
  '*.json',
  '*.toml',
  '*.yml',
  '*.yaml',
  'LICENSE',
  'CHANGELOG',
] as const

/**
 * Never writable, whatever the scope says.
 *
 * `.git` and `.env*` are not source; a lockfile is generated and hand-editing
 * one produces an install that cannot be reproduced.
 */
const NEVER_WRITABLE = [
  '**/.git/**',
  '**/.env*',
  '**/package-lock.json',
  '**/*.lock',
  '**/node_modules/**',
] as const

export async function runAgentTurn(
  request: AgentTurnRequest,
  onEvent: (event: AgentTurnEvent) => void,
): Promise<AgentLoopResult & { readonly plan: AgentTurnPlan }> {
  // Asked of the provider, not of the user. A model without tool support gets a
  // plain completion instead of definitions it cannot use, and nobody has to
  // know in advance which of their models is which.
  const capabilities = await cachedCapabilities({
    providerId: request.providerId,
    model: request.model,
    endpointUrl: request.endpointUrl,
    apiKey: request.apiKey,
  })

  // Tools require both a model that can call them and a caller that wants them.
  const toolsEnabled = capabilities.tools && request.useTools !== false

  const tools: ToolContext = {
    workspacePath: request.repositoryPath,
    // Writes are on when the model can call tools at all. Safety is the scope
    // and the forbidden list, not a button the user has to remember: a toggle
    // put the question to the person least able to answer it, and a model
    // without `tools` could be handed definitions it would fail on.
    // The caller's scope when it declared one, the standing chat scope when
    // not. A workflow packet's `allowedPaths` is the restriction (A7), and this
    // used to discard it — every step wrote under the chat scope instead of the
    // one its own task declared.
    allowedPaths: request.allowedPaths ?? [...CHAT_WRITE_SCOPE],
    // Forbidden always wins, so the caller's list ADDS to these rather than
    // replacing them: no packet should be able to make `.git` writable.
    forbiddenPaths: [...NEVER_WRITABLE, ...(request.forbiddenPaths ?? [])],
    canWrite: toolsEnabled,
    runCommand: makeCommandRunner(),
    projectId: request.projectId,
    setRule: request.setRule,
    getRules: request.getRules,
    activeFilePath: request.activeFilePath,
  }

  const plan: AgentTurnPlan = { capabilities, usedTools: toolsEnabled }

  const result = await runAgentLoop({
    messages: [
      ...(request.systemPrompt === undefined || request.systemPrompt === ''
        ? []
        : [{ role: 'system' as const, content: request.systemPrompt }]),
      ...request.messages.map((message) => ({
        role: message.role as 'user' | 'assistant' | 'system',
        content: message.content,
      })),
    ],
    tools,
    // Only a request that actually asks for a change is held to making one.
    // Applying it to every turn was a regression: "hi" and "tell me about
    // project" were both nudged to edit files nobody had asked about, and the
    // model spent a round explaining that no edit was needed.
    requireOneOf:
      toolsEnabled && asksForChange(request.messages) ? ['edit_file', 'write_file'] : [],
    ...(request.maxRounds === undefined ? {} : { maxRounds: request.maxRounds }),
    // A model that cannot call tools is offered none, decided once here rather
    // than re-filtered on every round inside `complete`.
    toolDefinitions: toolsEnabled ? TOOL_DEFINITIONS : [],
    complete: (messages, toolDefinitions, round) =>
      completeWithTools(
        {
          providerId: request.providerId,
          model: request.model,
          endpointUrl: request.endpointUrl,
          apiKey: request.apiKey,
          round,
        },
        messages,
        // Already narrowed by `toolDefinitions` above; passed straight through
        // so the loop stays the single place that decides what is offered.
        toolDefinitions,
      ),
    onEvent: (event) => {
      if (event.kind === 'nudge') {
        onEvent({ kind: 'tool', text: '↻ no change made yet — asking again' })
        return
      }
      if (event.kind === 'reasoning') {
        onEvent({ kind: 'reasoning', text: event.text })
        return
      }
      if (event.kind === 'tool-start') {
        onEvent({ kind: 'tool', text: `→ ${event.name} ${describeArgs(event.args)}` })
        return
      }
      if (event.kind === 'tool-end') {
        onEvent({
          kind: 'tool',
          text: `${event.ok ? '✓' : '✗'} ${event.name} — ${event.summary}`,
        })
        return
      }
      onEvent({ kind: 'content', text: event.text })
    },
  })

  return { ...result, plan }
}

/**
 * Verbs that name an action on the repository rather than a question about it.
 *
 * A module constant so the pattern is written once, in source, where its word
 * boundaries survive. An earlier version was edited in by a script that turned
 * the boundary escapes into literal backspace bytes: the pattern then required
 * an unprintable character before "update" and matched nothing, so every change
 * request silently skipped the enforcement round while appearing to have it.
 *
 * Bare "make" and "do" are deliberately absent — "make sense of this" and "what
 * does it do" are questions, not change requests.
 */
const CHANGE_VERBS =
  /\b(update|updating|change|changing|edit|editing|modify|modifying|fix|fixing|add|adding|append|appending|remove|removing|delete|deleting|rename|renaming|refactor|refactoring|implement|implementing|write|writing|create|creating|replace|replacing|rewrite|rewriting|insert|inserting|bump|migrate)\b/i

/**
 * Whether the latest user message asks for the repository to change.
 *
 * Read off the last user turn rather than the whole conversation: an earlier
 * edit request is finished business, and treating it as still owed would nudge
 * every later question in the thread.
 *
 * Deliberately conservative. A false negative costs the enforcement round on a
 * request phrased unusually, which is the behaviour before it existed. A false
 * positive is what went wrong — a plain question gets told to edit a file, and
 * the turn is spent on the model explaining that nothing needed editing.
 */
export function asksForChange(
  messages: readonly { readonly role: string; readonly content: string }[],
): boolean {
  const latest = [...messages].reverse().find((message) => message.role === 'user')
  if (latest === undefined) return false

  // Verbs that name an action on the repository. Bare "make" and "do" are left
  // out: "make sense of this" and "what does it do" are questions.
  return CHANGE_VERBS.test(latest.content)
}

/**
 * The interesting part of a tool's arguments, for the progress line.
 *
 * Raw JSON is unreadable at a glance, and `write_file` carries a whole file in
 * `content` — printing that would bury the progress log in the very text the
 * agent is writing.
 */
function describeArgs(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed !== 'object' || parsed === null) return ''
    const record = parsed as Record<string, unknown>

    const primary = record.path ?? record.query ?? record.command
    if (typeof primary !== 'string') return ''

    const size =
      typeof record.content === 'string' ? ` (${String(record.content.length)} chars)` : ''
    return `${primary}${size}`
  } catch {
    return ''
  }
}
