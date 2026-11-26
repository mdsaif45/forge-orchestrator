import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ArtifactMetadataView, RoleBindingsView, WorkflowStepView } from '@shared/ipc'
import { ThreadContainer } from './ThreadContainer'
import { buildThreadEntries } from './threadProjection'

const STEPS: readonly WorkflowStepView[] = [
  {
    id: 'step-0',
    index: 0,
    role: 'planner',
    runtimeId: 'claude',
    simulated: false,
    state: 'completed',
    contextRef: null,
    reportStatus: '### Plan Ready\n- Step 1\n- Step 2',
    verdict: 'pass',
    changeSetId: null,
    startedAt: '2026-11-26T10:00:00.000Z',
    finishedAt: '2026-11-26T10:00:02.000Z',
  },
  {
    id: 'step-1',
    index: 1,
    role: 'implementer',
    runtimeId: 'codex',
    simulated: false,
    state: 'awaiting_user',
    contextRef: null,
    reportStatus: null,
    verdict: null,
    changeSetId: null,
    startedAt: null,
    finishedAt: null,
  },
]

const ARTIFACT: ArtifactMetadataView = {
  id: 'art-1',
  runId: 'wf-1',
  stepId: 'step-0',
  kind: 'plan',
  name: 'planning.md',
  mimeType: 'text/markdown',
  sizeBytes: 14,
  sha256: 'sha256-plan',
  relativePath: '.forge/artifacts/planning.md',
  createdAt: '2026-11-26T10:00:02.000Z',
}

const BINDINGS: RoleBindingsView = {
  roles: [
    {
      role: 'planner',
      binding: {
        id: 'b-1',
        role: 'planner',
        runtimeId: 'claude',
        accountId: null,
        simulated: false,
      },
      eligibleRuntimes: [
        { id: 'claude', simulated: false, supportsAccountIsolation: true },
        { id: 'agy', simulated: false, supportsAccountIsolation: false },
      ],
    },
  ],
}

describe('ThreadContainer', () => {
  it('renders chronological turns, inline tool stream with Axiom A3 claim badge, width toggle, and composer', async () => {
    const user = userEvent.setup()
    const onSelectStep = vi.fn()
    const onOpenArtifact = vi.fn()
    const onInterject = vi.fn().mockResolvedValue(undefined)
    const onSwitchRoleRuntime = vi.fn().mockResolvedValue(undefined)

    const entries = buildThreadEntries({
      workflow: {
        id: 'wf-1',
        taskId: 'task-1',
        templateId: 'feature',
        state: 'PLAN_READY',
        iteration: 0,
        limits: {
          maxIterations: 3,
          stepTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
          totalTimeoutMs: 300_000,
        },
        steps: STEPS,
        checkpoint: null,
        resumeState: null,
        blockedByQuestionId: null,
        haltReason: null,
        startedAt: '2026-11-26T10:00:00.000Z',
        finishedAt: null,
      },
      stageSteps: STEPS,
      taskTitle: 'Design System',
      promptObjective: 'Refactor UI to centralized thread container.',
      toolTimeline: [
        {
          id: 'tool-1',
          stepIndex: 0,
          nodeId: 'planner',
          name: 'read_file',
          target: 'README.md',
          detail: 'README.md',
          startedAt: '2026-11-26T10:00:01.000Z',
          finishedAt: '2026-11-26T10:00:01.500Z',
          status: 'completed',
          isVerifiedEvidence: false,
        },
      ],
      stepStreams: {},
      artifacts: [ARTIFACT],
      changeSets: [],
      logs: [],
      interjections: [],
    })

    render(
      <ThreadContainer
        projectId="proj-1"
        repositoryPath="d:/repos/Forge"
        workflowId="wf-1"
        templateId="feature"
        iteration={0}
        maxIterations={3}
        status="waiting"
        statusLabel="Plan ready"
        isDiscussionMode
        isTerminal={false}
        isAwaitingApproval
        stageSteps={STEPS}
        selectedStep={STEPS[0] ?? null}
        entries={entries}
        bindings={BINDINGS}
        actionInProgress={false}
        onSelectStep={onSelectStep}
        onOpenArtifact={onOpenArtifact}
        onInterject={onInterject}
        onStartNextCycle={vi.fn().mockResolvedValue(undefined)}
        onSwitchRoleRuntime={onSwitchRoleRuntime}
        onApproveAndImplement={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByText('Design System')).toBeInTheDocument()
    expect(screen.getByText('Agent Claim')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()

    // Artifact chip opens viewer
    await user.click(screen.getByRole('button', { name: /planning\.md/i }))
    expect(onOpenArtifact).toHaveBeenCalledWith(ARTIFACT)

    // Readable/Full-width toggle
    const widthBtn = screen.getByRole('button', { name: 'Expand to full width' })
    await user.click(widthBtn)
    expect(screen.getByRole('button', { name: 'Use readable column width' })).toBeInTheDocument()

    // Inline composer sends guidance
    await user.type(screen.getByLabelText('Thread guidance prompt'), 'Focus on @forge/ui exports')
    await user.click(screen.getByRole('button', { name: 'Send guidance' }))
    expect(onInterject).toHaveBeenCalledWith(1, 'Focus on @forge/ui exports')

    // Mid-thread runtime switcher updates role binding
    await user.click(screen.getByRole('button', { name: /Switch role runtime/i }))
    await user.click(await screen.findByRole('menuitem', { name: /agy/i }))
    expect(onSwitchRoleRuntime).toHaveBeenCalledWith('planner', 'agy')
  })
})
