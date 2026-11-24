/**
 * EVIDENCE-008: Changeset AST-aware syntactic impact and export surface auditor.
 * Audits public export symbol deltas, identifying breaking contract changes in git diffs (Axioms A1, A3).
 */

export type ExportChangeKind = 'added' | 'removed' | 'modified'
export type ExportRiskTier = 'low' | 'medium' | 'high'
export type ExportSymbolKind = 'function' | 'const' | 'type' | 'interface' | 'class' | 'variable'

export interface ExportSymbolChange {
  readonly filePath: string
  readonly symbol: string
  readonly changeKind: ExportChangeKind
  readonly symbolKind: ExportSymbolKind
  readonly rawLine: string
  readonly isBreaking: boolean
}

export interface ExportSurfaceReport {
  readonly valid: boolean
  readonly runId?: string | undefined
  readonly totalFilesScanned: number
  readonly totalChanges: number
  readonly addedCount: number
  readonly modifiedCount: number
  readonly removedCount: number
  readonly riskTier: ExportRiskTier
  readonly changes: readonly ExportSymbolChange[]
  readonly formattedSummary: string
}

const JS_TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

const FUNC_EXPORT_RE = /^export\s+(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/
const CONST_EXPORT_RE = /^export\s+const\s+([a-zA-Z0-9_$]+)/
const VAR_EXPORT_RE = /^export\s+(?:let|var)\s+([a-zA-Z0-9_$]+)/
const IFACE_EXPORT_RE = /^export\s+interface\s+([a-zA-Z0-9_$]+)/
const TYPE_EXPORT_RE = /^export\s+type\s+([a-zA-Z0-9_$]+)/
const CLASS_EXPORT_RE = /^export\s+(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/
const DIFF_GIT_RE = /^diff --git a\/(.+?)\s+b\/(.+)$/

interface ExtractedSymbol {
  readonly name: string
  readonly kind: ExportSymbolKind
  readonly rawLine: string
}

function parseExportLine(line: string): ExtractedSymbol | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('export')) {
    return null
  }

  // function
  const funcMatch = FUNC_EXPORT_RE.exec(trimmed)
  if (funcMatch?.[1]) {
    return { name: funcMatch[1], kind: 'function', rawLine: trimmed }
  }

  // const
  const constMatch = CONST_EXPORT_RE.exec(trimmed)
  if (constMatch?.[1]) {
    return { name: constMatch[1], kind: 'const', rawLine: trimmed }
  }

  // let / var
  const varMatch = VAR_EXPORT_RE.exec(trimmed)
  if (varMatch?.[1]) {
    return { name: varMatch[1], kind: 'variable', rawLine: trimmed }
  }

  // interface
  const ifaceMatch = IFACE_EXPORT_RE.exec(trimmed)
  if (ifaceMatch?.[1]) {
    return { name: ifaceMatch[1], kind: 'interface', rawLine: trimmed }
  }

  // type
  const typeMatch = TYPE_EXPORT_RE.exec(trimmed)
  if (typeMatch?.[1]) {
    return { name: typeMatch[1], kind: 'type', rawLine: trimmed }
  }

  // class
  const classMatch = CLASS_EXPORT_RE.exec(trimmed)
  if (classMatch?.[1]) {
    return { name: classMatch[1], kind: 'class', rawLine: trimmed }
  }

  return null
}

/**
 * Audits a unified git patch for changes to exported symbols (Axioms A1, A3).
 */
export function auditChangesetExportSurface(diffText: string, runId?: string): ExportSurfaceReport {
  if (!diffText || diffText.trim().length === 0) {
    return {
      valid: true,
      runId,
      totalFilesScanned: 0,
      totalChanges: 0,
      addedCount: 0,
      modifiedCount: 0,
      removedCount: 0,
      riskTier: 'low',
      changes: [],
      formattedSummary: 'CHANGESET EXPORT SURFACE AUDIT: Clean diff (0 export changes detected).',
    }
  }

  const lines = diffText.split(/\r?\n/)
  let currentFile: string | null = null
  let isAuditableFile = false

  const scannedFiles = new Set<string>()
  const removedMap = new Map<string, { symbol: ExtractedSymbol; filePath: string }>()
  const addedMap = new Map<string, { symbol: ExtractedSymbol; filePath: string }>()

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = DIFF_GIT_RE.exec(line)
      currentFile = match?.[2] ?? null
      if (currentFile) {
        isAuditableFile = JS_TS_EXTENSIONS.some((ext) => currentFile?.endsWith(ext))
        if (isAuditableFile) {
          scannedFiles.add(currentFile)
        }
      }
      continue
    }

    if (!isAuditableFile || !currentFile) {
      continue
    }

    // Skip diff metadata headers
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue
    }

    if (line.startsWith('-')) {
      const parsed = parseExportLine(line.slice(1))
      if (parsed) {
        const key = `${currentFile}:${parsed.name}`
        removedMap.set(key, { symbol: parsed, filePath: currentFile })
      }
    } else if (line.startsWith('+')) {
      const parsed = parseExportLine(line.slice(1))
      if (parsed) {
        const key = `${currentFile}:${parsed.name}`
        addedMap.set(key, { symbol: parsed, filePath: currentFile })
      }
    }
  }

  const allKeys = new Set([...removedMap.keys(), ...addedMap.keys()])
  const changes: ExportSymbolChange[] = []

  let addedCount = 0
  let modifiedCount = 0
  let removedCount = 0

  for (const key of Array.from(allKeys).sort()) {
    const removed = removedMap.get(key)
    const added = addedMap.get(key)

    if (removed && added) {
      modifiedCount++
      const isBreaking = removed.symbol.rawLine !== added.symbol.rawLine
      changes.push({
        filePath: added.filePath,
        symbol: added.symbol.name,
        changeKind: 'modified',
        symbolKind: added.symbol.kind,
        rawLine: added.symbol.rawLine,
        isBreaking,
      })
    } else if (removed && !added) {
      removedCount++
      changes.push({
        filePath: removed.filePath,
        symbol: removed.symbol.name,
        changeKind: 'removed',
        symbolKind: removed.symbol.kind,
        rawLine: removed.symbol.rawLine,
        isBreaking: true,
      })
    } else if (added && !removed) {
      addedCount++
      changes.push({
        filePath: added.filePath,
        symbol: added.symbol.name,
        changeKind: 'added',
        symbolKind: added.symbol.kind,
        rawLine: added.symbol.rawLine,
        isBreaking: false,
      })
    }
  }

  let riskTier: ExportRiskTier = 'low'
  if (removedCount > 0 || changes.some((c) => c.isBreaking && c.changeKind === 'removed')) {
    riskTier = 'high'
  } else if (modifiedCount > 0) {
    riskTier = 'medium'
  }

  const summaryLines = [
    '================================================================================',
    'CHANGESET EXPORT SURFACE IMPACT AUDIT (EVIDENCE-008)',
    '================================================================================',
    `Files Scanned:       ${String(scannedFiles.size)}`,
    `Total Export Changes: ${String(changes.length)}`,
    `  • Added:           ${String(addedCount)}`,
    `  • Modified:        ${String(modifiedCount)}`,
    `  • Removed:         ${String(removedCount)}`,
    `Risk Assessment:     ${riskTier.toUpperCase()} RISK`,
    '================================================================================',
  ]

  if (changes.length > 0) {
    summaryLines.push('Detailed Export Symbol Alterations:')
    for (const c of changes) {
      const prefix = c.changeKind === 'added' ? '+' : c.changeKind === 'removed' ? '-' : '~'
      const breakingMarker = c.isBreaking ? ' [BREAKING]' : ''
      summaryLines.push(
        `  ${prefix} [${c.symbolKind}] ${c.filePath}:${c.symbol} (${c.changeKind})${breakingMarker}`,
      )
    }
  }

  return {
    valid: true,
    runId,
    totalFilesScanned: scannedFiles.size,
    totalChanges: changes.length,
    addedCount,
    modifiedCount,
    removedCount,
    riskTier,
    changes,
    formattedSummary: summaryLines.join('\n'),
  }
}
