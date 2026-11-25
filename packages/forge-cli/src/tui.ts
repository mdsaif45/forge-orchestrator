/**
 * CLI-004: Interactive Terminal TUI for Live CLI Monitoring and Diff Rendering.
 *
 * Renders a responsive multi-pane terminal dashboard (Execution Status, Tool-Call
 * Timeline, and Diff Inspector) using standard ANSI escape/cursor controls, integrates
 * with DirectTaskEvent / NDJSON event buses, degrades cleanly in non-TTY environments,
 * and restores terminal state gracefully on SIGINT / Ctrl+C across Windows and Unix.
 */

import type { DirectTaskEvent } from '@forge/core/core/taskRunner'
import { ChangesetChunkAnsiHighlighter } from '@forge/core/evidence'

export const ANSI_ENTER_ALT_SCREEN = '\x1b[?1049h'
export const ANSI_EXIT_ALT_SCREEN = '\x1b[?1049l'
export const ANSI_HIDE_CURSOR = '\x1b[?25l'
export const ANSI_SHOW_CURSOR = '\x1b[?25h'
export const ANSI_CLEAR_SCREEN = '\x1b[2J'
export const ANSI_CURSOR_HOME = '\x1b[H'
export const ANSI_RESET = '\x1b[0m'
export const ANSI_BOLD = '\x1b[1m'
export const ANSI_DIM = '\x1b[90m'
export const ANSI_CYAN = '\x1b[36m'
export const ANSI_GREEN = '\x1b[32m'
export const ANSI_RED = '\x1b[31m'
export const ANSI_YELLOW = '\x1b[33m'
export const ANSI_MAGENTA = '\x1b[35m'

export type TuiPaneId = 'STATUS' | 'TIMELINE' | 'DIFF'

export type TuiRunState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ABORTED'

export type TuiExitReason = 'user_quit' | 'sigint' | 'completed'

export interface TuiTimelineEntry {
  readonly entryId: string
  readonly timestamp: number
  readonly kind: DirectTaskEvent['kind'] | 'diff' | 'system'
  readonly summary: string
  readonly detail?: string | undefined
  readonly ok?: boolean | undefined
}

export interface TuiExecutionStatus {
  readonly runId: string
  readonly objective: string
  readonly state: TuiRunState
  readonly branch?: string | undefined
  readonly model?: string | undefined
  readonly startedAt: number
  readonly completedAt?: number | undefined
  readonly toolCallsTotal: number
  readonly toolCallsSucceeded: number
  readonly toolCallsFailed: number
  readonly verificationVerdict?: string | undefined
}

export interface TuiSnapshot {
  readonly status: TuiExecutionStatus
  readonly focusedPane: TuiPaneId
  readonly scrollOffsets: Readonly<Record<TuiPaneId, number>>
  readonly timelineCount: number
  readonly diffStats: {
    readonly filePath?: string | undefined
    readonly additions: number
    readonly deletions: number
    readonly hunks: number
  }
  readonly active: boolean
  readonly ttyMode: boolean
  readonly exitReason?: TuiExitReason | undefined
}

export interface TuiOutputWriter {
  write(chunk: string): void
}

export interface TuiSignalSource {
  on(event: 'SIGINT', listener: () => void): void
  off(event: 'SIGINT', listener: () => void): void
}

export interface InteractiveTuiOptions {
  readonly runId?: string | undefined
  readonly objective?: string | undefined
  readonly state?: TuiRunState | undefined
  readonly branch?: string | undefined
  readonly model?: string | undefined
  readonly columns?: number | undefined
  readonly rows?: number | undefined
  readonly isTTY?: boolean | undefined
  readonly useAltScreen?: boolean | undefined
  readonly unicodeBorders?: boolean | undefined
  readonly initialDiff?: string | undefined
  readonly output?: TuiOutputWriter | undefined
  readonly signalSource?: TuiSignalSource | undefined
  readonly onExit?: ((reason: TuiExitReason) => void) | undefined
}

interface NdjsonEnvelope {
  readonly kind?: string | undefined
  readonly text?: string | undefined
  readonly name?: string | undefined
  readonly detail?: string | undefined
  readonly ok?: boolean | undefined
  readonly verdict?: string | undefined
  readonly patch?: string | undefined
  readonly state?: TuiRunState | undefined
}

const PANE_ORDER: readonly TuiPaneId[] = ['STATUS', 'TIMELINE', 'DIFF']

function clampWidth(rawWidth: number | undefined): number {
  const width = rawWidth ?? 96
  return Math.max(60, Math.min(200, width))
}

function clampRows(rawRows: number | undefined): number {
  const rows = rawRows ?? 30
  return Math.max(18, Math.min(120, rows))
}

function visibleLength(text: string): number {
  return ChangesetChunkAnsiHighlighter.stripAnsi(text).length
}

function truncateVisible(text: string, maxWidth: number, colorEnabled: boolean): string {
  const stripped = ChangesetChunkAnsiHighlighter.stripAnsi(text)
  if (stripped.length <= maxWidth) {
    return text
  }
  const safeLen = Math.max(1, maxWidth - 1)
  // Slice plain text when overflowing so ANSI sequences cannot be cut mid-escape
  const clipped = `${stripped.slice(0, safeLen)}…`
  return colorEnabled ? `${clipped}${ANSI_RESET}` : clipped
}

function padRightVisible(text: string, targetWidth: number, colorEnabled: boolean): string {
  const truncated = truncateVisible(text, targetWidth, colorEnabled)
  const len = visibleLength(truncated)
  const pad = Math.max(0, targetWidth - len)
  return `${truncated}${' '.repeat(pad)}`
}

export class InteractiveTerminalTui {
  private readonly isTTY: boolean
  private readonly useAltScreen: boolean
  private readonly unicodeBorders: boolean
  private readonly columns: number
  private readonly rows: number
  private readonly output: TuiOutputWriter
  private readonly signalSource: TuiSignalSource | undefined
  private readonly onExit?: ((reason: TuiExitReason) => void) | undefined
  private readonly diffHighlighter = new ChangesetChunkAnsiHighlighter()

  private status: TuiExecutionStatus
  private focusedPane: TuiPaneId = 'TIMELINE'
  private readonly scrollOffsets: Record<TuiPaneId, number> = {
    STATUS: 0,
    TIMELINE: 0,
    DIFF: 0,
  }
  private readonly timeline: TuiTimelineEntry[] = []
  private rawDiff = ''
  private active = false
  private altScreenEntered = false
  private exitReason?: TuiExitReason | undefined
  private readonly sigintHandler: () => void

  constructor(options: InteractiveTuiOptions = {}) {
    this.isTTY = options.isTTY ?? process.stdout.isTTY
    this.useAltScreen = options.useAltScreen ?? true
    this.unicodeBorders = options.unicodeBorders ?? true
    this.columns = clampWidth(options.columns ?? process.stdout.columns)
    this.rows = clampRows(options.rows ?? process.stdout.rows)
    this.output = options.output ?? {
      write: (chunk: string) => {
        process.stdout.write(chunk)
      },
    }
    this.signalSource = options.signalSource ?? process
    this.onExit = options.onExit

    this.status = {
      runId: options.runId ?? 'live-session',
      objective: options.objective ?? 'Interactive Forge Control Plane Monitor',
      state: options.state ?? 'IDLE',
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      startedAt: Date.now(),
      toolCallsTotal: 0,
      toolCallsSucceeded: 0,
      toolCallsFailed: 0,
    }

    if (options.initialDiff) {
      this.rawDiff = options.initialDiff
    }

    this.sigintHandler = () => {
      this.stop('sigint')
    }
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.exitReason = undefined
    if (this.status.state === 'IDLE') {
      this.status = { ...this.status, state: 'RUNNING' }
    }

    if (this.isTTY && this.useAltScreen) {
      this.output.write(`${ANSI_ENTER_ALT_SCREEN}${ANSI_HIDE_CURSOR}`)
      this.altScreenEntered = true
    }

    this.signalSource?.on('SIGINT', this.sigintHandler)
    this.render()
  }

  stop(reason: TuiExitReason = 'completed'): void {
    if (!this.active && this.exitReason !== undefined) {
      return
    }
    this.active = false
    this.exitReason = reason

    if (reason === 'sigint' && this.status.state === 'RUNNING') {
      this.status = { ...this.status, state: 'ABORTED', completedAt: Date.now() }
    } else if (reason === 'completed' && this.status.state === 'RUNNING') {
      this.status = { ...this.status, state: 'COMPLETED', completedAt: Date.now() }
    }

    this.signalSource?.off('SIGINT', this.sigintHandler)

    if (this.altScreenEntered) {
      this.output.write(`${ANSI_RESET}${ANSI_SHOW_CURSOR}${ANSI_EXIT_ALT_SCREEN}`)
      this.altScreenEntered = false
    }

    this.onExit?.(reason)
  }

  updateStatus(patch: Partial<TuiExecutionStatus>): void {
    this.status = { ...this.status, ...patch }
  }

  updateDiff(rawDiff: string): void {
    this.rawDiff = rawDiff
  }

  ingestEvent(event: DirectTaskEvent): void {
    const timestamp = Date.now()
    const entryId = `ev-${String(timestamp)}-${String(this.timeline.length + 1)}`

    switch (event.kind) {
      case 'status':
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'status',
          summary: event.text,
        })
        break
      case 'tool_start':
        this.status = {
          ...this.status,
          state: 'RUNNING',
          toolCallsTotal: this.status.toolCallsTotal + 1,
        }
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'tool_start',
          summary: `Tool start: ${event.name}`,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        })
        break
      case 'tool_end':
        this.status = {
          ...this.status,
          toolCallsSucceeded: this.status.toolCallsSucceeded + (event.ok ? 1 : 0),
          toolCallsFailed: this.status.toolCallsFailed + (event.ok ? 0 : 1),
        }
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'tool_end',
          summary: `Tool ${event.ok ? 'succeeded' : 'failed'}: ${event.name}`,
          ok: event.ok,
        })
        break
      case 'reasoning':
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'reasoning',
          summary: event.text,
        })
        break
      case 'content':
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'content',
          summary: event.text.trim() || '(content chunk)',
        })
        break
      case 'discrepancy':
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'discrepancy',
          summary: `Discrepancy: ${event.detail}`,
          ok: false,
        })
        break
      case 'verification':
        this.status = {
          ...this.status,
          verificationVerdict: event.verdict,
          state: event.verdict === 'pass' ? 'COMPLETED' : 'FAILED',
        }
        this.timeline.push({
          entryId,
          timestamp,
          kind: 'verification',
          summary: `Verification (${event.verdict}): ${event.detail}`,
          ok: event.verdict === 'pass',
        })
        break
    }
  }

  /**
   * Parses a single NDJSON line from headless event streaming (--json bus) and updates
   * TUI state, timeline, or diff inspector without throwing on malformed records.
   */
  ingestNdjsonLine(rawLine: string): boolean {
    const trimmed = rawLine.trim()
    if (!trimmed) return false

    let parsed: NdjsonEnvelope
    try {
      parsed = JSON.parse(trimmed) as NdjsonEnvelope
    } catch {
      return false
    }

    if (typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
      return false
    }

    if (parsed.kind === 'diff' && typeof parsed.patch === 'string') {
      this.updateDiff(parsed.patch)
      this.timeline.push({
        entryId: `ev-${String(Date.now())}-${String(this.timeline.length + 1)}`,
        timestamp: Date.now(),
        kind: 'diff',
        summary: 'Updated live changeset diff',
      })
      return true
    }

    switch (parsed.kind) {
      case 'status':
      case 'reasoning':
      case 'content':
        if (typeof parsed.text === 'string') {
          this.ingestEvent({ kind: parsed.kind, text: parsed.text })
          return true
        }
        return false
      case 'tool_start':
        if (typeof parsed.name === 'string') {
          this.ingestEvent({
            kind: 'tool_start',
            name: parsed.name,
            ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
          })
          return true
        }
        return false
      case 'tool_end':
        if (typeof parsed.name === 'string') {
          this.ingestEvent({
            kind: 'tool_end',
            name: parsed.name,
            ok: Boolean(parsed.ok),
          })
          return true
        }
        return false
      case 'discrepancy':
        if (typeof parsed.detail === 'string') {
          this.ingestEvent({ kind: 'discrepancy', detail: parsed.detail })
          return true
        }
        return false
      case 'verification':
        if (typeof parsed.verdict === 'string' && typeof parsed.detail === 'string') {
          this.ingestEvent({
            kind: 'verification',
            verdict: parsed.verdict,
            detail: parsed.detail,
          })
          return true
        }
        return false
      default:
        return false
    }
  }

  ingestNdjsonStream(chunk: string): number {
    let accepted = 0
    for (const line of chunk.split(/\r?\n/)) {
      if (this.ingestNdjsonLine(line)) {
        accepted += 1
      }
    }
    return accepted
  }

  handleKeyInput(key: string): void {
    if (key === '\x03') {
      this.stop('sigint')
      return
    }
    if (key === 'q' || key === 'Q') {
      this.stop('user_quit')
      return
    }
    if (key === '\t') {
      const idx = PANE_ORDER.indexOf(this.focusedPane)
      const next = PANE_ORDER[(idx + 1) % PANE_ORDER.length]
      if (next) this.focusedPane = next
      if (this.active) this.render()
      return
    }
    if (key === '1') {
      this.focusedPane = 'STATUS'
      if (this.active) this.render()
      return
    }
    if (key === '2') {
      this.focusedPane = 'TIMELINE'
      if (this.active) this.render()
      return
    }
    if (key === '3') {
      this.focusedPane = 'DIFF'
      if (this.active) this.render()
      return
    }
    if (key === 'j' || key === '\x1b[B') {
      this.scrollOffsets[this.focusedPane] += 1
      if (this.active) this.render()
      return
    }
    if (key === 'k' || key === '\x1b[A') {
      this.scrollOffsets[this.focusedPane] = Math.max(0, this.scrollOffsets[this.focusedPane] - 1)
      if (this.active) this.render()
    }
  }

  renderFrame(): string {
    const color = this.isTTY
    const innerWidth = this.columns - 2
    const box = this.unicodeBorders
      ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ml: '├', mr: '┤' }
      : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ml: '+', mr: '+' }

    const topBorder = `${box.tl}${box.h.repeat(innerWidth)}${box.tr}`
    const midBorder = `${box.ml}${box.h.repeat(innerWidth)}${box.mr}`
    const bottomBorder = `${box.bl}${box.h.repeat(innerWidth)}${box.br}`

    const wrapRow = (content: string): string =>
      `${box.v} ${padRightVisible(content, innerWidth - 2, color)} ${box.v}`

    const formatPaneHeader = (pane: TuiPaneId, title: string, extra = ''): string => {
      const marker = this.focusedPane === pane ? '*' : ' '
      const base = `[${marker}] ${title}${extra ? `  ${extra}` : ''}`
      if (!color) return base
      const accent = this.focusedPane === pane ? ANSI_CYAN : ANSI_DIM
      return `${ANSI_BOLD}${accent}${base}${ANSI_RESET}`
    }

    const lines: string[] = [topBorder]

    // 1. Execution Status Pane
    lines.push(wrapRow(formatPaneHeader('STATUS', 'EXECUTION STATUS', `Run: ${this.status.runId}`)))
    const stateColor =
      this.status.state === 'COMPLETED'
        ? ANSI_GREEN
        : this.status.state === 'FAILED' || this.status.state === 'ABORTED'
          ? ANSI_RED
          : ANSI_YELLOW
    const stateBadge = color ? `${stateColor}${this.status.state}${ANSI_RESET}` : this.status.state
    const metaParts = [
      `State: ${stateBadge}`,
      `Tools: ${String(this.status.toolCallsSucceeded)}/${String(this.status.toolCallsTotal)} ok`,
    ]
    if (this.status.branch) metaParts.push(`Branch: ${this.status.branch}`)
    if (this.status.model) metaParts.push(`Model: ${this.status.model}`)
    if (this.status.verificationVerdict) {
      metaParts.push(`Verify: ${this.status.verificationVerdict}`)
    }
    lines.push(wrapRow(`Objective: ${this.status.objective}`))
    lines.push(wrapRow(metaParts.join('  |  ')))

    lines.push(midBorder)

    // Allocate vertical budget across Timeline and Diff panes cleanly
    const availableBodyRows = Math.max(6, this.rows - 11)
    const timelineMaxRows = Math.max(3, Math.floor(availableBodyRows * 0.45))
    const diffMaxRows = Math.max(3, availableBodyRows - timelineMaxRows)

    // 2. Timeline Pane
    lines.push(
      wrapRow(
        formatPaneHeader('TIMELINE', 'LIVE TIMELINE', `(${String(this.timeline.length)} events)`),
      ),
    )
    if (this.timeline.length === 0) {
      lines.push(wrapRow('No execution events recorded yet. Streaming ready.'))
    } else {
      const startIdx = Math.min(
        this.scrollOffsets.TIMELINE,
        Math.max(0, this.timeline.length - timelineMaxRows),
      )
      const slice = this.timeline.slice(startIdx, startIdx + timelineMaxRows)
      for (const entry of slice) {
        const icon = this.formatTimelineIcon(entry, color)
        const suffix = entry.detail ? ` — ${entry.detail}` : ''
        lines.push(wrapRow(`${icon} [${entry.kind}] ${entry.summary}${suffix}`))
      }
    }

    lines.push(midBorder)

    // 3. Diff Inspector Pane (reusing ChangesetChunkAnsiHighlighter)
    const diffReport = this.diffHighlighter.highlight(this.rawDiff, {
      colorEnabled: color,
      includeLineNumbers: true,
    })
    const diffExtra = `+${String(diffReport.additionsCount)} / -${String(diffReport.deletionsCount)} (${diffReport.filePath ?? 'workspace'})`
    lines.push(wrapRow(formatPaneHeader('DIFF', 'DIFF INSPECTOR', diffExtra)))

    if (diffReport.linesCount === 0) {
      lines.push(wrapRow('Working tree clean — zero pending diff hunks.'))
    } else {
      const diffStart = Math.min(
        this.scrollOffsets.DIFF,
        Math.max(0, diffReport.lines.length - diffMaxRows),
      )
      const diffSlice = diffReport.lines.slice(diffStart, diffStart + diffMaxRows)
      for (const line of diffSlice) {
        lines.push(wrapRow(color ? line.ansiContent : line.cleanContent))
      }
    }

    lines.push(midBorder)

    // Footer controls
    const footer = this.isTTY
      ? 'Keys: [Tab / 1-3] Focus Pane  [j/k / Arrows] Scroll  [q / Ctrl+C] Exit'
      : 'Non-TTY Fallback View (static snapshot rendered cleanly without cursor escapes)'
    lines.push(wrapRow(color ? `${ANSI_DIM}${footer}${ANSI_RESET}` : footer))
    lines.push(bottomBorder)

    return `${lines.join('\n')}\n`
  }

  render(): string {
    const frame = this.renderFrame()
    if (this.isTTY && this.useAltScreen) {
      this.output.write(`${ANSI_CURSOR_HOME}${ANSI_CLEAR_SCREEN}${frame}`)
    } else {
      this.output.write(frame)
    }
    return frame
  }

  getSnapshot(): TuiSnapshot {
    const diffReport = this.diffHighlighter.highlight(this.rawDiff, {
      colorEnabled: false,
      includeLineNumbers: false,
    })
    return {
      status: { ...this.status },
      focusedPane: this.focusedPane,
      scrollOffsets: { ...this.scrollOffsets },
      timelineCount: this.timeline.length,
      diffStats: {
        ...(diffReport.filePath !== undefined ? { filePath: diffReport.filePath } : {}),
        additions: diffReport.additionsCount,
        deletions: diffReport.deletionsCount,
        hunks: diffReport.hunksCount,
      },
      active: this.active,
      ttyMode: this.isTTY,
      ...(this.exitReason !== undefined ? { exitReason: this.exitReason } : {}),
    }
  }

  private formatTimelineIcon(entry: TuiTimelineEntry, color: boolean): string {
    if (entry.kind === 'tool_end') {
      if (entry.ok) return color ? `${ANSI_GREEN}✓${ANSI_RESET}` : '✓'
      return color ? `${ANSI_RED}✗${ANSI_RESET}` : '✗'
    }
    if (entry.kind === 'tool_start') return color ? `${ANSI_CYAN}⚙${ANSI_RESET}` : '*'
    if (entry.kind === 'reasoning') return color ? `${ANSI_MAGENTA}▸${ANSI_RESET}` : '>'
    if (entry.kind === 'discrepancy') return color ? `${ANSI_YELLOW}!${ANSI_RESET}` : '!'
    if (entry.kind === 'verification') {
      return entry.ok
        ? color
          ? `${ANSI_GREEN}✓${ANSI_RESET}`
          : '✓'
        : color
          ? `${ANSI_RED}✗${ANSI_RESET}`
          : '✗'
    }
    return color ? `${ANSI_DIM}•${ANSI_RESET}` : '-'
  }
}
