import { describe, expect, it } from 'vitest'
import { ClaudeCliRuntime, type ProcessRunner } from './claudeCliRuntime'
import { promptPacketSchema } from '@shared/domain'

describe('ClaudeCliRuntime Adapter (#24)', () => {
  it('initializes with proper capabilities and starts a session', async () => {
    const runtime = new ClaudeCliRuntime()
    expect(runtime.id).toBe('claude-cli')
    expect(runtime.capabilities).toContain('repo-read')
    expect(runtime.capabilities).toContain('file-write')

    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })
    expect(session.sessionId).toContain('claude-sess-')

    const status = await runtime.status(session)
    expect(status.state).toBe('idle')
    await runtime.dispose(session)
  })

  it('relays the process transcript as chunk events and ends the turn on completed', async () => {
    // Parsing the transcript into an AgentReport, and the single re-prompt on a malformed
    // reply, is `exchange()`'s job (see protocol.test.ts and exchange.test.ts) — this adapter's
    // only responsibility is faithfully relaying what the real process wrote and signalling
    // when the turn is over, not interpreting the content.
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Starting turn...\n')
      options.onStdout?.('Editing src/index.ts\n')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner: mockRunner })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    const packet = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Editing'))).toBe(true)
    expect(events.some((e) => e.type === 'result')).toBe(false)
    expect((await runtime.status(session)).state).toBe('completed')

    await runtime.dispose(session)
  })

  it('fails the session rather than fabricating a report when no runner is configured', async () => {
    // Regression test: a ClaudeCliRuntime built without a way to spawn the real CLI has no
    // way to know what happened, and previously reported a synthetic "completed" result for
    // work that never ran — exactly the unverified claim Forge exists to catch in agents.
    const runtime = new ClaudeCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    const packet = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    const status = await runtime.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('no process runner configured')

    await runtime.dispose(session)
  })

  it('handles cancellation and marks session cancelled', async () => {
    const runtime = new ClaudeCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    await runtime.cancel(session, 'User cancelled')
    const status = await runtime.status(session)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('User cancelled')
    await runtime.dispose(session)
  })
})

describe('running as a bound account', () => {
  function packet() {
    return promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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

  it('spawns with the account home, so the CLI acts as that account', async () => {
    let seenEnv: Readonly<Record<string, string>> | undefined
    const runner: ProcessRunner = (_cmd, _args, options) => {
      seenEnv = options.env
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({
      runner,
      homeForAccount: (id) => `D:/forge/accounts/${id}/home`,
    })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
      accountId: 'acct-work',
    })

    await runtime.send(session, packet())
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'state' && ev.state === 'completed') break
    }

    // Both variables: setting one leaves the other pointing at the real user, and the
    // child would authenticate as the wrong account (#111).
    expect(seenEnv?.HOME).toBe('D:/forge/accounts/acct-work/home')
    expect(seenEnv?.USERPROFILE).toBe('D:/forge/accounts/acct-work/home')

    await runtime.dispose(session)
  })

  it('fails rather than running as the default identity when the account is unenrolled', async () => {
    // The dangerous case. Falling back to the machine's own login would let the work
    // succeed, be attributed to the wrong account, and consume the wrong quota — with
    // nothing visible to say so.
    let spawned = false
    const runner: ProcessRunner = () => {
      spawned = true
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner, homeForAccount: () => null })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
      accountId: 'never-enrolled',
    })

    await runtime.send(session, packet())

    const events = []
    for await (const ev of runtime.events(session)) {
      events.push(ev)
      if (ev.type === 'error') break
    }

    expect(spawned).toBe(false)
    expect((await runtime.status(session)).state).toBe('failed')
    expect((await runtime.status(session)).failure).toContain('no enrolled home')

    await runtime.dispose(session)
  })

  it('passes no account environment when the session names none', async () => {
    // The default path stays untouched: a session with no account runs as whoever
    // Forge itself is running as, which is what a single-account setup expects.
    let seenEnv: Readonly<Record<string, string>> | undefined = { sentinel: 'unset' }
    const runner: ProcessRunner = (_cmd, _args, options) => {
      seenEnv = options.env
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner })
    const session = await runtime.start({ repositoryPath: 'd:/test-repo', role: 'implementer' })

    await runtime.send(session, packet())
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'state' && ev.state === 'completed') break
    }

    expect(seenEnv).toBeUndefined()

    await runtime.dispose(session)
  })
})

describe('permission mode', () => {
  function packet() {
    return promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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
    options: Parameters<ClaudeCliRuntime['start']>[0],
  ): Promise<readonly string[]> {
    let seen: readonly string[] = []
    const runner: ProcessRunner = (_cmd, args) => {
      seen = args
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner })
    const session = await runtime.start(options)
    await runtime.send(session, packet())
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'state' && ev.state === 'completed') break
    }
    await runtime.dispose(session)
    return seen
  }

  it('always passes a permission mode, defaulting to acceptEdits', async () => {
    // The #130 regression. Without the flag the CLI denies every tool call and waits
    // for an approval a `-p` run cannot give, so the agent can reason and never act —
    // which surfaced as a protocol violation, because a blocked agent replies in prose.
    const args = await argsFor({ repositoryPath: 'd:/repo', role: 'implementer' })

    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('passes the mode the session asked for', async () => {
    const args = await argsFor({
      repositoryPath: 'd:/repo',
      role: 'planner',
      permissionMode: 'plan',
    })

    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })
})

describe('the result envelope', () => {
  function packet() {
    return promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Fix it',
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

  async function transcriptFrom(stdout: string): Promise<string> {
    const runner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.(stdout)
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner })
    const session = await runtime.start({ repositoryPath: 'd:/repo', role: 'implementer' })
    await runtime.send(session, packet())

    let text = ''
    for await (const ev of runtime.events(session)) {
      if (ev.type === 'chunk') text += ev.text
      if (ev.type === 'state' && ev.state === 'completed') break
    }
    await runtime.dispose(session)
    return text
  }

  it('unwraps the report from the JSON envelope so it can be parsed', async () => {
    // The #130 defect. `--output-format json` wraps the reply, so the report block
    // arrives JSON-escaped inside `result`. Parsing raw stdout finds the escaped copy
    // and fails — which halted a run *after* the agent had correctly fixed the bug.
    const report = '{\n  "status": "completed",\n  "summary": "Fixed add()"\n}'
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: `Fixed it.\n\nFORGE_REPORT_BEGIN\n${report}\nFORGE_REPORT_END`,
    })

    const text = await transcriptFrom(envelope)

    // The unescaped block must be present, or `exchange()` cannot extract a report.
    expect(text).toContain('FORGE_REPORT_BEGIN\n{\n  "status": "completed"')
    expect(text).toContain('FORGE_REPORT_END')

    // And exactly one copy of it. `parseAgentReport` takes the *first* REPORT_BEGIN it
    // finds, so emitting the raw envelope alongside the unwrapped text put the escaped
    // copy first and made the parse run across both, failing on the backslashes. That
    // halted a run in which the agent had already fixed the bug correctly (#130).
    expect(text.match(/FORGE_REPORT_BEGIN/g)).toHaveLength(1)
    expect(text).not.toContain('\\"status\\"')
  })

  it('falls back to the raw output when it is not an envelope', async () => {
    // A change of output format must degrade to using stdout, not lose the reply.
    const text = await transcriptFrom(
      'FORGE_REPORT_BEGIN\n{"status":"completed"}\nFORGE_REPORT_END',
    )

    expect(text).toContain('FORGE_REPORT_BEGIN')
  })
})
