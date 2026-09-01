import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { ClaudeHookBridge } from './claudeHooks'

/**
 * The settings file under test can carry a user's own hooks, permissions, and
 * MCP configuration, so most of these assertions are really about not
 * destroying it — the same discipline as `ClaudeTrustStore`.
 */
const dirs: string[] = []

const makeWorktree = (): { worktree: string; receiverDir: string } => {
  const worktree = mkdtempSync(join(tmpdir(), 'forge-hooks-'))
  const receiverDir = mkdtempSync(join(tmpdir(), 'forge-hooks-recv-'))
  dirs.push(worktree, receiverDir)
  return { worktree, receiverDir }
}

const readSettings = (worktree: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(worktree, '.claude', 'settings.local.json'), 'utf8')) as Record<
    string,
    unknown
  >

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir)
})

describe('ClaudeHookBridge.install', () => {
  it('adds a Stop and a PermissionRequest hook', async () => {
    const { worktree, receiverDir } = makeWorktree()
    await new ClaudeHookBridge(worktree, { receiverDir }).install()

    const settings = readSettings(worktree) as {
      hooks: { Stop: unknown[]; PermissionRequest: unknown[] }
    }
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.PermissionRequest).toHaveLength(1)
  })

  it('produces a command with no quote characters a shell could misparse', async () => {
    // Two earlier versions of this command both broke on quoting: one had the
    // log path embedded as a JS string literal inside a double-quoted -e
    // argument, closed early by the path's own '"'; another base64-encoded the
    // body but still wrapped it in single quotes that did not survive an
    // intermediate shell layer. Neither failure was hypothetical — both were
    // measured. The fix removes embedded quoting entirely, which this pins.
    const { worktree, receiverDir } = makeWorktree()
    await new ClaudeHookBridge(worktree, { receiverDir }).install()

    const settings = readSettings(worktree) as {
      hooks: { Stop: { hooks: { command: string }[] }[] }
    }
    const command = settings.hooks.Stop[0]?.hooks[0]?.command ?? ''
    expect(command).not.toMatch(/-e\s/)
    expect((command.match(/"/g) ?? []).length % 2).toBe(0)
  })

  it('merges into settings that already carry the user’s own configuration', async () => {
    const { worktree, receiverDir } = makeWorktree()
    mkdirSync(join(worktree, '.claude'), { recursive: true })
    writeFileSync(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({ allowedTools: ['Bash'], hooks: { SessionStart: [{ hooks: [] }] } }),
    )

    await new ClaudeHookBridge(worktree, { receiverDir }).install()

    const settings = readSettings(worktree) as {
      allowedTools: string[]
      hooks: { SessionStart: unknown[]; Stop: unknown[] }
    }
    expect(settings.allowedTools).toEqual(['Bash'])
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('is idempotent: installing twice does not duplicate the hook', async () => {
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    await bridge.install()
    await bridge.install()

    const settings = readSettings(worktree) as { hooks: { Stop: unknown[] } }
    expect(settings.hooks.Stop).toHaveLength(1)
  })

  it('writes the receiver script once, shared by every worktree', async () => {
    const receiverDir = mkdtempSync(join(tmpdir(), 'forge-hooks-recv-'))
    const a = mkdtempSync(join(tmpdir(), 'forge-hooks-'))
    const b = mkdtempSync(join(tmpdir(), 'forge-hooks-'))
    dirs.push(receiverDir, a, b)

    await new ClaudeHookBridge(a, { receiverDir }).install()
    await new ClaudeHookBridge(b, { receiverDir }).install()

    const settingsA = readSettings(a) as { hooks: { Stop: { hooks: { command: string }[] }[] } }
    const settingsB = readSettings(b) as { hooks: { Stop: { hooks: { command: string }[] }[] } }
    const receiverInA = settingsA.hooks.Stop[0]?.hooks[0]?.command.split('"')[1]
    const receiverInB = settingsB.hooks.Stop[0]?.hooks[0]?.command.split('"')[1]
    expect(receiverInA).toBe(receiverInB)
  })
})

describe('ClaudeHookBridge.uninstall', () => {
  it('removes only the entries it added', async () => {
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    // install() first, so .claude exists; then splice in a user hook alongside
    // the one Forge just added, and uninstall must leave only the user's.
    await bridge.install()
    writeFileSync(
      join(worktree, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            ...(readSettings(worktree) as { hooks: { Stop: unknown[] } }).hooks.Stop,
            { hooks: [{ type: 'command', command: 'user-own-hook' }] },
          ],
        },
      }),
    )
    await bridge.uninstall()

    const settings = readSettings(worktree) as {
      hooks: { Stop: { hooks: { command: string }[] }[] }
    }
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe('user-own-hook')
  })
})

describe('ClaudeHookBridge.next', () => {
  it('resolves an event already logged before next() is called', async () => {
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    await bridge.install()

    const logPath = join(worktree, '.claude', 'forge-hooks.jsonl')
    appendFileSync(
      logPath,
      `${JSON.stringify({ kind: 'stop', raw: JSON.stringify({ last_assistant_message: 'hi' }) })}\n`,
    )

    const event = await bridge.next()
    expect(event.kind).toBe('stop')
    expect(event.lastAssistantMessage).toBe('hi')
  })

  it('resolves an event appended after next() is already waiting', async () => {
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    await bridge.install()

    const logPath = join(worktree, '.claude', 'forge-hooks.jsonl')
    const pending = bridge.next()

    await new Promise((r) => setTimeout(r, 100))
    appendFileSync(
      logPath,
      `${JSON.stringify({ kind: 'stop', raw: JSON.stringify({ last_assistant_message: 'late' }) })}\n`,
    )

    const event = await pending
    expect(event.lastAssistantMessage).toBe('late')
  })

  it('reports a payload that failed to parse rather than dropping the event', async () => {
    // The event still fired; that is a real signal even when its content is
    // unreadable. Silently dropping it would look identical to no event ever
    // having happened.
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    await bridge.install()

    const logPath = join(worktree, '.claude', 'forge-hooks.jsonl')
    appendFileSync(logPath, `${JSON.stringify({ kind: 'stop', raw: 'not json' })}\n`)

    const event = await bridge.next()
    expect(event.kind).toBe('stop')
    expect(event.lastAssistantMessage).toBeNull()
  })
})

describe('the generated command, executed for real', () => {
  it('appends the exact payload sent on stdin, including newlines', async () => {
    const { worktree, receiverDir } = makeWorktree()
    const bridge = new ClaudeHookBridge(worktree, { receiverDir })
    await bridge.install()

    const settings = readSettings(worktree) as {
      hooks: { Stop: { hooks: { command: string }[] }[] }
    }
    const command = (settings.hooks.Stop[0]?.hooks[0]?.command ?? '').replace(
      / __forge_hook_log__$/,
      '',
    )
    const payload = JSON.stringify({
      session_id: 'abc',
      last_assistant_message: 'line one\nline two',
    })

    // shell:true, not a manual cmd.exe/sh array: passing a full command string
    // as one argv element to `/c` is not the same as a shell parsing it, and
    // that mismatch produced a false failure the first time this was checked.
    execFileSync(command, { input: payload, encoding: 'utf8', shell: true })

    const event = await bridge.next()
    expect(event.kind).toBe('stop')
    expect(event.lastAssistantMessage).toBe('line one\nline two')
  })
})
