/**
 * EVIDENCE-011: Changeset AST import/export dependency cycle detector.
 * Enforces ADR-004 cycle prohibition and physical DAG verification on agent code changes (Axioms A1, A3).
 */

import { posix } from 'node:path'

export interface DependencyCycleReport {
  readonly valid: boolean
  readonly hasCycles: boolean
  readonly scannedFilesCount: number
  readonly totalImportsCount: number
  readonly cycles: readonly (readonly string[])[]
  readonly formattedSummary: string
}

const IMPORT_EXPORT_REGEX =
  /(?:import\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]([^'"]+)['"]|export\s+(?:[\w*\s{},]*)\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g

/**
 * Normalizes relative paths using posix separators.
 */
function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Resolves an imported module specifier relative to the importing file.
 */
function resolveModulePath(importingFile: string, specifier: string): string | null {
  // Only relative imports are checked for workspace cycles
  if (!specifier.startsWith('.')) {
    return null
  }

  const dir = posix.dirname(importingFile)
  let resolved = posix.normalize(posix.join(dir, specifier))
  resolved = normalizePosix(resolved)

  // Strip extension for normalized canonical matching
  resolved = resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  return resolved
}

/**
 * Extracts all relative import specifiers from file content.
 */
export function extractImportSpecifiers(content: string): readonly string[] {
  const specifiers: string[] = []
  const matches = content.matchAll(IMPORT_EXPORT_REGEX)
  for (const m of matches) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (raw) {
      specifiers.push(raw)
    }
  }
  return specifiers
}

/**
 * Audits a collection of in-memory files (path -> content) for circular dependencies.
 */
export function auditDependencyCycles(files: Record<string, string>): DependencyCycleReport {
  const canonicalMap = new Map<string, string>() // stripped path -> original path
  const graph = new Map<string, Set<string>>() // canonical -> Set of canonical targets

  let totalImportsCount = 0

  for (const filePath of Object.keys(files)) {
    const norm = normalizePosix(filePath)
    const stripped = norm.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    canonicalMap.set(stripped, filePath)
    if (!graph.has(stripped)) {
      graph.set(stripped, new Set())
    }
  }

  for (const [filePath, content] of Object.entries(files)) {
    const norm = normalizePosix(filePath)
    const fromStripped = norm.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
    const imports = extractImportSpecifiers(content)

    for (const spec of imports) {
      const resolved = resolveModulePath(norm, spec)
      if (resolved && canonicalMap.has(resolved)) {
        graph.get(fromStripped)?.add(resolved)
        totalImportsCount++
      }
    }
  }

  // Detect cycles using DFS with recursion stack
  const visited = new Set<string>()
  const recStack = new Set<string>()
  const cyclePaths: string[][] = []

  function dfs(node: string, currentPath: string[]): void {
    visited.add(node)
    recStack.add(node)
    currentPath.push(node)

    const neighbors = graph.get(node)
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, currentPath)
        } else if (recStack.has(neighbor)) {
          // Found cycle
          const cycleStartIndex = currentPath.indexOf(neighbor)
          if (cycleStartIndex !== -1) {
            const cycleSlice = currentPath.slice(cycleStartIndex)
            cycleSlice.push(neighbor) // close loop

            // Convert back to original file paths
            const originalPathCycle = cycleSlice.map((p) => canonicalMap.get(p) ?? p)
            cyclePaths.push(originalPathCycle)
          }
        }
      }
    }

    recStack.delete(node)
    currentPath.pop()
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, [])
    }
  }

  const hasCycles = cyclePaths.length > 0
  const valid = !hasCycles

  const lines: string[] = [
    `DEPENDENCY CYCLE AUDIT (ADR-004):`,
    `  Scanned Files:    ${String(Object.keys(files).length)}`,
    `  Relative Imports: ${String(totalImportsCount)}`,
    `  Status:           ${hasCycles ? 'VIOLATIONS DETECTED' : 'CLEAN (NO CYCLES)'}`,
  ]

  if (hasCycles) {
    lines.push(`  Detected Circular Chains (${String(cyclePaths.length)}):`)
    for (const cycle of cyclePaths) {
      lines.push(`    • ${cycle.join(' -> ')}`)
    }
  }

  return {
    valid,
    hasCycles,
    scannedFilesCount: Object.keys(files).length,
    totalImportsCount,
    cycles: cyclePaths,
    formattedSummary: lines.join('\n'),
  }
}
