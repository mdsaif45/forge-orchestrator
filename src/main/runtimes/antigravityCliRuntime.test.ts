import { describe, expect, it } from 'vitest'
import { AntigravityCliRuntime } from './antigravityCliRuntime'
import type { ProcessRunner } from './claudeCliRuntime'
import { promptPacketSchema } from '@shared/domain'

describe('AntigravityCliRuntime Adapter (#25)', () => {
  it('initializes with full capabilities and starts a session', async () => {
    const runtime = new AntigravityCliRuntime()
    expect(runtime.id).toBe('antigravity-cli')
    expect(runtime.capabilities).toContain('repo-read')
    expect(runtime.capabilities).toContain('plan')
    expect(runtime.capabilities).toContain('file-write')

    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })
    expect(session.sessionId).toContain('agy-sess-')

    const status = await runtime.status(session)
    expect(status.state).toBe('idle')
    await runtime.dispose(session)
  })

  it('relays the process transcript as chunk events and ends the turn on completed', async () => {
    // Parsing the transcript into an AgentReport, and the single re-prompt on a malformed
    // reply, is `exchange()`'s job — this adapter's only responsibility is faithfully
    // relaying what the real process wrote and signalling when the turn is over.
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Analyzing repository structure...\n')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new AntigravityCliRuntime({ runner: mockRunner })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    const packet = promptPacketSchema.parse({
      role: 'planner',
      objective: 'Plan architecture',
      constraints: [],
      rules: [],
      lockedDecisions: [],
      allowedPaths: [],
      forbiddenPaths: [],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: [],
      answeredQuestions: [],
    })

    await runtime.send(session, packet)

    const events = []
    for await (const ev of runtime.events(session)) {
      events.push(ev)
      if (ev.type === 'state' && ev.state === 'completed') break
    }

    expect(events.some((e) => e.type === 'state' && e.state === 'working')).toBe(true)
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Analyzing'))).toBe(true)
    expect(events.some((e) => e.type === 'result')).toBe(false)
    expect((await runtime.status(session)).state).toBe('completed')

    await runtime.dispose(session)
  })

  it('fails the session rather than fabricating a report when no runner is configured', async () => {
    // Regression test: see the equivalent ClaudeCliRuntime test.
    const runtime = new AntigravityCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    const packet = promptPacketSchema.parse({
      role: 'planner',
      objective: 'Plan architecture',
      constraints: [],
      rules: [],
      lockedDecisions: [],
      allowedPaths: [],
      forbiddenPaths: [],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: [],
      answeredQuestions: [],
    })

    await runtime.send(session, packet)

    const events = []
    for await (const ev of runtime.events(session)) {
      events.push(ev)
      if (ev.type === 'error') break
    }

    expect(events.some((e) => e.type === 'result')).toBe(false)
    expect(events.find((e) => e.type === 'error')).toBeDefined()
    const status = await runtime.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('no process runner configured')

    await runtime.dispose(session)
  })

  it('handles cancellation and disposes cleanly', async () => {
    const runtime = new AntigravityCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    await runtime.cancel(session, 'Workflow halted')
    const status = await runtime.status(session)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('Workflow halted')
    await runtime.dispose(session)
  })
})

describe('the agy command line', () => {
  function packet(role: string) {
    return promptPacketSchema.parse({
      role,
      objective: 'Fix add()',
      constraints: [],
      rules: [],
      lockedDecisions: [],
      allowedPaths: [],
      forbiddenPaths: [],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: [],
      answeredQuestions: [],
    })
  }

  async function argsFor(
    options: Parameters<AntigravityCliRuntime['start']>[0],
  ): Promise<readonly string[]> {
    let seen: readonly string[] = []
    const runner: ProcessRunner = (_cmd, args) => {
      seen = args
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new AntigravityCliRuntime({ runner })
    const session = await runtime.start(options)
    await runtime.send(session, packet(options.role))
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'state' && ev.state === 'completed') break
    }
    await runtime.dispose(session)
    return seen
  }

  it('attaches the prompt to the flag, because a separated one is discarded', async () => {
    // `agy -p <prompt>` takes the *next flag* as its prompt and ignores the real one,
    // answering with an error that names the mistake. Measured, not read from --help.
    const args = await argsFor({ repositoryPath: 'd:/repo', role: 'implementer' })

    expect(args.some((arg) => arg.startsWith('-p='))).toBe(true)
    expect(args).not.toContain('-p')
  })

  it('declares the workspace, because without it agy edits somewhere it invented', async () => {
    // The worst failure found in either adapter: agy returns a well-formed report
    // claiming the file was fixed, `status: SUCCESS`, and the repository is untouched
    // because it created a scratch project instead (#135).
    const args = await argsFor({ repositoryPath: 'd:/repo', role: 'implementer' })

    expect(args).toContain('--add-dir=d:/repo')
  })

  it('gives a writing role the permission it needs to run commands', async () => {
    // `--mode=accept-edits` alone still auto-denies the `command` permission, and agy
    // has no `--settings` flag to carry a narrower allow-rule.
    const args = await argsFor({
      repositoryPath: 'd:/repo',
      role: 'implementer',
      permissionMode: 'acceptEdits',
    })

    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('does not give a read-only role unrestricted tool use', async () => {
    // Scoped deliberately: a planner has no reason to run commands, and the blunt flag
    // would weaken the boundary the reconciler enforces. `plan` is what the
    // orchestrator now derives for a role that may not write (#173), and agy's plan
    // mode cannot edit by construction rather than merely declining to.
    const args = await argsFor({
      repositoryPath: 'd:/repo',
      role: 'planner',
      permissionMode: 'plan',
    })

    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toContain('--mode=plan')
  })

  it('lets a writing role run unattended, whichever writing mode it was given', async () => {
    // Tested by exclusion, not equality. The previous check was `=== 'acceptEdits'`,
    // so the moment the orchestrator started sending `bypassPermissions` an
    // implementer silently lost write permission — a step that ran and changed
    // nothing, which looks like a bad agent rather than a bad flag.
    for (const permissionMode of ['acceptEdits', 'bypassPermissions', 'auto'] as const) {
      const args = await argsFor({ repositoryPath: 'd:/repo', role: 'implementer', permissionMode })
      expect(args).toContain('--dangerously-skip-permissions')
    }
  })

  it('never uses claude flag names, which agy rejects outright', async () => {
    // `flags provided but not defined: -permission-mode` — the two CLIs share no
    // spelling, which is the whole reason each has its own adapter.
    const args = await argsFor({ repositoryPath: 'd:/repo', role: 'implementer' })

    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('acceptEdits')
  })
})

describe('the agy result envelope', () => {
  it("unwraps the report from `response`, not claude's `result`", async () => {
    const report = '{\n  "status": "completed",\n  "summary": "Fixed add()"\n}'
    const envelope = JSON.stringify({
      conversation_id: 'abc',
      status: 'SUCCESS',
      response: `Fixed it.\n\nFORGE_REPORT_BEGIN\n${report}\nFORGE_REPORT_END`,
    })

    const runner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.(envelope)
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new AntigravityCliRuntime({ runner })
    const session = await runtime.start({ repositoryPath: 'd:/repo', role: 'implementer' })
    await runtime.send(
      session,
      promptPacketSchema.parse({
        role: 'implementer',
        objective: 'Fix add()',
        constraints: [],
        rules: [],
        lockedDecisions: [],
        allowedPaths: [],
        forbiddenPaths: [],
        relevantFiles: [],
        reviewFindings: [],
        previousAttempt: null,
        completionCriteria: [],
        answeredQuestions: [],
      }),
    )

    let text = ''
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'chunk') text += ev.text
      if (ev.type === 'state' && ev.state === 'completed') break
    }
    await runtime.dispose(session)

    // Exactly one block: emitting the envelope alongside the unwrapped text would put
    // the escaped copy first, and `parseAgentReport` takes the first it finds (#130).
    expect(text.match(/FORGE_REPORT_BEGIN/g)).toHaveLength(1)
    expect(text).toContain('FORGE_REPORT_BEGIN\n{\n  "status": "completed"')
    expect(text).not.toContain('\\"status\\"')
  })
})
