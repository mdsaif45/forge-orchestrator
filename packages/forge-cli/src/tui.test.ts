import { describe, expect, it, vi } from 'vitest'
import {
  ANSI_CLEAR_SCREEN,
  ANSI_ENTER_ALT_SCREEN,
  ANSI_EXIT_ALT_SCREEN,
  ANSI_HIDE_CURSOR,
  ANSI_SHOW_CURSOR,
  InteractiveTerminalTui,
  type TuiExitReason,
  type TuiSignalSource,
} from './tui'

const SAMPLE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,4 +10,5 @@',
  ' export function verifyToken(token: string): boolean {',
  '-  return token.length > 0',
  '+  if (!token) return false',
  '+  return token.startsWith("forge_")',
  ' }',
].join('\n')

function createMockSignalSource(): {
  source: TuiSignalSource
  emitSigint: () => void
  listenerCount: () => number
} {
  const listeners = new Set<() => void>()
  return {
    source: {
      on: (_event, fn) => {
        listeners.add(fn)
      },
      off: (_event, fn) => {
        listeners.delete(fn)
      },
    },
    emitSigint: () => {
      for (const fn of [...listeners]) {
        fn()
      }
    },
    listenerCount: () => listeners.size,
  }
}

describe('InteractiveTerminalTui (CLI-004)', () => {
  it('renders multi-pane ANSI layout with status, timeline, and highlighted diff in TTY mode', () => {
    const chunks: string[] = []
    const sig = createMockSignalSource()

    const tui = new InteractiveTerminalTui({
      runId: 'run-tui-1',
      objective: 'Implement zero-trust sandbox',
      branch: 'feat/sandbox',
      model: 'claude-3-7-sonnet',
      columns: 100,
      rows: 28,
      isTTY: true,
      initialDiff: SAMPLE_DIFF,
      output: { write: (c) => chunks.push(c) },
      signalSource: sig.source,
    })

    tui.start()
    tui.ingestEvent({ kind: 'status', text: 'Scanning workspace' })
    tui.ingestEvent({ kind: 'tool_start', name: 'read_file', detail: 'src/auth.ts' })
    tui.ingestEvent({ kind: 'tool_end', name: 'read_file', ok: true })
    tui.ingestEvent({ kind: 'verification', verdict: 'pass', detail: '12/12 tests passed' })

    const frame = tui.render()
    const combined = chunks.join('')

    expect(combined).toContain(ANSI_ENTER_ALT_SCREEN)
    expect(combined).toContain(ANSI_HIDE_CURSOR)
    expect(combined).toContain(ANSI_CLEAR_SCREEN)

    expect(frame).toContain('EXECUTION STATUS')
    expect(frame).toContain('Run: run-tui-1')
    expect(frame).toContain('Implement zero-trust sandbox')
    expect(frame).toContain('LIVE TIMELINE')
    expect(frame).toContain('read_file')
    expect(frame).toContain('DIFF INSPECTOR')
    expect(frame).toContain('+2 / -1 (src/auth.ts)')
    expect(frame).toContain('Keys: [Tab / 1-3] Focus Pane')

    const snap = tui.getSnapshot()
    expect(snap.status.state).toBe('COMPLETED')
    expect(snap.status.toolCallsTotal).toBe(1)
    expect(snap.status.toolCallsSucceeded).toBe(1)
    expect(snap.diffStats.additions).toBe(2)
    expect(snap.diffStats.deletions).toBe(1)

    tui.stop('user_quit')
    expect(chunks.join('')).toContain(`${ANSI_SHOW_CURSOR}${ANSI_EXIT_ALT_SCREEN}`)
    expect(sig.listenerCount()).toBe(0)
  })

  it('degrades cleanly in non-TTY fallback mode without ANSI escape sequences', () => {
    const chunks: string[] = []
    const sig = createMockSignalSource()

    const tui = new InteractiveTerminalTui({
      runId: 'run-nontty',
      objective: 'CI headless run monitor',
      columns: 90,
      rows: 26,
      isTTY: false,
      initialDiff: SAMPLE_DIFF,
      output: { write: (c) => chunks.push(c) },
      signalSource: sig.source,
    })

    tui.start()
    const frame = tui.render()
    const allOutput = chunks.join('')

    expect(allOutput).not.toContain(ANSI_ENTER_ALT_SCREEN)
    expect(allOutput).not.toContain(ANSI_HIDE_CURSOR)
    expect(allOutput).not.toContain(ANSI_CLEAR_SCREEN)
    expect(allOutput).not.toContain('\x1b[')
    expect(frame).toContain('Non-TTY Fallback View')
    expect(frame).toContain('CI headless run monitor')
    expect(frame).toContain('+2 / -1 (src/auth.ts)')

    tui.stop('completed')
  })

  it('ingests NDJSON event streams seamlessly and tolerates malformed frames', () => {
    const tui = new InteractiveTerminalTui({ isTTY: false })
    const ndjsonPayload = [
      '{"kind":"status","text":"Booting agent"}',
      '',
      '{not-valid-json',
      '{"kind":"tool_start","name":"run_command","detail":"vitest"}',
      '{"kind":"tool_end","name":"run_command","ok":true}',
      '{"kind":"discrepancy","detail":"Flaky snapshot hash"}',
      JSON.stringify({ kind: 'diff', patch: SAMPLE_DIFF }),
    ].join('\n')

    const accepted = tui.ingestNdjsonStream(ndjsonPayload)
    expect(accepted).toBe(5)

    const snap = tui.getSnapshot()
    expect(snap.timelineCount).toBe(5)
    expect(snap.status.toolCallsTotal).toBe(1)
    expect(snap.status.toolCallsSucceeded).toBe(1)
    expect(snap.diffStats.additions).toBe(2)
    expect(snap.diffStats.deletions).toBe(1)
  })

  it('supports interactive keyboard pane switching, scrolling, and graceful SIGINT / Ctrl+C exit', () => {
    const chunks: string[] = []
    const sig = createMockSignalSource()
    const onExit = vi.fn<(reason: TuiExitReason) => void>()

    const tui = new InteractiveTerminalTui({
      isTTY: true,
      output: { write: (c) => chunks.push(c) },
      signalSource: sig.source,
      onExit,
    })

    tui.start()
    expect(sig.listenerCount()).toBe(1)
    expect(tui.getSnapshot().focusedPane).toBe('TIMELINE')

    // Tab switches to DIFF -> Tab to STATUS -> '3' focuses DIFF
    tui.handleKeyInput('\t')
    expect(tui.getSnapshot().focusedPane).toBe('DIFF')
    tui.handleKeyInput('\t')
    expect(tui.getSnapshot().focusedPane).toBe('STATUS')
    tui.handleKeyInput('3')
    expect(tui.getSnapshot().focusedPane).toBe('DIFF')

    // Scroll down/up on focused pane
    tui.handleKeyInput('j')
    tui.handleKeyInput('\x1b[B')
    expect(tui.getSnapshot().scrollOffsets.DIFF).toBe(2)
    tui.handleKeyInput('k')
    expect(tui.getSnapshot().scrollOffsets.DIFF).toBe(1)

    // SIGINT triggers clean teardown, cursor restoration, alt-screen exit, and detaches signal handler
    sig.emitSigint()
    expect(onExit).toHaveBeenCalledWith('sigint')
    expect(tui.getSnapshot().active).toBe(false)
    expect(tui.getSnapshot().status.state).toBe('ABORTED')
    expect(tui.getSnapshot().exitReason).toBe('sigint')
    expect(sig.listenerCount()).toBe(0)
    expect(chunks.join('')).toContain(`${ANSI_SHOW_CURSOR}${ANSI_EXIT_ALT_SCREEN}`)

    // Ctrl+C test on fresh instance
    const ctrlCTui = new InteractiveTerminalTui({
      isTTY: true,
      output: { write: () => undefined },
      signalSource: sig.source,
      onExit,
    })
    ctrlCTui.start()
    ctrlCTui.handleKeyInput('\x03')
    expect(ctrlCTui.getSnapshot().exitReason).toBe('sigint')
    expect(sig.listenerCount()).toBe(0)
  })
})
