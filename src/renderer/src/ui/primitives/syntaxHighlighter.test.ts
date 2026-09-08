import { describe, expect, it } from 'vitest'
import {
  buildSplitDiff,
  detectLanguage,
  highlightCode,
  highlightLine,
  parseDiffLines,
} from './syntaxHighlighter'

describe('syntaxHighlighter', () => {
  it('detects language based on extension', () => {
    expect(detectLanguage('App.tsx')).toBe('typescript')
    expect(detectLanguage('script.js')).toBe('javascript')
    expect(detectLanguage('package.json')).toBe('json')
    expect(detectLanguage('styles.css')).toBe('css')
    expect(detectLanguage('README.md')).toBe('markdown')
    expect(detectLanguage('main.py')).toBe('python')
    expect(detectLanguage('lib.rs')).toBe('rust')
    expect(detectLanguage('query.sql')).toBe('sql')
    expect(detectLanguage('.gitignore')).toBe('shell')
  })

  it('tokenizes TypeScript code lines', () => {
    const line = "import { useState } from 'react'"
    const tokens = highlightLine(line, 'typescript')

    expect(tokens.some((t) => t.text === 'import' && t.type === 'keyword')).toBe(true)
    expect(tokens.some((t) => t.text === 'from' && t.type === 'keyword')).toBe(true)
    expect(tokens.some((t) => t.text === "'react'" && t.type === 'string')).toBe(true)
  })

  it('tokenizes JSON lines with property keys and values', () => {
    const line = '  "name": "forge", "count": 42, "active": true'
    const tokens = highlightLine(line, 'json')

    expect(tokens.some((t) => t.text === '"name"' && t.type === 'property')).toBe(true)
    expect(tokens.some((t) => t.text === '"forge"' && t.type === 'string')).toBe(true)
    expect(tokens.some((t) => t.text === '42' && t.type === 'number')).toBe(true)
    expect(tokens.some((t) => t.text === 'true' && t.type === 'constant')).toBe(true)
  })

  it('tokenizes diff lines with hunk headers and additions/deletions', () => {
    const lines = [
      'diff --git a/foo.ts b/foo.ts',
      '@@ -1,3 +1,4 @@',
      '+added line',
      '-removed line',
    ]

    const tokens = highlightCode(lines.join('\n'), 'diff')
    expect(tokens[0]?.[0]?.type).toBe('diff-header')
    expect(tokens[1]?.[0]?.type).toBe('diff-hunk')
    expect(tokens[2]?.[0]?.type).toBe('diff-add')
    expect(tokens[3]?.[0]?.type).toBe('diff-del')
  })

  it('parses structured diff lines with dual line numbers and embedded syntax highlighting', () => {
    const patch = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -8,4 +8,5 @@
   "name": "forge",
-  "version": "0.1.0",
+  "version": "0.2.0",
+  "private": true,
   "scripts": {}`

    const parsed = parseDiffLines(patch, 'package.json')
    expect(parsed).toHaveLength(9)
    expect(parsed[0]?.type).toBe('header')
    expect(parsed[3]?.type).toBe('hunk')

    // Context line "name": "forge"
    const contextLine = parsed[4]
    expect(contextLine?.type).toBe('context')
    expect(contextLine?.oldLineNumber).toBe(8)
    expect(contextLine?.newLineNumber).toBe(8)

    // Deletion line
    const delLine = parsed[5]
    expect(delLine?.type).toBe('del')
    expect(delLine?.oldLineNumber).toBe(9)
    expect(delLine?.newLineNumber).toBeNull()

    // Addition lines
    const addLine1 = parsed[6]
    expect(addLine1?.type).toBe('add')
    expect(addLine1?.oldLineNumber).toBeNull()
    expect(addLine1?.newLineNumber).toBe(9)
    // Verify syntax highlighting is applied inside addition
    expect(addLine1?.tokens.some((t) => t.type === 'property')).toBe(true)

    const addLine2 = parsed[7]
    expect(addLine2?.type).toBe('add')
    expect(addLine2?.newLineNumber).toBe(10)
    expect(addLine2?.tokens.some((t) => t.text === 'true' && t.type === 'constant')).toBe(true)
  })

  it('builds aligned side-by-side split diff rows', () => {
    const patch = `@@ -1,2 +1,2 @@
-old line
+new line
 context`

    const parsed = parseDiffLines(patch, 'test.ts')
    const split = buildSplitDiff(parsed)

    expect(split.some((s) => s.isHunk)).toBe(true)
    const pairedRow = split.find((s) => s.oldLine?.type === 'del' && s.newLine?.type === 'add')
    expect(pairedRow).toBeDefined()
    expect(pairedRow?.oldLine?.lineNumber).toBe(1)
    expect(pairedRow?.newLine?.lineNumber).toBe(1)
  })
})
