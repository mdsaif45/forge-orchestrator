import { describe, expect, it } from 'vitest'
import {
  graphCheckpointViewSchema,
  graphNodeRunViewSchema,
  graphNodeStatusViewSchema,
  graphRunStatusViewSchema,
  graphRunViewSchema,
  graphStateSnapshotViewSchema,
  type GraphCheckpointView,
  type GraphNodeRunView,
  type GraphRunView,
} from './index'

describe('Graph View Schemas (Slice 5A-1)', () => {
  const validNodeRun: GraphNodeRunView = {
    id: 'attempt-1111-2222-3333-4444',
    graphRunId: 'run-aaaa-bbbb-cccc-dddd',
    nodeId: 'implement',
    attempt: 1,
    iteration: 1,
    status: 'running',
    role: 'implementer',
    runtimeId: 'claude-code',
    contextRef: 'ctx-hash-1234',
    changeSetId: 'cs-5555-6666-7777-8888',
    evidenceId: 'ev-9999-0000-1111-2222',
    error: null,
    startedAt: '2026-10-16T10:00:00.000Z',
    finishedAt: null,
  }

  const validCheckpoint: GraphCheckpointView = {
    id: 'chk-1111-2222-3333-4444',
    graphRunId: 'run-aaaa-bbbb-cccc-dddd',
    nodeId: 'implement',
    operation: 'dispatch_leaf_node',
    stateSnapshot: {
      readyNodeIds: ['verify'],
      runningNodeIds: ['implement'],
      completedNodeIds: ['plan'],
      blockedNodeIds: [],
      skippedNodeIds: [],
    },
    occurredAt: '2026-10-16T10:00:00.000Z',
  }

  const validGraphRun: GraphRunView = {
    id: 'run-aaaa-bbbb-cccc-dddd',
    workflowId: 'wf-1111-2222-3333-4444',
    templateId: 'feature_implementation_v2',
    status: 'running',
    iteration: 1,
    startedAt: '2026-10-16T10:00:00.000Z',
    finishedAt: null,
    haltReason: null,
    error: null,
    nodeRuns: [validNodeRun],
    checkpoint: validCheckpoint,
  }

  describe('graphRunStatusViewSchema', () => {
    it('accepts all valid run status values', () => {
      const statuses = ['running', 'completed', 'failed', 'halted', 'cancelled'] as const
      for (const s of statuses) {
        expect(graphRunStatusViewSchema.safeParse(s).success).toBe(true)
      }
    })

    it('rejects invalid run status values', () => {
      const invalid = ['pending', 'ready', 'in-progress', 'paused', '', null, undefined, 42]
      for (const s of invalid) {
        expect(graphRunStatusViewSchema.safeParse(s).success).toBe(false)
      }
    })
  })

  describe('graphNodeStatusViewSchema', () => {
    it('accepts all valid node status values', () => {
      const statuses = [
        'pending',
        'ready',
        'running',
        'completed',
        'failed',
        'skipped',
        'blocked',
        'cancelled',
      ] as const
      for (const s of statuses) {
        expect(graphNodeStatusViewSchema.safeParse(s).success).toBe(true)
      }
    })

    it('rejects invalid node status values', () => {
      const invalid = ['halted', 'in-progress', 'waiting', '', null, undefined]
      for (const s of invalid) {
        expect(graphNodeStatusViewSchema.safeParse(s).success).toBe(false)
      }
    })
  })

  describe('graphNodeRunViewSchema', () => {
    it('accepts a fully populated node run instance', () => {
      const result = graphNodeRunViewSchema.safeParse(validNodeRun)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validNodeRun)
      }
    })

    it('accepts all nullable fields as null', () => {
      const minimalNodeRun = {
        id: 'attempt-1',
        graphRunId: 'run-1',
        nodeId: 'plan',
        attempt: 1,
        iteration: 1,
        status: 'pending',
        role: null,
        runtimeId: null,
        contextRef: null,
        changeSetId: null,
        evidenceId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }
      expect(graphNodeRunViewSchema.safeParse(minimalNodeRun).success).toBe(true)
    })

    it('rejects missing required identifiers', () => {
      const missingId = { ...validNodeRun, id: undefined }
      const missingRunId = { ...validNodeRun, graphRunId: undefined }
      const missingNodeId = { ...validNodeRun, nodeId: undefined }

      expect(graphNodeRunViewSchema.safeParse(missingId).success).toBe(false)
      expect(graphNodeRunViewSchema.safeParse(missingRunId).success).toBe(false)
      expect(graphNodeRunViewSchema.safeParse(missingNodeId).success).toBe(false)
    })

    it('rejects empty string identifiers', () => {
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, id: '' }).success).toBe(false)
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, graphRunId: '' }).success).toBe(
        false,
      )
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, nodeId: '' }).success).toBe(false)
    })

    it('rejects non-positive attempt or iteration counters', () => {
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, attempt: 0 }).success).toBe(false)
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, attempt: -1 }).success).toBe(false)
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, attempt: 1.5 }).success).toBe(
        false,
      )
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, iteration: 0 }).success).toBe(
        false,
      )
      expect(graphNodeRunViewSchema.safeParse({ ...validNodeRun, iteration: -1 }).success).toBe(
        false,
      )
    })

    it('rejects unexpected additional properties (strict object)', () => {
      const injected = { ...validNodeRun, extraField: 'illegal' }
      expect(graphNodeRunViewSchema.safeParse(injected).success).toBe(false)
    })

    it('preserves fields across JSON serialization round-trip', () => {
      const serialized = JSON.stringify(validNodeRun)
      const parsed = JSON.parse(serialized)
      const result = graphNodeRunViewSchema.safeParse(parsed)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validNodeRun)
      }
    })
  })

  describe('graphCheckpointViewSchema', () => {
    it('accepts a fully populated checkpoint instance', () => {
      const result = graphCheckpointViewSchema.safeParse(validCheckpoint)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validCheckpoint)
      }
    })

    it('accepts state snapshot with omitted skippedNodeIds', () => {
      const checkpointWithoutSkipped = {
        id: 'chk-1',
        graphRunId: 'run-1',
        nodeId: 'implement',
        operation: 'step',
        stateSnapshot: {
          readyNodeIds: ['verify'],
          runningNodeIds: ['implement'],
          completedNodeIds: [],
          blockedNodeIds: [],
        },
        occurredAt: '2026-10-16T10:00:00.000Z',
      }
      expect(graphCheckpointViewSchema.safeParse(checkpointWithoutSkipped).success).toBe(true)
    })

    it('defaults state snapshot empty arrays when omitted', () => {
      const minimalSnapshot = {}
      const parsed = graphStateSnapshotViewSchema.safeParse(minimalSnapshot)
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.readyNodeIds).toEqual([])
        expect(parsed.data.runningNodeIds).toEqual([])
        expect(parsed.data.completedNodeIds).toEqual([])
        expect(parsed.data.blockedNodeIds).toEqual([])
      }
    })

    it('rejects missing required checkpoint fields', () => {
      expect(
        graphCheckpointViewSchema.safeParse({ ...validCheckpoint, operation: undefined }).success,
      ).toBe(false)
      expect(
        graphCheckpointViewSchema.safeParse({ ...validCheckpoint, occurredAt: undefined }).success,
      ).toBe(false)
      expect(
        graphCheckpointViewSchema.safeParse({ ...validCheckpoint, stateSnapshot: undefined })
          .success,
      ).toBe(false)
    })

    it('rejects unexpected additional properties (strict object)', () => {
      const injected = { ...validCheckpoint, leakedDbHandle: {} }
      expect(graphCheckpointViewSchema.safeParse(injected).success).toBe(false)
    })
  })

  describe('graphRunViewSchema', () => {
    it('accepts a fully populated graph run view', () => {
      const result = graphRunViewSchema.safeParse(validGraphRun)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validGraphRun)
      }
    })

    it('defaults nodeRuns to empty array and checkpoint to null when omitted', () => {
      const flatRun = {
        id: 'run-aaaa-bbbb-cccc-dddd',
        workflowId: 'wf-1111-2222-3333-4444',
        templateId: 'feature_implementation_v2',
        status: 'running',
        iteration: 1,
        startedAt: '2026-10-16T10:00:00.000Z',
        finishedAt: null,
        haltReason: null,
        error: null,
      }
      const result = graphRunViewSchema.safeParse(flatRun)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.nodeRuns).toEqual([])
        expect(result.data.checkpoint).toBeNull()
      }
    })

    it('accepts terminal run states with finishedAt, haltReason, and error populated', () => {
      const haltedRun: GraphRunView = {
        ...validGraphRun,
        status: 'halted',
        finishedAt: '2026-10-16T10:15:00.000Z',
        haltReason: 'Role permissions exceeded: planner attempted write',
        error: null,
      }
      expect(graphRunViewSchema.safeParse(haltedRun).success).toBe(true)

      const failedRun: GraphRunView = {
        ...validGraphRun,
        status: 'failed',
        finishedAt: '2026-10-16T10:15:00.000Z',
        haltReason: null,
        error: 'Execution terminated unexpectedly',
      }
      expect(graphRunViewSchema.safeParse(failedRun).success).toBe(true)

      const completedRun: GraphRunView = {
        ...validGraphRun,
        status: 'completed',
        finishedAt: '2026-10-16T10:15:00.000Z',
        haltReason: null,
        error: null,
      }
      expect(graphRunViewSchema.safeParse(completedRun).success).toBe(true)
    })

    it('rejects missing required core fields', () => {
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, id: undefined }).success).toBe(false)
      expect(
        graphRunViewSchema.safeParse({ ...validGraphRun, workflowId: undefined }).success,
      ).toBe(false)
      expect(
        graphRunViewSchema.safeParse({ ...validGraphRun, templateId: undefined }).success,
      ).toBe(false)
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, status: undefined }).success).toBe(
        false,
      )
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, startedAt: undefined }).success).toBe(
        false,
      )
    })

    it('rejects empty string identifiers', () => {
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, id: '' }).success).toBe(false)
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, workflowId: '' }).success).toBe(false)
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, templateId: '' }).success).toBe(false)
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, startedAt: '' }).success).toBe(false)
    })

    it('rejects non-positive iteration count', () => {
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, iteration: 0 }).success).toBe(false)
      expect(graphRunViewSchema.safeParse({ ...validGraphRun, iteration: -2 }).success).toBe(false)
    })

    it('rejects unknown fields on the root object (strict object)', () => {
      const injected = { ...validGraphRun, internalSqliteTable: 'graph_runs' }
      expect(graphRunViewSchema.safeParse(injected).success).toBe(false)
    })

    it('rejects malformed node runs inside nodeRuns array', () => {
      const invalidNestedRun = {
        ...validGraphRun,
        nodeRuns: [{ ...validNodeRun, status: 'invalid-status' }],
      }
      expect(graphRunViewSchema.safeParse(invalidNestedRun).success).toBe(false)
    })

    it('preserves full structure across JSON serialization round-trip', () => {
      const serialized = JSON.stringify(validGraphRun)
      const parsed = JSON.parse(serialized)
      const result = graphRunViewSchema.safeParse(parsed)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validGraphRun)
      }
    })
  })
})
