import type { ToolCallEntry } from '@shared/domain'
import type {
  ArtifactMetadataView,
  ChangeSetView,
  WorkflowDetailView,
  WorkflowStepView,
} from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { buildThreadEntries } from './threadProjection'

const BASE_WORKFLOW: WorkflowDetailView = {
  id: 'wf-1',
  taskId: 'task-1',
  templateId: 'feature',
  state: 'IMPLEMENTING',
  iteration: 0,
  limits: {
    maxIterations: 3,
    stepTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 300_000,
  },
  steps: [
    {
      id: 'step-0',
      index: 0,
      role: 'planner',
      runtimeId: 'claude',
      simulated: false,
      state: 'completed',
      contextRef: 'ctx-0',
      reportStatus: '## Blueprint\n- Update thread view',
      verdict: 'pass',
      changeSetId: null,
      startedAt: '2026-11-26T10:00:00.000Z',
      finishedAt: '2026-11-26T10:00:05.000Z',
    },
    {
      id: 'step-1',
      index: 1,
      role: 'implementer',
      runtimeId: 'codex',
      simulated: false,
      state: 'running',
      contextRef: 'ctx-1',
      reportStatus: null,
      verdict: null,
      changeSetId: 'cs-1',
      startedAt: '2026-11-26T10:00:06.000Z',
      finishedAt: null,
    },
  ],
  checkpoint: null,
  resumeState: null,
  blockedByQuestionId: null,
  haltReason: null,
  startedAt: '2026-11-26T10:00:00.000Z',
  finishedAt: null,
}

describe('buildThreadEntries', () => {
  it('projects user prompt, active/completed agent turns, inline tools, artifacts, and changesets chronologically', () => {
    const tools: readonly ToolCallEntry[] = [
      {
        id: 't-1',
        stepIndex: 0,
        nodeId: 'planner',
        name: 'read_file',
        target: 'src/App.tsx',
        detail: 'src/App.tsx',
        startedAt: '2026-11-26T10:00:01.000Z',
        finishedAt: '2026-11-26T10:00:02.000Z',
        status: 'completed',
        isVerifiedEvidence: false,
      },
      {
        id: 't-2',
        stepIndex: 1,
        nodeId: 'implementer',
        name: 'bash',
        target: 'npm test',
        detail: 'command: npm test',
        startedAt: '2026-11-26T10:00:07.000Z',
        finishedAt: null,
        status: 'running',
        isVerifiedEvidence: false,
      },
    ]

    const artifacts: readonly ArtifactMetadataView[] = [
      {
        id: 'art-plan',
        runId: 'wf-1',
        stepId: 'step-0',
        kind: 'plan',
        name: 'planning.md',
        mimeType: 'text/markdown',
        sizeBytes: 21,
        sha256: 'abc123',
        relativePath: '.forge/artifacts/planning.md',
        createdAt: '2026-11-26T10:00:04.000Z',
      },
    ]

    const changeSets: readonly ChangeSetView[] = [
      {
        id: 'cs-1',
        baseSha: 'abc',
        headSha: 'def',
        files: [
          {
            path: 'src/ThreadContainer.tsx',
            changeType: 'added',
            previousPath: null,
            insertions: 42,
            deletions: 0,
          },
        ],
        patch: '+export function ThreadContainer() {}',
        authorActor: 'codex',
        stepId: 'step-1',
        taskId: 'task-1',
        correctsChangeSetId: null,
        reviewVerdict: 'pass',
        discrepancies: [],
        capturedAt: '2026-11-26T10:00:08.000Z',
      },
    ]

    const stageSteps: readonly WorkflowStepView[] = BASE_WORKFLOW.steps

    const entries = buildThreadEntries({
      workflow: BASE_WORKFLOW,
      stageSteps,
      taskTitle: 'Unified Thread UI',
      promptObjective: 'Build continuous execution thread timeline.',
      toolTimeline: tools,
      stepStreams: {
        1: {
          text: 'Editing thread components...',
          usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.012 },
          errors: [],
        },
      },
      artifacts,
      changeSets,
      logs: [{ id: 'l-1', stepIndex: 1, timestamp: '10:00:07', text: '[STEP 1] Running tests' }],
      interjections: [
        {
          id: 'ij-1',
          stepIndex: 1,
          text: 'Keep existing E2E hooks intact.',
          at: '2026-11-26T10:00:09.000Z',
        },
      ],
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      'user_prompt',
      'agent_turn',
      'agent_turn',
      'user_followup',
    ])

    const plannerTurn = entries[1]
    expect(plannerTurn?.kind).toBe('agent_turn')
    if (plannerTurn?.kind === 'agent_turn') {
      expect(plannerTurn.persona).toBe('Alex (Planner)')
      expect(plannerTurn.tools).toHaveLength(1)
      expect(plannerTurn.artifacts.map((a) => a.name)).toEqual(['planning.md'])
    }

    const implTurn = entries[2]
    if (implTurn?.kind === 'agent_turn') {
      expect(implTurn.isRunning).toBe(true)
      expect(implTurn.streamedText).toBe('Editing thread components...')
      expect(implTurn.usage?.costUsd).toBe(0.012)
      expect(implTurn.changeSet?.id).toBe('cs-1')
      expect(implTurn.logs).toHaveLength(1)
    }
  })

  it('appends a system_event entry when the workflow completes or halts', () => {
    const entries = buildThreadEntries({
      workflow: {
        ...BASE_WORKFLOW,
        state: 'HALTED_POLICY',
        haltReason: 'Out of scope write blocked',
        finishedAt: '2026-11-26T10:01:00.000Z',
      },
      stageSteps: BASE_WORKFLOW.steps,
      taskTitle: null,
      promptObjective: null,
      toolTimeline: [],
      stepStreams: {},
      artifacts: [],
      changeSets: [],
      logs: [],
      interjections: [],
    })

    const tail = entries.at(-1)
    expect(tail?.kind).toBe('system_event')
    if (tail?.kind === 'system_event') {
      expect(tail.tone).toBe('danger')
      expect(tail.detail).toBe('Out of scope write blocked')
    }
  })
})
