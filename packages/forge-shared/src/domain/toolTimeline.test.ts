import { describe, expect, it } from 'vitest'
import {
  extractToolTarget,
  filterToolTimelineByNode,
  filterToolTimelineByStep,
  reduceToolTimeline,
  toolCallEntrySchema,
  type ToolCallEntry,
} from './toolTimeline'
import type { RuntimeEvent } from './runtime'

const T1 = '2026-11-18T10:00:00.000Z'
const T2 = '2026-11-18T10:00:05.000Z'
const T3 = '2026-11-18T10:00:10.000Z'

describe('toolTimeline', () => {
  describe('extractToolTarget', () => {
    it('extracts targets from structured JSON details', () => {
      expect(extractToolTarget('read_file', '{"path": "src/main.ts"}')).toBe('src/main.ts')
      expect(extractToolTarget('write_file', '{"file": "README.md"}')).toBe('README.md')
      expect(extractToolTarget('bash', '{"command": "npm test"}')).toBe('npm test')
      expect(extractToolTarget('terminal', '{"cmd": "git status"}')).toBe('git status')
      expect(extractToolTarget('search', '{"query": "reduceToolTimeline"}')).toBe(
        'reduceToolTimeline',
      )
      expect(extractToolTarget('browser', '{"url": "https://localhost:3000"}')).toBe(
        'https://localhost:3000',
      )
      expect(extractToolTarget('action', '{"target": "deploy-btn"}')).toBe('deploy-btn')
    })

    it('extracts targets from key-value prefix strings', () => {
      expect(extractToolTarget('read_file', 'path: src/index.ts')).toBe('src/index.ts')
      expect(extractToolTarget('read_file', 'path: "src/quoted.ts"')).toBe('src/quoted.ts')
      expect(extractToolTarget('bash', 'command: cargo build --release')).toBe(
        'cargo build --release',
      )
      expect(extractToolTarget('bash', "cmd: 'pytest'")).toBe('pytest')
    })

    it('falls back to trimmed detail string when no key pattern matches', () => {
      expect(extractToolTarget('bash', 'ls -la /workspace')).toBe('ls -la /workspace')
      expect(extractToolTarget('tool', '   ')).toBe('')
    })
  })

  describe('Axiom A3 enforcement: non-evidence invariant', () => {
    it('validates a correct tool call entry', () => {
      const entry: ToolCallEntry = {
        id: 'tool-0-1-T1',
        stepIndex: 0,
        nodeId: 'node-implementer',
        name: 'bash',
        target: 'npm test',
        detail: 'command: npm test',
        startedAt: T1,
        finishedAt: T2,
        status: 'completed',
        isVerifiedEvidence: false,
      }

      const parsed = toolCallEntrySchema.parse(entry)
      expect(parsed.isVerifiedEvidence).toBe(false)
    })

    it('rejects entries with isVerifiedEvidence set to true', () => {
      const invalidEntry = {
        id: 'tool-0-1-T1',
        stepIndex: 0,
        nodeId: null,
        name: 'bash',
        target: 'npm test',
        detail: 'command: npm test',
        startedAt: T1,
        finishedAt: null,
        status: 'running',
        isVerifiedEvidence: true,
      }

      expect(() => toolCallEntrySchema.parse(invalidEntry)).toThrow()
    })
  })

  describe('reduceToolTimeline', () => {
    it('adds new tool event as running and marks prior running tool as completed', () => {
      const initial: readonly ToolCallEntry[] = []

      const event1: RuntimeEvent = {
        type: 'tool',
        at: T1,
        name: 'read_file',
        detail: 'path: src/domain/ids.ts',
      }

      const timeline1 = reduceToolTimeline(initial, event1, 0, 'node-1')
      expect(timeline1).toHaveLength(1)
      expect(timeline1[0]?.name).toBe('read_file')
      expect(timeline1[0]?.target).toBe('src/domain/ids.ts')
      expect(timeline1[0]?.status).toBe('running')
      expect(timeline1[0]?.finishedAt).toBeNull()
      expect(timeline1[0]?.isVerifiedEvidence).toBe(false)

      const event2: RuntimeEvent = {
        type: 'tool',
        at: T2,
        name: 'bash',
        detail: 'npm test',
      }

      const timeline2 = reduceToolTimeline(timeline1, event2, 0, 'node-1')
      expect(timeline2).toHaveLength(2)
      expect(timeline2[0]?.status).toBe('completed')
      expect(timeline2[0]?.finishedAt).toBe(T2)
      expect(timeline2[1]?.status).toBe('running')
      expect(timeline2[1]?.finishedAt).toBeNull()
    })

    it('completes open running tool calls upon step result event', () => {
      const timeline: readonly ToolCallEntry[] = [
        {
          id: 'tool-0-1',
          stepIndex: 0,
          nodeId: 'node-1',
          name: 'bash',
          target: 'npm run build',
          detail: 'npm run build',
          startedAt: T1,
          finishedAt: null,
          status: 'running',
          isVerifiedEvidence: false,
        },
      ]

      const resultEvent: RuntimeEvent = {
        type: 'result',
        at: T2,
        report: {
          status: 'completed',
          summary: 'Build succeeded',
          filesChanged: [],
          commandsRun: ['npm run build'],
          testsRun: true,
          openQuestions: [],
          assumptions: [],
        },
      }

      const updated = reduceToolTimeline(timeline, resultEvent, 0, 'node-1')
      expect(updated).toHaveLength(1)
      expect(updated[0]?.status).toBe('completed')
      expect(updated[0]?.finishedAt).toBe(T2)
    })

    it('marks open running tool calls as failed upon error event', () => {
      const timeline: readonly ToolCallEntry[] = [
        {
          id: 'tool-0-1',
          stepIndex: 0,
          nodeId: 'node-1',
          name: 'bash',
          target: 'npm test',
          detail: 'npm test',
          startedAt: T1,
          finishedAt: null,
          status: 'running',
          isVerifiedEvidence: false,
        },
      ]

      const errorEvent: RuntimeEvent = {
        type: 'error',
        at: T2,
        message: 'Process crashed with SIGKILL',
        retryable: false,
        providerLimit: false,
      }

      const updated = reduceToolTimeline(timeline, errorEvent, 0, 'node-1')
      expect(updated).toHaveLength(1)
      expect(updated[0]?.status).toBe('failed')
      expect(updated[0]?.finishedAt).toBe(T2)
    })

    it('marks open running tool calls as failed upon cancelled state event', () => {
      const timeline: readonly ToolCallEntry[] = [
        {
          id: 'tool-0-1',
          stepIndex: 0,
          nodeId: 'node-1',
          name: 'bash',
          target: 'npm test',
          detail: 'npm test',
          startedAt: T1,
          finishedAt: null,
          status: 'running',
          isVerifiedEvidence: false,
        },
      ]

      const cancelEvent: RuntimeEvent = {
        type: 'state',
        at: T2,
        state: 'cancelled',
      }

      const updated = reduceToolTimeline(timeline, cancelEvent, 0, 'node-1')
      expect(updated).toHaveLength(1)
      expect(updated[0]?.status).toBe('failed')
      expect(updated[0]?.finishedAt).toBe(T2)
    })

    it('ignores chunk and usage events without mutating timeline', () => {
      const timeline: readonly ToolCallEntry[] = [
        {
          id: 'tool-0-1',
          stepIndex: 0,
          nodeId: null,
          name: 'bash',
          target: 'ls',
          detail: 'ls',
          startedAt: T1,
          finishedAt: null,
          status: 'running',
          isVerifiedEvidence: false,
        },
      ]

      const chunkEvent: RuntimeEvent = {
        type: 'chunk',
        at: T2,
        text: 'Executing ls...',
      }

      const usageEvent: RuntimeEvent = {
        type: 'usage',
        at: T3,
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
      }

      expect(reduceToolTimeline(timeline, chunkEvent, 0)).toEqual(timeline)
      expect(reduceToolTimeline(timeline, usageEvent, 0)).toEqual(timeline)
    })
  })

  describe('filtering helpers', () => {
    const entries: readonly ToolCallEntry[] = [
      {
        id: '1',
        stepIndex: 0,
        nodeId: 'node-A',
        name: 'read_file',
        target: 'a.ts',
        detail: 'a.ts',
        startedAt: T1,
        finishedAt: T2,
        status: 'completed',
        isVerifiedEvidence: false,
      },
      {
        id: '2',
        stepIndex: 1,
        nodeId: 'node-B',
        name: 'bash',
        target: 'npm test',
        detail: 'npm test',
        startedAt: T2,
        finishedAt: T3,
        status: 'completed',
        isVerifiedEvidence: false,
      },
    ]

    it('filters correctly by stepIndex', () => {
      expect(filterToolTimelineByStep(entries, 0)).toHaveLength(1)
      expect(filterToolTimelineByStep(entries, 0)[0]?.name).toBe('read_file')
      expect(filterToolTimelineByStep(entries, 1)).toHaveLength(1)
      expect(filterToolTimelineByStep(entries, 1)[0]?.name).toBe('bash')
      expect(filterToolTimelineByStep(entries, 2)).toHaveLength(0)
    })

    it('filters correctly by nodeId', () => {
      expect(filterToolTimelineByNode(entries, 'node-A')).toHaveLength(1)
      expect(filterToolTimelineByNode(entries, 'node-B')).toHaveLength(1)
      expect(filterToolTimelineByNode(entries, 'node-C')).toHaveLength(0)
    })
  })
})
