import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeViewer } from './CodeViewer'

describe('CodeViewer', () => {
  const sampleCode = `import { useState } from 'react'\n\nexport function App() {\n  return <div>Hello</div>\n}`
  const samplePatch = `--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n-old line\n+new line`

  it('renders breadcrumbs, line numbers, and tokenized code without READ-ONLY label', () => {
    render(<CodeViewer filePath="src/renderer/App.tsx" content={sampleCode} />)

    expect(screen.getByText('App.tsx')).toBeInTheDocument()
    expect(screen.getByText('renderer')).toBeInTheDocument()
    expect(screen.queryByText('READ-ONLY')).not.toBeInTheDocument()
    expect(screen.queryByText('read-only')).not.toBeInTheDocument()
    expect(screen.getByText(/5 lines/)).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('import')).toBeInTheDocument()
  })

  it('switches between code and diff modes, and toggles split diff mode', () => {
    render(
      <CodeViewer
        filePath="src/App.tsx"
        content={sampleCode}
        patch={samplePatch}
        defaultMode="diff"
      />,
    )

    expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument()
    expect(screen.getByText('+')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getAllByText('line').length).toBeGreaterThan(0)

    // Toggle split diff layout
    const splitToggle = screen.getByRole('button', { name: /Unified/i })
    fireEvent.click(splitToggle)
    expect(screen.getByRole('button', { name: /Split/i })).toBeInTheDocument()

    // Toggle word wrap
    const wrapBtn = screen.getByTitle('Word wrap')
    fireEvent.click(wrapBtn)

    // Switch back to Code mode
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByText('import')).toBeInTheDocument()
  })

  it('handles edit mode and saving', () => {
    const onSave = vi.fn()
    render(
      <CodeViewer
        filePath="src/App.tsx"
        content="const a = 1"
        onSaveFile={onSave}
      />,
    )

    expect(screen.getByRole('button', { name: 'Edit File' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit File' }))

    expect(screen.getByText('EDIT MODE')).toBeInTheDocument()
    const textarea = screen.getByPlaceholderText('Edit file contents...')
    expect(textarea).toHaveValue('const a = 1')

    fireEvent.change(textarea, { target: { value: 'const a = 2' } })
    expect(screen.getByText(/Unsaved/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(onSave).toHaveBeenCalledWith('src/App.tsx', 'const a = 2')
  })

  it('renders image placeholder for image files', () => {
    render(<CodeViewer filePath="resources/logo.png" content="" />)

    expect(screen.getAllByText('logo.png').length).toBeGreaterThan(0)
    expect(screen.getByText(/Binary image asset/)).toBeInTheDocument()
  })
})
