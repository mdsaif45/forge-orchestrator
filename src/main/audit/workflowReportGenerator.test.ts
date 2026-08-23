import { describe, expect, it } from 'vitest'
import { generateWorkflowReportMarkdown } from './workflowReportGenerator'
import type { WorkflowDetailView, DecisionView, OpenQuestionView } from '@shared/ipc'

describe('Workflow Audit Report Generator (#48)', () => {
  it('generates a clean markdown report from workflow data', () => {
    const mockWorkflow: WorkflowDetailView = {
      id: 'wf-12345',
      taskId: 'task-6789',
      templateId: 'feature',
      state: 'DONE',
      iteration: 1,
      limits: {
        maxIterations: 5,
        stepTimeoutMs: 300000,
        idleTimeoutMs: 60000,
        totalTimeoutMs: 1800000,
      },
      steps: [
        {
          id: 'step-1',
          index: 0,
          role: 'planner',
          runtimeId: 'mock-runtime',
          state: 'passed',
          contextRef: 'ctx-1',
          reportStatus: 'ok',
          verdict: 'passed',
          changeSetId: null,
          startedAt: '2026-08-24T00:00:00.000Z',
          finishedAt: '2026-08-24T00:01:00.000Z',
        },
      ],
      checkpoint: null,
      resumeState: null,
      blockedByQuestionId: null,
      haltReason: null,
      startedAt: '2026-08-24T00:00:00.000Z',
      finishedAt: '2026-08-24T00:05:00.000Z',
    }

    const mockDecisions: readonly DecisionView[] = [
      {
        id: 'dec-1',
        projectId: 'proj-1',
        statement: 'Use SQLite WAL mode',
        rationale: 'Need robust crash recovery',
        status: 'locked',
        proposedBy: 'planner',
        proposedAt: '2026-08-24T00:00:00.000Z',
        lockedAt: '2026-08-24T00:02:00.000Z',
        lockedBy: 'user',
        supersededBy: null,
        originQuestionId: null,
      },
    ]

    const mockQuestions: readonly OpenQuestionView[] = [
      {
        id: 'q-1',
        projectId: 'proj-1',
        question: 'Should we support custom ports?',
        whyUndetermined: 'Not specified in requirements',
        evidence: [],
        options: ['yes', 'no'],
        recommendation: 'yes',
        askedBy: 'planner',
        askedAt: '2026-08-24T00:00:30.000Z',
        answer: 'Yes, default to 8080',
        answeredAt: '2026-08-24T00:01:00.000Z',
        answeredBy: 'user',
      },
    ]

    const report = generateWorkflowReportMarkdown({
      workflow: mockWorkflow,
      projectName: 'Test Project',
      decisions: mockDecisions,
      questions: mockQuestions,
    })

    expect(report).toContain('# Forge Workflow Audit Report')
    expect(report).toContain('**Project:** Test Project')
    expect(report).toContain('wf-12345')
    expect(report).toContain('Use SQLite WAL mode')
    expect(report).toContain('Should we support custom ports?')
    expect(report).toContain('planner')
  })
})
