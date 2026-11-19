import { runIdSchema } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export interface FileCoverageData {
  readonly filePath: string
  readonly lines: ReadonlyMap<number, number> // lineNumber -> executionCount
}

export interface ModifiedFileLineCoverage {
  readonly filePath: string
  readonly totalModifiedLines: number
  readonly coveredModifiedLines: number
  readonly uncoveredModifiedLines: readonly number[]
  readonly coveragePct: number
}

export interface CoverageAuditReport {
  readonly valid: boolean
  readonly meetsThreshold: boolean
  readonly minCoveragePct: number
  readonly overallModifiedCoveragePct: number
  readonly totalModifiedLines: number
  readonly coveredModifiedLines: number
  readonly files: readonly ModifiedFileLineCoverage[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Parses LCOV standard format text into structured file line-coverage data (Axiom A3).
 */
export function parseLcov(lcovText: string): Map<string, FileCoverageData> {
  const result = new Map<string, FileCoverageData>()
  const lines = lcovText.split(/\r?\n/)

  let currentFile: string | null = null
  let currentLines = new Map<number, number>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('SF:')) {
      currentFile = trimmed.slice(3).trim()
      currentLines = new Map<number, number>()
    } else if (trimmed.startsWith('DA:')) {
      const parts = trimmed.slice(3).split(',')
      const lineNum = parts[0] ? parseInt(parts[0], 10) : NaN
      const execCount = parts[1] ? parseInt(parts[1], 10) : NaN
      if (!isNaN(lineNum) && !isNaN(execCount)) {
        currentLines.set(lineNum, execCount)
      }
    } else if (trimmed === 'end_of_record') {
      if (currentFile) {
        // Normalize path separators
        const norm = currentFile.replace(/\\/g, '/')
        result.set(norm, {
          filePath: norm,
          lines: currentLines,
        })
      }
      currentFile = null
    }
  }

  return result
}

/**
 * Extracts line numbers of newly added/modified lines in each file from a unified git diff.
 */
export function extractModifiedLineNumbers(diffText: string): Map<string, number[]> {
  const fileLines = new Map<string, number[]>()
  const lines = diffText.split(/\r?\n/)

  let currentFile: string | null = null
  let currentNewLineNum = 0

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      currentFile = match?.[2] ? match[2].replace(/\\/g, '/') : null
      if (currentFile && !fileLines.has(currentFile)) {
        fileLines.set(currentFile, [])
      }
      continue
    }

    if (!currentFile) continue

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunkMatch) {
      currentNewLineNum = parseInt(hunkMatch[3] ?? '1', 10)
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const list = fileLines.get(currentFile)
      if (list) {
        list.push(currentNewLineNum)
      }
      currentNewLineNum++
    } else if (!line.startsWith('-')) {
      // Context line
      currentNewLineNum++
    }
  }

  return fileLines
}

/**
 * Correlates modified diff lines with coverage data and checks against the minimum threshold (Axioms A2, A3).
 */
export function auditChangesetCoverage(
  diffText: string,
  coverageMap: Map<string, FileCoverageData>,
  minCoveragePct = 80,
): CoverageAuditReport {
  const modifiedMap = extractModifiedLineNumbers(diffText)
  const files: ModifiedFileLineCoverage[] = []

  let totalModified = 0
  let totalCovered = 0

  for (const [filePath, modifiedLines] of modifiedMap.entries()) {
    // Only inspect source files (ignore test files, json, markdown from coverage requirements)
    const isSource =
      /\.(ts|tsx|js|jsx|py|go|rs|c|cpp|java)$/i.test(filePath) &&
      !filePath.includes('.test.') &&
      !filePath.includes('.spec.')
    if (!isSource || modifiedLines.length === 0) continue

    // Find coverage entry matching the end of the filePath
    let covEntry: FileCoverageData | undefined = coverageMap.get(filePath)
    if (!covEntry) {
      for (const [covPath, data] of coverageMap.entries()) {
        if (covPath.endsWith(filePath) || filePath.endsWith(covPath)) {
          covEntry = data
          break
        }
      }
    }

    const uncovered: number[] = []
    let coveredCount = 0

    for (const lineNum of modifiedLines) {
      const count = covEntry?.lines.get(lineNum)
      if (count !== undefined && count > 0) {
        coveredCount++
      } else {
        uncovered.push(lineNum)
      }
    }

    const pct =
      modifiedLines.length > 0 ? Math.round((coveredCount / modifiedLines.length) * 100) : 100
    totalModified += modifiedLines.length
    totalCovered += coveredCount

    files.push({
      filePath,
      totalModifiedLines: modifiedLines.length,
      coveredModifiedLines: coveredCount,
      uncoveredModifiedLines: uncovered,
      coveragePct: pct,
    })
  }

  const overallPct = totalModified > 0 ? Math.round((totalCovered / totalModified) * 100) : 100
  const meetsThreshold = overallPct >= minCoveragePct

  const summaryLines: string[] = [
    `CODE COVERAGE DELTA AUDIT (Threshold: ${String(minCoveragePct)}%)`,
    `  Overall Modified Line Coverage: ${String(overallPct)}% (${String(totalCovered)}/${String(totalModified)} lines)`,
    `  Status: ${meetsThreshold ? 'PASSED' : 'FAILED - Coverage below required threshold'}`,
  ]

  if (files.length > 0) {
    summaryLines.push('\nPer-File Modified Coverage:')
    for (const f of files) {
      summaryLines.push(
        `  • ${f.filePath}: ${String(f.coveragePct)}% (${String(f.coveredModifiedLines)}/${String(f.totalModifiedLines)})` +
          (f.uncoveredModifiedLines.length > 0
            ? ` [Uncovered lines: ${f.uncoveredModifiedLines.slice(0, 10).join(', ')}]`
            : ''),
      )
    }
  }

  return {
    valid: true,
    meetsThreshold,
    minCoveragePct,
    overallModifiedCoveragePct: overallPct,
    totalModifiedLines: totalModified,
    coveredModifiedLines: totalCovered,
    files,
    formattedSummary: summaryLines.join('\n'),
    ...(!meetsThreshold
      ? {
          error: `Coverage ${String(overallPct)}% is below required minimum ${String(minCoveragePct)}%`,
        }
      : {}),
  }
}

/**
 * Audits test coverage for a specific run from its changeset diff and LCOV artifacts.
 */
export async function auditRunCoverage(
  artifacts: ArtifactService,
  artifactStore: ArtifactStore,
  runId: string,
  options: {
    readonly minCoveragePct?: number
    readonly customLcovText?: string
  } = {},
): Promise<CoverageAuditReport> {
  const parsedRunId = runIdSchema.parse(runId)
  const list = artifactStore.listForRun(parsedRunId)

  // 1. Gather diff text
  const diffArtifacts = list.filter((a) => a.kind === 'changeset' || a.kind === 'diff')
  let diffText = ''
  for (const a of diffArtifacts) {
    try {
      const text = await artifacts.readArtifactText(a.id)
      diffText += text + '\n'
    } catch {
      // Ignore unreadable
    }
  }

  // 2. Gather LCOV text
  let lcovText = options.customLcovText ?? ''
  if (!lcovText) {
    const lcovArtifact = list.find(
      (a) => a.name.endsWith('.info') || a.name.includes('coverage') || a.name.includes('lcov'),
    )
    if (lcovArtifact) {
      try {
        lcovText = await artifacts.readArtifactText(lcovArtifact.id)
      } catch {
        // Ignore
      }
    }
  }

  const coverageMap = lcovText ? parseLcov(lcovText) : new Map<string, FileCoverageData>()
  return auditChangesetCoverage(diffText, coverageMap, options.minCoveragePct ?? 80)
}
