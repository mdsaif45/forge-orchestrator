import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChangedFileView, DiscrepancyView } from '@shared/ipc'
import { FileTree } from './FileTree'

describe('FileTree', () => {
  const files: ChangedFileView[] = [
    {
      path: 'src/services/AuthService.ts',
      changeType: 'modified',
      previousPath: null,
      insertions: 24,
      deletions: 6,
    },
    {
      path: 'src/models/User.ts',
      changeType: 'added',
      previousPath: null,
      insertions: 40,
      deletions: 0,
    },
  ]

  const discrepancies: DiscrepancyView[] = [
    {
      path: 'src/services/AuthService.ts',
      kind: 'outside-scope',
      detail: 'File modified outside allowed scope',
    },
  ]

  it('renders file items with status letters and diff counts', () => {
    const onSelect = vi.fn()
    render(
      <FileTree
        files={files}
        selectedPath="src/services/AuthService.ts"
        onSelectFile={onSelect}
        discrepancies={discrepancies}
      />,
    )

    expect(screen.getByText('src/services/AuthService.ts')).toBeInTheDocument()
    expect(screen.getByText('+24')).toBeInTheDocument()
    expect(screen.getByText('-6')).toBeInTheDocument()
    expect(screen.getByText('M')).toBeInTheDocument()

    expect(screen.getByText('src/models/User.ts')).toBeInTheDocument()
    expect(screen.getByText('+40')).toBeInTheDocument()
    expect(screen.getByText('A')).toBeInTheDocument()

    fireEvent.click(screen.getByText('src/models/User.ts'))
    expect(onSelect).toHaveBeenCalledWith('src/models/User.ts')
  })
})
