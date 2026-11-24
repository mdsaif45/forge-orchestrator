import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCallEntry } from '@shared/domain'
import { ToolCallTimeline } from './ToolCallTimeline'

describe('ToolCallTimeline (Issue #155)', () => {
  it('renders the Axiom A3 non-evidence warning badge', () => {
    render(<ToolCallTimeline tools={[]} />)

    expect(screen.getByText(/Agent Claim • Not Physical Evidence/i)).toBeTruthy()
    expect(screen.getByText(/No tool calls recorded for this step/i)).toBeTruthy()
  })

  it('renders tool calls in chronological order with target and status badges', () => {
    const tools: readonly ToolCallEntry[] = [
      {
        id: 'tool-0-1',
        stepIndex: 0,
        nodeId: 'node-implementer',
        name: 'read_file',
        target: 'src/main.ts',
        detail: 'path: src/main.ts',
        startedAt: '2026-11-18T10:00:00.000Z',
        finishedAt: '2026-11-18T10:00:01.500Z',
        status: 'completed',
        isVerifiedEvidence: false,
      },
      {
        id: 'tool-0-2',
        stepIndex: 0,
        nodeId: 'node-implementer',
        name: 'bash',
        target: 'npm test',
        detail: 'command: npm test',
        startedAt: '2026-11-18T10:00:02.000Z',
        finishedAt: null,
        status: 'running',
        isVerifiedEvidence: false,
      },
      {
        id: 'tool-0-3',
        stepIndex: 0,
        nodeId: 'node-implementer',
        name: 'edit_file',
        target: 'src/index.ts',
        detail: 'path: src/index.ts',
        startedAt: '2026-11-18T10:00:03.000Z',
        finishedAt: '2026-11-18T10:00:03.200Z',
        status: 'failed',
        isVerifiedEvidence: false,
      },
    ]

    render(<ToolCallTimeline tools={tools} />)

    expect(screen.getByText('read_file')).toBeTruthy()
    expect(screen.getByText('src/main.ts')).toBeTruthy()
    expect(screen.getByText(/Completed/i)).toBeTruthy()
    expect(screen.getByText('1.5s')).toBeTruthy()

    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText(/Running/i)).toBeTruthy()

    expect(screen.getByText('edit_file')).toBeTruthy()
    expect(screen.getByText('src/index.ts')).toBeTruthy()
    expect(screen.getByText(/Failed/i)).toBeTruthy()
    expect(screen.getByText('200ms')).toBeTruthy()
  })
})
