import { describe, it, expect } from 'vitest'
import { auditDependencyCycles, extractImportSpecifiers } from './dependencyCycleAuditor'

describe('DependencyCycleAuditor (EVIDENCE-011)', () => {
  it('extracts ESM imports, exports, and CJS require calls', () => {
    const code = `
      import { foo } from './foo'
      import bar from '../bar'
      export * from './baz'
      const qux = require('./qux')
      const dynamic = await import('./dynamic')
    `
    const specs = extractImportSpecifiers(code)
    expect(specs).toContain('./foo')
    expect(specs).toContain('../bar')
    expect(specs).toContain('./baz')
    expect(specs).toContain('./qux')
    expect(specs).toContain('./dynamic')
  })

  it('reports clean DAG when no cycles exist', () => {
    const files: Record<string, string> = {
      'src/a.ts': "import { b } from './b'",
      'src/b.ts': "import { c } from './c'",
      'src/c.ts': 'export const c = 1',
    }

    const report = auditDependencyCycles(files)
    expect(report.valid).toBe(true)
    expect(report.hasCycles).toBe(false)
    expect(report.cycles).toHaveLength(0)
    expect(report.formattedSummary).toContain('CLEAN')
  })

  it('detects direct 2-node circular dependency (A -> B -> A)', () => {
    const files: Record<string, string> = {
      'src/a.ts': "import { b } from './b'",
      'src/b.ts': "import { a } from './a'",
    }

    const report = auditDependencyCycles(files)
    expect(report.valid).toBe(false)
    expect(report.hasCycles).toBe(true)
    expect(report.cycles.length).toBeGreaterThan(0)
    const firstCycle = report.cycles[0]
    expect(firstCycle).toBeDefined()
    expect(firstCycle?.join(' -> ')).toContain('src/a.ts')
    expect(firstCycle?.join(' -> ')).toContain('src/b.ts')
  })

  it('detects indirect 3-node cycle (A -> B -> C -> A)', () => {
    const files: Record<string, string> = {
      'src/a.ts': "import { b } from './b'",
      'src/b.ts': "import { c } from './c'",
      'src/c.ts': "import { a } from './a'",
    }

    const report = auditDependencyCycles(files)
    expect(report.valid).toBe(false)
    expect(report.hasCycles).toBe(true)
    expect(report.cycles[0]).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'])
  })

  it('ignores external library imports (non-relative)', () => {
    const files: Record<string, string> = {
      'src/index.ts': "import express from 'express'; import { join } from 'node:path';",
    }

    const report = auditDependencyCycles(files)
    expect(report.valid).toBe(true)
    expect(report.hasCycles).toBe(false)
  })
})
