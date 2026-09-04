import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Learns when a hosted turn ends from the CLI's own `Stop` hook, instead of
 * reading it off the screen.
 *
 * Four screen-scraping rules were tried and all four were wrong (see
 * `docs/CLI-FIELD-GUIDE.md` §9) — the CLI keeps painting startup noise for
 * seconds after the prompt box first appears, so anything keyed on "looks idle"
 * or "changed" fires before the turn has even begun.
 *
 * The `Stop` hook has none of that ambiguity. Measured against the real CLI:
 *
 * ```
 * Stop fired at              turn_started_ms + 6.8s
 * process actually exited at turn_started_ms + 12.5s   (-p mode; a hosted
 *                                                        session never exits)
 * payload.last_assistant_message  ===  the exact stdout text, byte for byte,
 *                                       multi-line preserved
 * ```
 *
 * So the payload is not just a timing signal — it carries the reply itself.
 * Reading the emulator's screen becomes unnecessary for the one thing it was
 * built to answer: "is the turn over, and what did the agent say".
 *
 * ```
 * write   a receiver script into userData, once
 * write   .claude/settings.local.json with a Stop (and PermissionRequest) hook
 *         that runs `node <receiver> <logPath> <kind>` for this worktree
 * watch   the log file; a line appearing IS the signal
 * ```
 *
 * The receiver is a real file on disk, not an inline `-e` string, and that was
 * not the first attempt. Two inline versions both broke on quoting, each a
 * different way:
 *
 * ```
 * v1  the log path as a JS string literal inside "-e \"...\""
 *     -> cmd.exe closed the outer quote at the path's own '"'
 *     -> "Unterminated string constant"
 * v2  a base64-encoded body inside "-e \"eval(Buffer.from('…','base64')…)\""
 *     -> the single quotes around 'base64'/'utf8' did not survive an
 *        intermediate shell layer -> "base64 is not defined"
 * ```
 *
 * Both failures were about characters a shell got to interpret before Node
 * did. A file removes the problem instead of routing around it: the command
 * line carries a script path and two plain arguments, nothing a shell treats
 * specially.
 *
 * A log file rather than a socket or IPC channel, because a hook command
 * cannot assume anything about how to reach a running Electron process — it
 * can always write a file, and that is the exact mechanism already verified
 * working end to end against the real CLI.
 */
export interface HookEvent {
  readonly kind: 'stop' | 'permission-request'
  readonly sessionId: string
  readonly lastAssistantMessage: string | null
  readonly toolName: string | null
}

/** The subset of a settings file Forge reads and writes; everything else survives untouched. */
interface ClaudeSettings {
  hooks?: Record<string, readonly HookSpec[]>
  [key: string]: unknown
}
interface HookSpec {
  hooks: readonly { type: 'command'; command: string }[]
}

const FORGE_HOOK_MARKER = '__forge_hook_log__'

/**
 * The receiver's source, as a string rather than a sibling `.mjs` file.
 *
 * A sibling file would need the bundler to copy a non-TypeScript asset into
 * the packaged app's `out/main`, which electron-vite does not do by default —
 * this module ships wherever the compiled code ships, with no separate build
 * step to keep in sync or forget.
 *
 * Deliberately minimal: read stdin, append one JSON line, exit. Anything more
 * is a place for the receiver itself to hang or throw inside a CLI's hook
 * runner, where Forge would never see the failure.
 */
const RECEIVER_SOURCE = [
  'const [, , logPath, kind] = process.argv',
  "let raw = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => { raw += chunk })",
  "process.stdin.on('end', () => {",
  "  const line = JSON.stringify({ kind, at: Date.now(), raw }) + '\\n'",
  "  require('fs').appendFileSync(logPath, line)",
  '})',
].join('\n')

export interface ClaudeHookBridgeOptions {
  /** Where the receiver script is written. One copy serves every worktree. */
  readonly receiverDir: string
}

export class ClaudeHookBridge {
  private readonly logPath: string
  private readonly receiverPath: string
  private watcher: FSWatcher | null = null
  private readOffset = 0

  constructor(
    private readonly worktreePath: string,
    options: ClaudeHookBridgeOptions,
  ) {
    this.logPath = join(worktreePath, '.claude', 'forge-hooks.jsonl')
    this.receiverPath = join(options.receiverDir, 'forge-hook-receiver.cjs')
  }

  /**
   * Installs Forge's hooks into the worktree's own settings, merged with
   * whatever is already there.
   *
   * Merge, never replace. This file can carry a user's own hooks, permissions,
   * and MCP configuration, and a blind write would destroy them. Forge's own
   * entries are tagged with `FORGE_HOOK_MARKER` in the command string so a
   * later `uninstall` removes only what it added.
   */
  async install(): Promise<void> {
    const settingsPath = join(this.worktreePath, '.claude', 'settings.local.json')
    await mkdir(dirname(settingsPath), { recursive: true })
    await mkdir(dirname(this.logPath), { recursive: true })
    await mkdir(dirname(this.receiverPath), { recursive: true })
    await writeFile(this.logPath, '', 'utf8')
    await writeFile(this.receiverPath, RECEIVER_SOURCE, 'utf8')

    let settings: ClaudeSettings = {}
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as ClaudeSettings
    } catch {
      // Absent or unreadable: nothing to merge into, start fresh.
    }

    const command = (kind: HookEvent['kind']): string =>
      // Quoted because a Windows path can contain spaces; nothing else in
      // either argument needs it, and neither argument is script text a shell
      // could misparse — they are opaque strings the receiver reads by index.
      `node "${this.receiverPath}" "${this.logPath}" ${kind} ${FORGE_HOOK_MARKER}`

    const hooks = { ...settings.hooks }
    hooks.Stop = [
      ...withoutForgeEntries(hooks.Stop),
      { hooks: [{ type: 'command', command: command('stop') }] },
    ]
    hooks.PermissionRequest = [
      ...withoutForgeEntries(hooks.PermissionRequest),
      { hooks: [{ type: 'command', command: command('permission-request') }] },
    ]

    const merged: ClaudeSettings = { ...settings, hooks }
    const temp = `${settingsPath}.forge-${String(process.pid)}`
    await writeFile(temp, JSON.stringify(merged, null, 2), 'utf8')
    await rename(temp, settingsPath)
  }

  /**
   * Removes only the hook entries Forge added, leaving anything the user
   * configured themselves untouched.
   */
  async uninstall(): Promise<void> {
    const settingsPath = join(this.worktreePath, '.claude', 'settings.local.json')

    let settings: ClaudeSettings
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8')) as ClaudeSettings
    } catch {
      return
    }

    const hooks: Record<string, readonly HookSpec[]> = {}
    for (const [event, specs] of Object.entries(settings.hooks ?? {})) {
      if (event !== 'Stop' && event !== 'PermissionRequest') {
        hooks[event] = specs
        continue
      }
      const remaining = withoutForgeEntries(specs)
      if (remaining.length > 0) hooks[event] = remaining
    }

    const merged: ClaudeSettings = { ...settings, hooks }
    const temp = `${settingsPath}.forge-${String(process.pid)}`
    await writeFile(temp, JSON.stringify(merged, null, 2), 'utf8')
    await rename(temp, settingsPath)
  }

  /**
   * Resolves the next hook event for this worktree.
   *
   * Watches the log file rather than polling it: a hook append is a single
   * atomic write, and `fs.watch`'s `change` event fires reliably for that on
   * both platforms this runs on.
   */
  async next(): Promise<HookEvent> {
    const existing = await this.readNewLines()
    if (existing !== null) return existing

    return new Promise((resolve, reject) => {
      this.watcher = watch(this.logPath, { persistent: false }, (eventType) => {
        if (eventType !== 'change') return
        void this.readNewLines().then((event) => {
          if (event === null) return
          this.watcher?.close()
          this.watcher = null
          resolve(event)
        }, reject)
      })
    })
  }

  /** Stops watching. Safe to call even when nothing is watching. */
  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private async readNewLines(): Promise<HookEvent | null> {
    let content: string
    try {
      content = await readFile(this.logPath, 'utf8')
    } catch {
      return null
    }

    const added = content.slice(this.readOffset)
    if (added.trim() === '') return null
    this.readOffset = content.length

    const line = added.trim().split('\n').at(-1)
    if (line === undefined) return null

    return parseHookLine(line)
  }
}

function withoutForgeEntries(specs: readonly HookSpec[] | undefined): readonly HookSpec[] {
  if (specs === undefined) return []
  return specs.filter((spec) => !spec.hooks.some((h) => h.command.includes(FORGE_HOOK_MARKER)))
}

/**
 * Parses one appended log line into a `HookEvent`.
 *
 * The receiver wraps the CLI's raw stdin JSON in `{kind, at, raw}`; this
 * unwraps `raw` and pulls out the two fields Forge actually needs. Any other
 * field in the payload (transcript path, effort level, background tasks) is
 * left alone rather than modelled, because nothing here reads it yet.
 */
interface RawHookPayload {
  session_id?: unknown
  last_assistant_message?: unknown
  tool_name?: unknown
}

function parseHookLine(line: string): HookEvent {
  const outer = JSON.parse(line) as { kind: HookEvent['kind']; raw: string }
  let inner: RawHookPayload = {}
  try {
    inner = JSON.parse(outer.raw) as RawHookPayload
  } catch {
    // A hook payload that fails to parse is still a signal that the event
    // fired; report it with nothing extracted rather than dropping it.
  }

  return {
    kind: outer.kind,
    sessionId: typeof inner.session_id === 'string' ? inner.session_id : '',
    lastAssistantMessage:
      typeof inner.last_assistant_message === 'string' ? inner.last_assistant_message : null,
    toolName: typeof inner.tool_name === 'string' ? inner.tool_name : null,
  }
}
