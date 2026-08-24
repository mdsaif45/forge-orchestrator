import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DiffViewer } from './DiffViewer'

describe('DiffViewer', () => {
  const samplePatch = `--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n-import { Old } from './old'\n+import { New } from './new'\n export function App() {}`

  it('renders in read-only mode with formatted diff lines by default', () => {
    render(<DiffViewer filePath="src/App.tsx" patch={samplePatch} fileContent="original code" />)

    expect(screen.getByText('src/App.tsx')).toBeInTheDocument()
    expect(screen.getByText('READ-ONLY')).toBeInTheDocument()
    expect(screen.getByText(/import \{ New \} from '\.\/new'/)).toBeInTheDocument()
  })

  it('offers no edit affordance when the file cannot be saved', () => {
    // This case previously asserted an "Edit File" button with no `onSaveFile` passed,
    // which encoded a real defect: the button opened an editor whose save handler
    // returned silently, so typed changes were discarded without a word. Used by the
    // Explorer view, where browsing for context must not become an editor (#107).
    render(<DiffViewer filePath="src/App.tsx" patch={samplePatch} fileContent="original code" />)

    expect(screen.queryByRole('button', { name: 'Edit File' })).not.toBeInTheDocument()
    expect(screen.getByText('read-only')).toBeInTheDocument()
  })

  it('offers editing when a save handler is supplied', () => {
    render(
      <DiffViewer
        filePath="src/App.tsx"
        patch={samplePatch}
        fileContent="original code"
        onSaveFile={() => undefined}
      />,
    )

    expect(screen.getByRole('button', { name: 'Edit File' })).toBeInTheDocument()
  })

  it('switches to edit mode and allows saving modified contents', () => {
    const onSave = vi.fn()
    render(
      <DiffViewer
        filePath="src/App.tsx"
        patch={samplePatch}
        fileContent="original code"
        onSaveFile={onSave}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit File' }))
    expect(screen.getByText('EDIT MODE (User-Authored)')).toBeInTheDocument()

    const textarea = screen.getByPlaceholderText('Edit file contents...')
    expect(textarea).toHaveValue('original code')

    fireEvent.change(textarea, { target: { value: 'user modified code' } })
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()

    const saveBtn = screen.getByRole('button', { name: 'Save Changes' })
    fireEvent.click(saveBtn)

    expect(onSave).toHaveBeenCalledWith('src/App.tsx', 'user modified code')
  })

  it('renders discrepancy warning banners when present', () => {
    render(
      <DiffViewer
        filePath="src/App.tsx"
        patch={samplePatch}
        discrepancies={[
          {
            path: 'src/App.tsx',
            kind: 'outside-scope',
            detail: 'File modified outside allowedPaths',
          },
        ]}
      />,
    )

    expect(screen.getByText(/Discrepancy \(outside-scope\):/)).toBeInTheDocument()
    expect(screen.getByText('File modified outside allowedPaths')).toBeInTheDocument()
  })
})
