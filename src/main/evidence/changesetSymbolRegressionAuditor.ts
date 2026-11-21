export type ExportKind = 'FUNCTION' | 'CONST' | 'INTERFACE' | 'TYPE' | 'CLASS' | 'UNKNOWN'

export type SymbolChangeKind =
  'REMOVED_EXPORT' | 'SIGNATURE_MUTATION' | 'VISIBILITY_RESTRICTION' | 'COMPATIBLE_ADDITION'

export interface ExportSymbolDiff {
  readonly filePath: string
  readonly symbolName: string
  readonly kind: ExportKind
  readonly changeKind: SymbolChangeKind
  readonly isBreaking: boolean
  readonly severity: number
  readonly beforeSnippet?: string
  readonly afterSnippet?: string
}

export interface SymbolRegressionAuditConfig {
  readonly breakingThreshold?: number // default: 50
  readonly treatSignatureMutationAsBreaking?: boolean // default: true
}

export interface SymbolRegressionAuditResult {
  readonly hasBreakingChanges: boolean
  readonly totalSymbolChanges: number
  readonly breakingCount: number
  readonly compatibleCount: number
  readonly totalSeverityScore: number
  readonly recommendations: readonly string[]
  readonly symbolDiffs: readonly ExportSymbolDiff[]
}

interface RawExportDeclaration {
  readonly filePath: string
  readonly symbolName: string
  readonly kind: ExportKind
  readonly isExport: boolean
  readonly snippet: string
}

export class ChangesetSymbolRegressionAuditor {
  private readonly breakingThreshold: number
  private readonly treatSignatureMutationAsBreaking: boolean

  constructor(config?: SymbolRegressionAuditConfig) {
    this.breakingThreshold = config?.breakingThreshold ?? 50
    this.treatSignatureMutationAsBreaking = config?.treatSignatureMutationAsBreaking ?? true
  }

  public auditDiff(diffContent: string): SymbolRegressionAuditResult {
    const lines = diffContent.split('\n')
    let currentFile = 'unknown'

    const removedExports = new Map<string, RawExportDeclaration>()
    const addedExports = new Map<string, RawExportDeclaration>()
    const addedNonExports = new Map<string, RawExportDeclaration>()

    for (const rawLine of lines) {
      const line = rawLine.trim()

      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6)
        continue
      } else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
        currentFile = line.slice(4)
        continue
      }

      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
        continue
      }

      const isRemoval = rawLine.startsWith('-')
      const isAddition = rawLine.startsWith('+')

      if (!isRemoval && !isAddition) {
        continue
      }

      const content = rawLine.slice(1).trim()
      const parsed = this.parseExportLine(currentFile, content)
      if (!parsed) {
        continue
      }

      const key = `${currentFile}::${parsed.symbolName}`
      if (isRemoval && parsed.isExport) {
        removedExports.set(key, parsed)
      } else if (isAddition) {
        if (parsed.isExport) {
          addedExports.set(key, parsed)
        } else {
          addedNonExports.set(key, parsed)
        }
      }
    }

    const symbolDiffs: ExportSymbolDiff[] = []
    const processedKeys = new Set<string>()

    // Check removed exports
    for (const [key, rem] of removedExports.entries()) {
      processedKeys.add(key)
      const add = addedExports.get(key)
      const addNonExp = addedNonExports.get(key)

      if (add) {
        // Existed before, exists now -> check if signature mutated
        const isIdentical = rem.snippet === add.snippet
        if (!isIdentical) {
          const isBreaking = this.treatSignatureMutationAsBreaking
          const severity = isBreaking ? 25 : 10
          symbolDiffs.push({
            filePath: rem.filePath,
            symbolName: rem.symbolName,
            kind: rem.kind,
            changeKind: 'SIGNATURE_MUTATION',
            isBreaking,
            severity,
            beforeSnippet: rem.snippet,
            afterSnippet: add.snippet,
          })
        }
      } else if (addNonExp) {
        // Still exists but export keyword was dropped -> VISIBILITY_RESTRICTION
        symbolDiffs.push({
          filePath: rem.filePath,
          symbolName: rem.symbolName,
          kind: rem.kind,
          changeKind: 'VISIBILITY_RESTRICTION',
          isBreaking: true,
          severity: 40,
          beforeSnippet: rem.snippet,
          afterSnippet: addNonExp.snippet,
        })
      } else {
        // Completely removed -> REMOVED_EXPORT
        symbolDiffs.push({
          filePath: rem.filePath,
          symbolName: rem.symbolName,
          kind: rem.kind,
          changeKind: 'REMOVED_EXPORT',
          isBreaking: true,
          severity: 50,
          beforeSnippet: rem.snippet,
        })
      }
    }

    // Check newly added exports
    for (const [key, add] of addedExports.entries()) {
      if (processedKeys.has(key)) {
        continue
      }
      symbolDiffs.push({
        filePath: add.filePath,
        symbolName: add.symbolName,
        kind: add.kind,
        changeKind: 'COMPATIBLE_ADDITION',
        isBreaking: false,
        severity: 0,
        afterSnippet: add.snippet,
      })
    }

    let totalSeverityScore = 0
    let breakingCount = 0
    let compatibleCount = 0

    for (const diff of symbolDiffs) {
      totalSeverityScore += diff.severity
      if (diff.isBreaking) {
        breakingCount++
      } else {
        compatibleCount++
      }
    }

    const hasBreakingChanges = breakingCount > 0 || totalSeverityScore >= this.breakingThreshold
    const recommendations: string[] = []

    if (hasBreakingChanges) {
      recommendations.push(
        `Changeset introduces ${String(breakingCount)} breaking export regression(s) (severity: ${String(totalSeverityScore)}).`,
      )
      recommendations.push('Introduce backwards-compatible shims or increment major API version.')
    } else if (symbolDiffs.length > 0) {
      recommendations.push(
        `All ${String(symbolDiffs.length)} export modification(s) are backwards-compatible additions/non-breaking mutations.`,
      )
    } else {
      recommendations.push('No public export modifications detected.')
    }

    return {
      hasBreakingChanges,
      totalSymbolChanges: symbolDiffs.length,
      breakingCount,
      compatibleCount,
      totalSeverityScore,
      recommendations,
      symbolDiffs,
    }
  }

  private parseExportLine(filePath: string, line: string): RawExportDeclaration | null {
    // 1. export (async )?function name(...)
    const fnMatch = /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (fnMatch?.[1]) {
      return {
        filePath,
        symbolName: fnMatch[1],
        kind: 'FUNCTION',
        isExport: true,
        snippet: line,
      }
    }

    // 2. export const|let|var name
    const varMatch = /^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (varMatch?.[1]) {
      return {
        filePath,
        symbolName: varMatch[1],
        kind: 'CONST',
        isExport: true,
        snippet: line,
      }
    }

    // 3. export interface name
    const ifaceMatch = /^export\s+interface\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (ifaceMatch?.[1]) {
      return {
        filePath,
        symbolName: ifaceMatch[1],
        kind: 'INTERFACE',
        isExport: true,
        snippet: line,
      }
    }

    // 4. export type name
    const typeMatch = /^export\s+type\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (typeMatch?.[1]) {
      return {
        filePath,
        symbolName: typeMatch[1],
        kind: 'TYPE',
        isExport: true,
        snippet: line,
      }
    }

    // 5. export class name
    const classMatch = /^export\s+class\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (classMatch?.[1]) {
      return {
        filePath,
        symbolName: classMatch[1],
        kind: 'CLASS',
        isExport: true,
        snippet: line,
      }
    }

    // Non-exported declarations (to detect visibility demotions)
    const nonExpFn = /^(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (nonExpFn?.[1]) {
      return {
        filePath,
        symbolName: nonExpFn[1],
        kind: 'FUNCTION',
        isExport: false,
        snippet: line,
      }
    }

    const nonExpVar = /^(?:const|let|var)\s+([a-zA-Z0-9_$]+)/.exec(line)
    if (nonExpVar?.[1]) {
      return {
        filePath,
        symbolName: nonExpVar[1],
        kind: 'CONST',
        isExport: false,
        snippet: line,
      }
    }

    return null
  }
}
