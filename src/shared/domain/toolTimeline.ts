import { z } from 'zod'
import { timestampSchema } from './ids'
import type { RuntimeEvent } from './runtime'

/**
 * Tool call entry representing an agent tool invocation during a step.
 *
 * Axiom A3 (Physical evidence beats claims):
 * A tool call is an agent claim about what it asked to do, NEVER verified physical evidence.
 * Rendering `Bash: npm test` proves the agent ran the command, not that it passed or that
 * the change is correct.
 * Therefore, `isVerifiedEvidence` is hardcoded to literal `false` at both runtime and type-level
 * so that tool timeline events can never be substituted for authoritative verification evidence.
 */
export const toolCallStatusSchema = z.enum(['running', 'completed', 'failed'])
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>

export const toolCallEntrySchema = z.strictObject({
  /** Stable unique identifier for the tool call item. */
  id: z.string().min(1),
  /** Workflow step index during which the tool call occurred. */
  stepIndex: z.number().int().nonnegative(),
  /** Graph node id if running within a generic workflow graph. */
  nodeId: z.string().nullable().default(null),
  /** Tool name (e.g. bash, edit_file, read_file). */
  name: z.string().min(1),
  /** The primary target of the tool (e.g. file path, command string, query). */
  target: z.string(),
  /** Full details or arguments reported with the tool invocation. */
  detail: z.string(),
  /** Timestamp when the tool call was initiated. */
  startedAt: timestampSchema,
  /** Timestamp when the tool completed or failed, or null if in progress. */
  finishedAt: timestampSchema.nullable().default(null),
  /** Execution status of the tool call. */
  status: toolCallStatusSchema,
  /** A tool call is an agent claim, never verified evidence (A3). */
  isVerifiedEvidence: z.literal(false),
})

export type ToolCallEntry = z.infer<typeof toolCallEntrySchema>

/**
 * Extracts a concise target from the tool name and detail string.
 * For example:
 * - JSON payload with path, file, cmd, command, or query
 * - Key-value prefix such as `path: foo/bar.ts`
 * - Fallback to trimmed detail
 */
export function extractToolTarget(_name: string, detail: string): string {
  const trimmed = detail.trim()
  if (!trimmed) return ''

  // Attempt JSON extraction if structured
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>
        if (typeof obj.path === 'string') return obj.path
        if (typeof obj.file === 'string') return obj.file
        if (typeof obj.command === 'string') return obj.command
        if (typeof obj.cmd === 'string') return obj.cmd
        if (typeof obj.query === 'string') return obj.query
        if (typeof obj.url === 'string') return obj.url
        if (typeof obj.target === 'string') return obj.target
      }
    } catch {
      // Fall through to pattern matching
    }
  }

  // Key-value prefix pattern (e.g. `path: "src/main.ts"` or `command: npm test`)
  const kvMatch = /^(?:path|file|command|cmd|query|url|target):\s*(.+)$/i.exec(trimmed)
  if (kvMatch?.[1]) {
    return kvMatch[1].replace(/^["']|["']$/g, '').trim()
  }

  return trimmed
}

/**
 * Pure reducer function that incorporates a new RuntimeEvent into an existing
 * tool call timeline.
 */
export function reduceToolTimeline(
  existing: readonly ToolCallEntry[],
  event: RuntimeEvent,
  stepIndex: number,
  nodeId?: string | null,
): readonly ToolCallEntry[] {
  if (event.type === 'tool') {
    // When a new tool starts, complete any prior running tool call in this step
    const updated = existing.map((entry) => {
      if (entry.status === 'running' && entry.stepIndex === stepIndex) {
        return {
          ...entry,
          status: 'completed' as const,
          finishedAt: entry.finishedAt ?? event.at,
        }
      }
      return entry
    })

    const target = extractToolTarget(event.name, event.detail)
    const newEntry: ToolCallEntry = {
      id: `tool-${String(stepIndex)}-${String(existing.length + 1)}-${event.at}`,
      stepIndex,
      nodeId: nodeId ?? null,
      name: event.name,
      target,
      detail: event.detail,
      startedAt: event.at,
      finishedAt: null,
      status: 'running',
      isVerifiedEvidence: false,
    }

    return [...updated, newEntry]
  }

  if (event.type === 'result') {
    // On successful step result, complete any open running tool call
    return existing.map((entry) => {
      if (entry.status === 'running' && entry.stepIndex === stepIndex) {
        return {
          ...entry,
          status: 'completed' as const,
          finishedAt: entry.finishedAt ?? event.at,
        }
      }
      return entry
    })
  }

  if (event.type === 'error') {
    // On step error, mark any open running tool call as failed
    return existing.map((entry) => {
      if (entry.status === 'running' && entry.stepIndex === stepIndex) {
        return {
          ...entry,
          status: 'failed' as const,
          finishedAt: entry.finishedAt ?? event.at,
        }
      }
      return entry
    })
  }

  if (event.type === 'state' && (event.state === 'cancelled' || event.state === 'failed')) {
    // On cancellation or failure state, mark any open running tool call as failed
    return existing.map((entry) => {
      if (entry.status === 'running' && entry.stepIndex === stepIndex) {
        return {
          ...entry,
          status: 'failed' as const,
          finishedAt: entry.finishedAt ?? event.at,
        }
      }
      return entry
    })
  }

  // Chunks, usage, and active state transitions do not mutate tool call items
  return existing
}

/**
 * Filter timeline entries for a specific step.
 */
export function filterToolTimelineByStep(
  timeline: readonly ToolCallEntry[],
  stepIndex: number,
): readonly ToolCallEntry[] {
  return timeline.filter((entry) => entry.stepIndex === stepIndex)
}

/**
 * Filter timeline entries for a specific workflow node.
 */
export function filterToolTimelineByNode(
  timeline: readonly ToolCallEntry[],
  nodeId: string,
): readonly ToolCallEntry[] {
  return timeline.filter((entry) => entry.nodeId === nodeId)
}
