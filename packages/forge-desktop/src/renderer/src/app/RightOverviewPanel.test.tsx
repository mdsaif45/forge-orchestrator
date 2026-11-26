import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui'
import { useOverviewStore } from './overviewStore'
import { useProjectStore } from './projectStore'
import { RightOverviewPanel } from './RightOverviewPanel'

const PLAN_TEXT = '# Implementation Plan\n\n## Phase A\n- Build DrawerPlanView\n'

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) {
    binary += String.fromCharCode(b)
  }
  return btoa(binary)
}

describe('RightOverviewPanel & Execution Drawer Views', () => {
  beforeEach(() => {
    useOverviewStore.setState({
      isOpen: true,
      isExpanded: false,
      panelMode: 'overview',
      hasUnreadPlan: true,
      tabs: [],
      activeTabId: null,
      filesChanged: [],
      artifacts: [],
      subagents: [],
    })

    useProjectStore.setState({
      detail: {
        project: {
          id: 'proj-1',
          name: 'Forge',
          repository: {
            id: 'repo-1',
            absolutePath: 'd:/repos/Forge',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: '2026-11-26T00:00:00Z',
          updatedAt: '2026-11-26T00:00:00Z',
        },
        rules: [],
        policy: [],
        probe: {
          path: 'd:/repos/Forge',
          isRepository: true,
          branch: 'feat/ui-drawer',
          defaultBranch: 'main',
          defaultBranchSource: 'convention',
          branches: ['main', 'feat/ui-drawer'],
          headSha: 'abc1234def',
          dirty: true,
          dirtyPaths: ['packages/forge-desktop/Shell.tsx'],
          dirtyCount: 1,
          problems: [],
        },
      },
    })

    vi.stubGlobal('forge', {
      project: {
        probeRepository: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            path: 'd:/repos/Forge',
            isRepository: true,
            branch: 'feat/ui-drawer',
            defaultBranch: 'main',
            defaultBranchSource: 'convention',
            branches: ['main', 'feat/ui-drawer'],
            headSha: 'abc1234def',
            dirty: true,
            dirtyPaths: ['packages/forge-desktop/Shell.tsx'],
            dirtyCount: 1,
            problems: [],
          },
        }),
      },
      workflow: {
        getActive: vi.fn().mockResolvedValue({
          ok: true,
          value: {
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
            steps: [],
            checkpoint: null,
            resumeState: null,
            blockedByQuestionId: null,
            haltReason: null,
            startedAt: '2026-11-26T00:00:00Z',
            finishedAt: null,
          },
        }),
        approveAndStartImplementation: vi.fn().mockResolvedValue({ ok: true, value: null }),
        interject: vi.fn().mockResolvedValue({ ok: true, value: null }),
      },
      decision: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            decisions: [
              {
                id: 'dec-1',
                statement: 'Approved blueprint',
                rationale: 'Test lock',
                status: 'locked',
                proposedBy: 'user',
                proposedAt: '2026-11-26T00:00:00Z',
                lockedAt: '2026-11-26T00:00:00Z',
                lockedBy: 'user',
                supersededBy: null,
                originQuestionId: null,
              },
            ],
          },
        }),
      },
      artifacts: {
        listForRun: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            artifacts: [
              {
                id: 'art-plan',
                runId: 'wf-1',
                stepId: null,
                kind: 'plan',
                name: 'planning.md',
                mimeType: 'text/markdown',
                sizeBytes: PLAN_TEXT.length,
                sha256: 'deadbeef',
                relativePath: '.forge/planning.md',
                createdAt: '2026-11-26T00:00:00Z',
              },
            ],
          },
        }),
        readWindow: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            data: encodeBase64(PLAN_TEXT),
            encoding: 'base64',
            totalBytes: PLAN_TEXT.length,
          },
        }),
      },
      git: {
        getWorkingDiff: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            files: [
              {
                path: 'packages/forge-desktop/Shell.tsx',
                changeType: 'modified',
                previousPath: null,
                insertions: 12,
                deletions: 3,
              },
            ],
            patch: '+export function Shell() {}',
          },
        }),
        stage: vi.fn().mockResolvedValue({ ok: true, value: { stagedCount: 1 } }),
        unstage: vi.fn().mockResolvedValue({ ok: true, value: { success: true } }),
        commit: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sha: 'fedcba9876543',
            message: 'chore: update packages/forge-desktop/Shell.tsx',
          },
        }),
      },
      clipboard: {
        writeText: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      },
      onWorkflowEvent: vi.fn(() => vi.fn()),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('switches between Overview, planning.md Plan Viewer, and Diffs / Git Actions cleanly', async () => {
    const user = userEvent.setup()

    render(
      <ToastProvider>
        <RightOverviewPanel />
      </ToastProvider>,
    )

    // Overview lists artifact & changed file
    expect(await screen.findByText('Shell.tsx')).toBeInTheDocument()

    // Open planning.md tab and verify rendered plan + Approve action
    await user.click(screen.getByRole('button', { name: 'planning.md' }))
    expect(await screen.findByText('Build DrawerPlanView')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Approve & Implement/i }))
    expect(window.forge.workflow.approveAndStartImplementation).toHaveBeenCalledWith('wf-1')

    // Switch to Diffs / Git view, synthesize commit message, and commit
    await user.click(screen.getByRole('button', { name: /Diffs \/ Git/i }))
    expect(await screen.findByText('feat/ui-drawer')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Synthesize message' }))
    expect(screen.getByLabelText('Commit message')).toHaveValue(
      'chore: update packages/forge-desktop/Shell.tsx',
    )

    await user.click(screen.getByRole('button', { name: 'Stage All & Commit' }))
    expect(window.forge.git.stage).toHaveBeenCalledWith('proj-1', [])
    expect(window.forge.git.commit).toHaveBeenCalledWith(
      'proj-1',
      'chore: update packages/forge-desktop/Shell.tsx',
    )
  })
})
