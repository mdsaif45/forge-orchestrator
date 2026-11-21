#!/usr/bin/env node
/**
 * Deterministic cycle detector for Forge source code.
 *
 * Requirements (ADR-004):
 * - Parses project files with TypeScript AST (`ts.createSourceFile`).
 * - Extracts static and dynamic imports/exports.
 * - Resolves relative imports and @shared/*, @main/*, @renderer/* path aliases.
 * - Excludes node_modules and test files (*.test.ts, *.spec.ts, src/test/**).
 * - Implements Tarjan's Strongly Connected Components (SCC) algorithm.
 * - Exits with code 0 on DAG (no cycles).
 * - Exits with code 1 and prints the cycle chain (A -> B -> C -> A) if a cycle is detected.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT_DIR = resolve(process.cwd())
const SRC_DIR = join(ROOT_DIR, 'src')

// Standard extensions to try when resolving modules without extension or .js
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs']

// Path aliases based on tsconfig.json
const PATH_ALIASES = [
  { prefix: '@shared/', target: 'src/shared/' },
  { prefix: '@shared', target: 'src/shared/index' },
  { prefix: '@main/', target: 'src/main/' },
  { prefix: '@main', target: 'src/main/index' },
  { prefix: '@renderer/', target: 'src/renderer/src/' },
  { prefix: '@renderer', target: 'src/renderer/src/index' },
]

/**
 * Normalize path separators to forward slashes and make relative to ROOT_DIR.
 */
function normalizeRelative(absPath) {
  return relative(ROOT_DIR, absPath).replace(/\\/g, '/')
}

/**
 * Checks if a file is a test file or test utility.
 */
function isTestFile(relPath) {
  const norm = relPath.replace(/\\/g, '/')
  return (
    norm.endsWith('.test.ts') ||
    norm.endsWith('.test.tsx') ||
    norm.endsWith('.spec.ts') ||
    norm.endsWith('.spec.tsx') ||
    norm.startsWith('src/test/') ||
    norm.includes('/__tests__/')
  )
}

/**
 * Recursively find all TypeScript/JavaScript source files under a directory.
 */
function findSourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
        continue
      }
      files.push(...findSourceFiles(fullPath))
    } else if (entry.isFile()) {
      if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        const rel = normalizeRelative(fullPath)
        if (!isTestFile(rel)) {
          files.push(fullPath)
        }
      }
    }
  }
  return files
}

/**
 * Try resolving a candidate path on disk by checking exact file, extensions, or directory index.
 */
function tryResolveCandidate(candidatePath) {
  // 1. Exact match if it exists and is a file
  if (existsSync(candidatePath)) {
    const stat = statSync(candidatePath)
    if (stat.isFile()) return candidatePath
    if (stat.isDirectory()) {
      for (const ext of RESOLVE_EXTENSIONS) {
        const indexCandidate = join(candidatePath, `index${ext}`)
        if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
          return indexCandidate
        }
      }
    }
  }

  // 2. Try candidatePath with extensions (e.g., ./foo -> ./foo.ts)
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidatePath + ext
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt
    }
  }

  // 3. If candidate ends with .js, try replacing with .ts or .tsx
  if (candidatePath.endsWith('.js')) {
    const noExt = candidatePath.slice(0, -3)
    for (const ext of ['.ts', '.tsx']) {
      const withExt = noExt + ext
      if (existsSync(withExt) && statSync(withExt).isFile()) {
        return withExt
      }
    }
  }

  return null
}

/**
 * Resolves a module specifier to an absolute path, or null if third-party/external.
 */
function resolveSpecifier(specifier, containingFile) {
  // Built-in or external package check (e.g. 'electron', 'better-sqlite3', 'node:fs')
  if (specifier.startsWith('node:') || (!specifier.startsWith('.') && !specifier.startsWith('@'))) {
    return null
  }

  // Relative imports
  if (specifier.startsWith('.')) {
    const candidate = resolve(dirname(containingFile), specifier)
    return tryResolveCandidate(candidate)
  }

  // Aliases
  for (const alias of PATH_ALIASES) {
    if (specifier === alias.prefix.replace(/\/$/, '') || specifier.startsWith(alias.prefix)) {
      const sub = specifier.slice(alias.prefix.length)
      const targetPath = join(ROOT_DIR, alias.target, sub)
      return tryResolveCandidate(targetPath)
    }
  }

  return null
}

/**
 * Extract all imported/exported module specifiers from a TypeScript source file AST.
 */
function extractImports(sourceFile) {
  const specifiers = new Set()

  function visit(node) {
    // import ... from '...'
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text)
      }
    }
    // export ... from '...'
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text)
      }
    }
    // import('...') or require('...')
    else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const firstArg = node.arguments[0]
        if (ts.isStringLiteral(firstArg)) {
          specifiers.add(firstArg.text)
        }
      }
    }
    // import('./type').Type
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.add(node.argument.literal.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return Array.from(specifiers)
}

/**
 * Tarjan's Strongly Connected Components algorithm.
 * Returns an array of SCCs, where each SCC is an array of vertex keys.
 */
function tarjanSCC(adjacencyList) {
  let index = 0
  const indices = new Map()
  const lowlink = new Map()
  const onStack = new Map()
  const stack = []
  const sccs = []

  const sortedVertices = Object.keys(adjacencyList).sort()

  function strongConnect(v) {
    indices.set(v, index)
    lowlink.set(v, index)
    index++
    stack.push(v)
    onStack.set(v, true)

    const neighbors = adjacencyList[v] || []
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w)
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)))
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)))
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = []
      let w
      do {
        w = stack.pop()
        onStack.set(w, false)
        scc.push(w)
      } while (w !== v)
      sccs.push(scc)
    }
  }

  for (const v of sortedVertices) {
    if (!indices.has(v)) {
      strongConnect(v)
    }
  }

  return sccs
}

/**
 * Given an SCC with > 1 nodes (or self loop), finds a simple cycle path starting and ending at the same node.
 */
function findCyclePath(scc, adjacencyList) {
  const sccSet = new Set(scc)
  const start = scc.slice().sort()[0]

  // BFS / DFS to find a cycle path from start back to start within sccSet
  const visited = new Set()
  const parent = new Map()
  let cycleClosingNode = null

  // DFS to trace path
  function dfs(curr, pathSet) {
    const neighbors = (adjacencyList[curr] || []).filter((n) => sccSet.has(n)).sort()
    for (const next of neighbors) {
      if (next === start) {
        cycleClosingNode = curr
        return true
      }
      if (!visited.has(next)) {
        visited.add(next)
        parent.set(next, curr)
        if (dfs(next, pathSet)) return true
      }
    }
    return false
  }

  visited.add(start)
  if (dfs(start, new Set([start])) && cycleClosingNode) {
    const cycle = [start]
    let curr = cycleClosingNode
    while (curr !== start && curr !== undefined) {
      cycle.push(curr)
      curr = parent.get(curr)
    }
    cycle.push(start)
    cycle.reverse()
    return cycle
  }

  // Fallback if direct DFS didn't close to start (e.g. self-loop)
  if (adjacencyList[start]?.includes(start)) {
    return [start, start]
  }

  return scc
}

/**
 * Main execution.
 */
function main() {
  console.log('ADR-004: Scanning src/ for circular dependencies...')
  const files = findSourceFiles(SRC_DIR)
  const graph = {}

  for (const file of files) {
    const relFile = normalizeRelative(file)
    graph[relFile] = []
  }

  for (const file of files) {
    const relFile = normalizeRelative(file)
    const content = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const rawImports = extractImports(sourceFile)

    const resolvedTargets = new Set()
    for (const specifier of rawImports) {
      const resolved = resolveSpecifier(specifier, file)
      if (resolved) {
        const relResolved = normalizeRelative(resolved)
        // Only track edges within the scanned production graph
        if (graph[relResolved] !== undefined) {
          resolvedTargets.add(relResolved)
        }
      }
    }

    graph[relFile] = Array.from(resolvedTargets).sort()
  }

  const sccs = tarjanSCC(graph)
  const cycles = []

  for (const scc of sccs) {
    if (scc.length > 1) {
      cycles.push(findCyclePath(scc, graph))
    } else if (scc.length === 1) {
      const node = scc[0]
      if (graph[node]?.includes(node)) {
        cycles.push([node, node])
      }
    }
  }

  if (cycles.length > 0) {
    console.error(`\n❌ Detected ${cycles.length} circular dependency cycle(s):\n`)
    for (const cycle of cycles) {
      console.error('  ' + cycle.join(' -> '))
    }
    console.error('\nADR-004 violation: Circular dependencies are strictly forbidden.')
    process.exit(1)
  }

  console.log(
    `✅ Passed: 0 circular dependencies detected across ${files.length} production source files (DAG verified).`,
  )
}

main()
