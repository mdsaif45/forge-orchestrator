import { describe, expect, it } from 'vitest'
import type { ChangeSet, ChangeSetId, StepId, TaskId, WorkflowArtifact } from '@shared/domain'
import {
  computeIterationFingerprint,
  getConsecutiveRepeatCount,
  type RouterDecisionRecord,
} from './loopFingerprint'

describe('loopFingerprint (WORK-003 Slice 2B Canonical Fingerprint)', () => {
  const baseArtifact: WorkflowArtifact = {
    id: 'art-uuid-1',
    workflowId: 'wf-1',
    nodeId: 'worker-1',
    kind: 'eval_report',
    format: 'json',
    title: 'Report',
    content: JSON.stringify({ score: 95, verdict: 'pass' }),
    metadata: { author: 'evaluator', timestamp: '2026-10-06T00:00:00Z' },
    createdAt: '2026-10-06T00:00:00Z',
  }

  const baseChangeSet: ChangeSet = {
    id: 'cs-1' as ChangeSetId,
    baseSha: 'sha-base',
    headSha: null,
    files: [
      {
        path: 'src/app.ts',
        insertions: 5,
        deletions: 2,
        changeType: 'modified',
        previousPath: null,
      },
      { path: 'src/util.ts', insertions: 1, deletions: 0, changeType: 'added', previousPath: null },
    ],
    patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n',
    authorActor: 'system',
    stepId: 'step-1' as StepId,
    taskId: 'task-1' as TaskId,
    correctsChangeSetId: null,
    reviewVerdict: null,
    discrepancies: [],
    capturedAt: '2026-10-06T00:00:00Z',
  }

  it('produces identical fingerprint when artifact content JSON keys are reordered', () => {
    const artA = {
      ...baseArtifact,
      content: JSON.stringify({ verdict: 'pass', score: 95 }),
    }
    const artB = {
      ...baseArtifact,
      content: JSON.stringify({ score: 95, verdict: 'pass' }),
    }

    const fpA = computeIterationFingerprint({ artifacts: [artA] })
    const fpB = computeIterationFingerprint({ artifacts: [artB] })

    expect(fpA).toBe(fpB)
  })

  it('produces identical fingerprint when random IDs and timestamps change', () => {
    const art1 = {
      ...baseArtifact,
      id: 'random-uuid-alpha',
      createdAt: '2026-10-06T01:00:00Z',
      metadata: { author: 'evaluator', timestamp: '2026-10-06T01:00:00Z', attempt: 1 },
    }
    const art2 = {
      ...baseArtifact,
      id: 'random-uuid-beta',
      createdAt: '2026-10-06T02:00:00Z',
      metadata: { author: 'evaluator', timestamp: '2026-10-06T02:00:00Z', attempt: 2 },
    }

    const fp1 = computeIterationFingerprint({ artifacts: [art1] })
    const fp2 = computeIterationFingerprint({ artifacts: [art2] })

    expect(fp1).toBe(fp2)
  })

  it('produces identical fingerprint when context keys are reordered', () => {
    const ctxA = { a: '1', z: '2', m: '3' }
    const ctxB = { z: '2', m: '3', a: '1' }

    const fpA = computeIterationFingerprint({ context: ctxA })
    const fpB = computeIterationFingerprint({ context: ctxB })

    expect(fpA).toBe(fpB)
  })

  it('produces identical fingerprint when router decisions are provided in different orders', () => {
    const dec1: RouterDecisionRecord = {
      routerNodeId: 'r-A',
      selectedEdgeId: 'e1',
      targetNodeId: 't1',
    }
    const dec2: RouterDecisionRecord = {
      routerNodeId: 'r-B',
      selectedEdgeId: 'e2',
      targetNodeId: 't2',
    }

    const fp1 = computeIterationFingerprint({ routerDecisions: [dec1, dec2] })
    const fp2 = computeIterationFingerprint({ routerDecisions: [dec2, dec1] })

    expect(fp1).toBe(fp2)
  })

  it('alters fingerprint when meaningful artifact content changes', () => {
    const artA = { ...baseArtifact, content: JSON.stringify({ score: 95 }) }
    const artB = { ...baseArtifact, content: JSON.stringify({ score: 80 }) }

    const fpA = computeIterationFingerprint({ artifacts: [artA] })
    const fpB = computeIterationFingerprint({ artifacts: [artB] })

    expect(fpA).not.toBe(fpB)
  })

  it('alters fingerprint when meaningful router decision changes', () => {
    const decA: RouterDecisionRecord = {
      routerNodeId: 'router-1',
      selectedEdgeId: 'edge-A',
      targetNodeId: 'node-A',
    }
    const decB: RouterDecisionRecord = {
      routerNodeId: 'router-1',
      selectedEdgeId: 'edge-B',
      targetNodeId: 'node-B',
    }

    const fpA = computeIterationFingerprint({ routerDecisions: [decA] })
    const fpB = computeIterationFingerprint({ routerDecisions: [decB] })

    expect(fpA).not.toBe(fpB)
  })

  it('alters fingerprint when meaningful code diff changes', () => {
    const csA = { ...baseChangeSet, patch: 'patch version 1' }
    const csB = { ...baseChangeSet, patch: 'patch version 2' }

    const fpA = computeIterationFingerprint({ changeSet: csA })
    const fpB = computeIterationFingerprint({ changeSet: csB })

    expect(fpA).not.toBe(fpB)
  })

  it('alters fingerprint when context value changes', () => {
    const fpA = computeIterationFingerprint({ context: { retryMode: 'fast' } })
    const fpB = computeIterationFingerprint({ context: { retryMode: 'slow' } })

    expect(fpA).not.toBe(fpB)
  })

  it('calculates consecutive repeat count accurately', () => {
    const fp1 = 'hash-alpha'
    const fp2 = 'hash-beta'

    expect(getConsecutiveRepeatCount([], fp1)).toBe(0)
    expect(getConsecutiveRepeatCount([fp2], fp1)).toBe(0)
    expect(getConsecutiveRepeatCount([fp1], fp1)).toBe(1)
    expect(getConsecutiveRepeatCount([fp2, fp1], fp1)).toBe(1)
    expect(getConsecutiveRepeatCount([fp2, fp1, fp1], fp1)).toBe(2)
    expect(getConsecutiveRepeatCount([fp1, fp2, fp1], fp1)).toBe(1)
  })
})
