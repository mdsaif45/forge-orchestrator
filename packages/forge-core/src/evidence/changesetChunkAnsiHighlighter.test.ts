import { describe, expect, it } from 'vitest'
import { ChangesetChunkAnsiHighlighter } from './changesetChunkAnsiHighlighter'

describe('ChangesetChunkAnsiHighlighter', () => {
  const sampleDiff = [
    'diff --git a/src/index.ts b/src/index.ts',
    'index 1234567..89abcdef 100644',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '@@ -10,4 +10,5 @@ export function run() {',
    '   const a = 1;',
    '-  const b = 2;',
    '+  const b = 20;',
    '+  const c = 30;',
    '   return a + b;',
  ].join('\n')

  it('correctly strips ANSI escape codes', () => {
    const colored = '\x1b[32m+ added line\x1b[0m'
    expect(ChangesetChunkAnsiHighlighter.stripAnsi(colored)).toBe('+ added line')
  })

  it('parses diff headers and extracts detected file path', () => {
    const highlighter = new ChangesetChunkAnsiHighlighter()
    const report = highlighter.highlight(sampleDiff)

    expect(report.filePath).toBe('src/index.ts')
    expect(report.hunksCount).toBe(1)
    expect(report.additionsCount).toBe(2)
    expect(report.deletionsCount).toBe(1)
  })

  it('computes old and new line numbers accurately in the gutter', () => {
    const highlighter = new ChangesetChunkAnsiHighlighter()
    const report = highlighter.highlight(sampleDiff, { colorEnabled: false })

    const hunkMetaLine = report.lines.find((l) => l.lineType === 'hunk_meta')
    expect(hunkMetaLine).toBeDefined()

    const contextLine = report.lines.find((l) => l.rawContent === '   const a = 1;')
    expect(contextLine?.oldLineNumber).toBe(10)
    expect(contextLine?.newLineNumber).toBe(10)

    const delLine = report.lines.find((l) => l.lineType === 'deletion')
    expect(delLine?.oldLineNumber).toBe(11)
    expect(delLine?.newLineNumber).toBeUndefined()

    const addLines = report.lines.filter((l) => l.lineType === 'addition')
    expect(addLines[0]?.newLineNumber).toBe(11)
    expect(addLines[1]?.newLineNumber).toBe(12)
  })

  it('injects ANSI color codes when colorEnabled is true', () => {
    const highlighter = new ChangesetChunkAnsiHighlighter()
    const report = highlighter.highlight(sampleDiff, { colorEnabled: true })

    expect(report.renderedAnsi).toContain('\x1b[32m') // green for addition
    expect(report.renderedAnsi).toContain('\x1b[31m') // red for deletion
    expect(report.renderedAnsi).toContain('\x1b[36m') // cyan for hunk
    expect(report.renderedClean).not.toContain('\x1b[')
  })

  it('disables gutters when includeLineNumbers is false', () => {
    const highlighter = new ChangesetChunkAnsiHighlighter()
    const report = highlighter.highlight(sampleDiff, {
      includeLineNumbers: false,
      colorEnabled: false,
    })

    const addLine = report.lines.find((l) => l.lineType === 'addition')
    expect(addLine?.cleanContent).toBe('+  const b = 20;')
    expect(addLine?.cleanContent).not.toContain('|')
  })

  it('handles multiple consecutive hunks and resets offsets', () => {
    const multiHunkDiff = [
      '@@ -1,2 +1,2 @@',
      '-line1',
      '+line1_modified',
      ' line2',
      '@@ -50,2 +50,2 @@',
      ' line50',
      '+line51_added',
    ].join('\n')

    const highlighter = new ChangesetChunkAnsiHighlighter()
    const report = highlighter.highlight(multiHunkDiff)

    expect(report.hunksCount).toBe(2)
    expect(report.lines[1]?.oldLineNumber).toBe(1)
    expect(report.lines[6]?.newLineNumber).toBe(51)
  })
})
