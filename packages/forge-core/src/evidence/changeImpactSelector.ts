/**
 * EVIDENCE-015: Source Code Change Impact & Affected Test Suite Selector
 *
 * Maps modified files from a changeset against project dependency relationships and test metadata
 * to select the minimal and sufficient set of affected test suites to execute.
 * Fails closed to full test execution when global configuration or shared domain primitives change.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed fallback to all suites upon global impact.
 * - A3: Physical evidence based on import dependency graph.
 * - A5: Bounded transitive search depth.
 */

export interface ChangeImpactOptions {
  readonly globalImpactPatterns?: readonly RegExp[] | undefined
  readonly maxTransitiveDepth?: number | undefined
}

export interface ImpactAnalysisReport {
  readonly changedFiles: readonly string[]
  readonly isGlobalImpact: boolean
  readonly globalImpactReason?: string | undefined
  readonly directlyImpactedTests: readonly string[]
  readonly transitivelyImpactedTests: readonly string[]
  readonly selectedTestSuites: readonly string[]
  readonly totalSuitesSelected: number
  readonly totalSuitesAvailable: number
  readonly formattedSummary: string
}

export const DEFAULT_GLOBAL_IMPACT_PATTERNS: readonly RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^tsconfig.*\.json$/i,
  /^vite.*\.ts$/i,
  /^eslint.*\.js$/i,
  /^scripts\//i,
  /^src\/shared\/domain\//i,
]

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Analyzes changed files and selects affected test suites based on dependency impact.
 *
 * @param changedFiles List of modified file paths in the changeset.
 * @param dependencyMap Map from file path to list of other files that import it (reverse dependencies).
 * @param availableTestFiles List of all known test files in the workspace.
 * @param options Configuration options for impact detection.
 */
export function selectAffectedTestSuites(
  changedFiles: readonly string[],
  dependencyMap: Record<string, readonly string[]>,
  availableTestFiles: readonly string[],
  options?: ChangeImpactOptions,
): ImpactAnalysisReport {
  const globalPatterns = options?.globalImpactPatterns ?? DEFAULT_GLOBAL_IMPACT_PATTERNS
  const maxDepth = Math.max(1, Math.min(10, options?.maxTransitiveDepth ?? 5))

  const normalizedTestFiles = availableTestFiles.map((f) => ({
    original: f,
    normalized: normalizePath(f),
  }))

  // 1. Check for global impact triggers
  for (const changed of changedFiles) {
    const normChanged = normalizePath(changed)
    for (const pattern of globalPatterns) {
      if (pattern.test(normChanged)) {
        const reason = `Global file modified: '${changed}' matches pattern ${pattern.toString()}`
        return {
          changedFiles,
          isGlobalImpact: true,
          globalImpactReason: reason,
          directlyImpactedTests: [...availableTestFiles],
          transitivelyImpactedTests: [],
          selectedTestSuites: [...availableTestFiles],
          totalSuitesSelected: availableTestFiles.length,
          totalSuitesAvailable: availableTestFiles.length,
          formattedSummary: `[Change Impact GLOBAL] ${reason}. Selected all ${String(availableTestFiles.length)} test suites.`,
        }
      }
    }
  }

  // 2. Identify directly affected test files
  const directTestSet = new Set<string>()
  for (const changed of changedFiles) {
    const norm = normalizePath(changed)
    // If a test file itself was edited
    if (norm.includes('.test.') || norm.includes('.spec.')) {
      directTestSet.add(changed)
      continue
    }

    // Direct unit test pair candidate (e.g. `src/foo.ts` -> `src/foo.test.ts`)
    const baseName = norm.replace(/\.(ts|js|tsx|jsx)$/, '')
    for (const testFile of normalizedTestFiles) {
      if (testFile.normalized.startsWith(baseName) && testFile.normalized.includes('.test.')) {
        directTestSet.add(testFile.original)
      }
    }
  }

  // 3. Trace transitive dependents through reverse dependency map
  const affectedSourceFiles = new Set<string>()
  const visited = new Set<string>()

  function traceDependents(file: string, currentDepth: number): void {
    if (currentDepth > maxDepth || visited.has(file)) {
      return
    }
    visited.add(file)

    const dependents = dependencyMap[file] ?? dependencyMap[normalizePath(file)] ?? []
    for (const dep of dependents) {
      affectedSourceFiles.add(dep)
      traceDependents(dep, currentDepth + 1)
    }
  }

  for (const changed of changedFiles) {
    traceDependents(changed, 1)
  }

  // 4. Map transitively affected source files to their test suites
  const transitiveTestSet = new Set<string>()
  for (const affected of affectedSourceFiles) {
    const norm = normalizePath(affected)
    if (norm.includes('.test.') || norm.includes('.spec.')) {
      if (!directTestSet.has(affected)) {
        transitiveTestSet.add(affected)
      }
      continue
    }

    const baseName = norm.replace(/\.(ts|js|tsx|jsx)$/, '')
    for (const testFile of normalizedTestFiles) {
      if (testFile.normalized.startsWith(baseName) && testFile.normalized.includes('.test.')) {
        if (!directTestSet.has(testFile.original)) {
          transitiveTestSet.add(testFile.original)
        }
      }
    }
  }

  const directlyImpactedTests = Array.from(directTestSet).sort()
  const transitivelyImpactedTests = Array.from(transitiveTestSet).sort()
  const allSelectedSet = new Set<string>([...directlyImpactedTests, ...transitivelyImpactedTests])
  const selectedTestSuites = Array.from(allSelectedSet).sort()

  const formattedSummary =
    `[Change Impact TARGETED] Selected ${String(selectedTestSuites.length)}/${String(availableTestFiles.length)} ` +
    `suites (Direct: ${String(directlyImpactedTests.length)}, Transitive: ${String(transitivelyImpactedTests.length)})`

  return {
    changedFiles,
    isGlobalImpact: false,
    directlyImpactedTests,
    transitivelyImpactedTests,
    selectedTestSuites,
    totalSuitesSelected: selectedTestSuites.length,
    totalSuitesAvailable: availableTestFiles.length,
    formattedSummary,
  }
}
