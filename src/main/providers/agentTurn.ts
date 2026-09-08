import { execFile } from 'node:child_process'
import { assessCommandPolicy, type Permissions } from '@shared/domain'
import { runAgentLoop, type AgentLoopResult } from './agentLoop'
import { completeWithTools } from './toolCompletion'
import type { ToolContext } from './tools'

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
  readonly allowWrite: boolean
  readonly repositoryPath: string
  readonly messages: readonly { readonly role: string; readonly content: string }[]
}

export interface AgentTurnEvent {
  readonly kind: 'reasoning' | 'content' | 'tool'
  readonly text: string
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

export async function runAgentTurn(
  request: AgentTurnRequest,
  onEvent: (event: AgentTurnEvent) => void,
): Promise<AgentLoopResult> {
  const tools: ToolContext = {
    workspacePath: request.repositoryPath,
    // The whole repository is readable, and writes are confined to source.
    // A chat turn has no task declaring scope, so this is the standing scope
    // for one, and it is deliberately not `**`.
    allowedPaths: request.allowWrite ? ['src/**', 'docs/**', '*.md'] : [],
    // Never rewritten by an agent turn: lockfiles are generated, and .git and
    // .env are not source at all.
    forbiddenPaths: ['**/.git/**', '**/.env*', '**/package-lock.json', '**/node_modules/**'],
    canWrite: request.allowWrite,
    runCommand: makeCommandRunner(),
  }

  return runAgentLoop({
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
    complete: (messages, toolDefinitions) =>
      completeWithTools(
        {
          providerId: request.providerId,
          model: request.model,
          endpointUrl: request.endpointUrl,
          apiKey: request.apiKey,
        },
        messages,
        toolDefinitions,
      ),
    onEvent: (event) => {
      if (event.kind === 'tool-start') {
        onEvent({ kind: 'tool', text: `→ ${event.name} ${event.args}` })
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
}
