import { describe, it, expect } from 'vitest'
import { selectAffectedTestSuites, type ChangeImpactOptions } from './changeImpactSelector'

describe('changeImpactSelector (EVIDENCE-015)', () => {
  const allTests = [
    'src/main/core/parser.test.ts',
    'src/main/core/runner.test.ts',
    'src/main/db/store.test.ts',
    'src/main/workflows/engine.test.ts',
  ]

  const dependencyMap: Record<string, readonly string[]> = {
    'src/main/core/parser.ts': ['src/main/core/runner.ts'], // runner imports parser
    'src/main/core/runner.ts': ['src/main/workflows/engine.ts'], // engine imports runner
  }

  it('selects direct unit test when source file changes', () => {
    const changed = ['src/main/db/store.ts']
    const report = selectAffectedTestSuites(changed, dependencyMap, allTests)

    expect(report.isGlobalImpact).toBe(false)
    expect(report.directlyImpactedTests).toEqual(['src/main/db/store.test.ts'])
    expect(report.transitivelyImpactedTests).toHaveLength(0)
    expect(report.selectedTestSuites).toEqual(['src/main/db/store.test.ts'])
    expect(report.formattedSummary).toContain('[Change Impact TARGETED] Selected 1/4 suites')
  })

  it('includes transitively dependent test suites up to bounded depth', () => {
    const changed = ['src/main/core/parser.ts']
    const report = selectAffectedTestSuites(changed, dependencyMap, allTests)

    expect(report.isGlobalImpact).toBe(false)
    expect(report.directlyImpactedTests).toContain('src/main/core/parser.test.ts')
    expect(report.transitivelyImpactedTests).toContain('src/main/core/runner.test.ts')
    expect(report.transitivelyImpactedTests).toContain('src/main/workflows/engine.test.ts')
    expect(report.totalSuitesSelected).toBe(3)
  })

  it('triggers full test suite run when global configuration file changes (Axiom A1)', () => {
    const changed = ['package.json']
    const report = selectAffectedTestSuites(changed, dependencyMap, allTests)

    expect(report.isGlobalImpact).toBe(true)
    expect(report.globalImpactReason).toContain('Global file modified')
    expect(report.totalSuitesSelected).toBe(allTests.length)
    expect(report.selectedTestSuites).toEqual(allTests)
    expect(report.formattedSummary).toContain('[Change Impact GLOBAL]')
  })

  it('triggers full run when shared domain primitive changes', () => {
    const changed = ['src/shared/domain/events.ts']
    const report = selectAffectedTestSuites(changed, dependencyMap, allTests)

    expect(report.isGlobalImpact).toBe(true)
    expect(report.totalSuitesSelected).toBe(4)
  })

  it('respects custom global impact patterns', () => {
    const changed = ['custom-config.yaml']
    const options: ChangeImpactOptions = {
      globalImpactPatterns: [/\.yaml$/i],
    }
    const report = selectAffectedTestSuites(changed, dependencyMap, allTests, options)

    expect(report.isGlobalImpact).toBe(true)
  })
})
