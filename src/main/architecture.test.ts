import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = resolve(process.cwd())
const SRC_DIR = join(ROOT_DIR, 'src')

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs']

const PATH_ALIASES = [
  { prefix: '@shared/', target: 'src/shared/' },
  { prefix: '@shared', target: 'src/shared/index' },
  { prefix: '@main/', target: 'src/main/' },
  { prefix: '@main', target: 'src/main/index' },
  { prefix: '@renderer/', target: 'src/renderer/src/' },
  { prefix: '@renderer', target: 'src/renderer/src/index' },
]

function normalizeRelative(absPath: string): string {
  return relative(ROOT_DIR, absPath).replace(/\\/g, '/')
}

function isTestFile(relPath: string): boolean {
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

function findProductionSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
        continue
      }
      files.push(...findProductionSourceFiles(fullPath))
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

function extractImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const specifiers = new Set<string>()

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text)
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const firstArg = node.arguments[0]
        if (firstArg && ts.isStringLiteral(firstArg)) {
          specifiers.add(firstArg.text)
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.add(node.argument.literal.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return Array.from(specifiers)
}

function tryResolveCandidate(candidatePath: string): string | null {
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
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidatePath + ext
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt
    }
  }
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

function resolveSpecifier(specifier: string, containingFile: string): string | null {
  if (specifier.startsWith('node:') || (!specifier.startsWith('.') && !specifier.startsWith('@'))) {
    return null
  }
  if (specifier.startsWith('.')) {
    const candidate = resolve(dirname(containingFile), specifier)
    return tryResolveCandidate(candidate)
  }
  for (const alias of PATH_ALIASES) {
    if (specifier === alias.prefix.replace(/\/$/, '') || specifier.startsWith(alias.prefix)) {
      const sub = specifier.slice(alias.prefix.length)
      const targetPath = join(ROOT_DIR, alias.target, sub)
      return tryResolveCandidate(targetPath)
    }
  }
  return null
}

function tarjanSCC(adjacencyList: Record<string, string[]>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Map<string, boolean>()
  const stack: string[] = []
  const sccs: string[][] = []

  const sortedVertices = Object.keys(adjacencyList).sort()

  function strongConnect(v: string): void {
    indices.set(v, index)
    lowlink.set(v, index)
    index++
    stack.push(v)
    onStack.set(v, true)

    const neighbors = adjacencyList[v] ?? []
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      } else if (onStack.get(w) === true) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!))
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = []
      let w: string | undefined
      do {
        w = stack.pop()
        if (w !== undefined) {
          onStack.set(w, false)
          scc.push(w)
        }
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

describe('ADR-004 Architectural Boundaries & Invariants', () => {
  const allProdFiles = findProductionSourceFiles(SRC_DIR)

  it('verifies src/shared/domain is pure and imports 0 external or outer layer modules', () => {
    const domainFiles = allProdFiles.filter((f) =>
      normalizeRelative(f).startsWith('src/shared/domain/'),
    )
    expect(domainFiles.length).toBeGreaterThan(0)

    const forbiddenPrefixes = [
      'electron',
      'node:',
      'fs',
      'path',
      'child_process',
      'crypto',
      'os',
      'src/main',
      '@main',
      'src/preload',
      'src/renderer',
      '@renderer',
      '@shared/views',
      '@shared/ipc',
      '../views',
      '../ipc',
    ]

    const violations: string[] = []

    for (const file of domainFiles) {
      const rel = normalizeRelative(file)
      const imports = extractImports(file)
      for (const spec of imports) {
        if (forbiddenPrefixes.some((p) => spec === p || spec.startsWith(p + '/'))) {
          violations.push(`${rel} imports forbidden module: ${spec}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies src/shared/views is pure and imports 0 main, electron, or ipc modules', () => {
    const viewsFiles = allProdFiles.filter((f) =>
      normalizeRelative(f).startsWith('src/shared/views/'),
    )
    expect(viewsFiles.length).toBeGreaterThan(0)

    const forbiddenPrefixes = [
      'electron',
      'node:',
      'fs',
      'path',
      'child_process',
      'crypto',
      'os',
      'src/main',
      '@main',
      'src/preload',
      'src/renderer',
      '@renderer',
      '@shared/ipc',
      '../ipc',
    ]

    const violations: string[] = []

    for (const file of viewsFiles) {
      const rel = normalizeRelative(file)
      const imports = extractImports(file)
      for (const spec of imports) {
        if (forbiddenPrefixes.some((p) => spec === p || spec.startsWith(p + '/'))) {
          violations.push(`${rel} imports forbidden module: ${spec}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies application services import 0 @shared/ipc or main/ipc transport modules', () => {
    const appServicePrefixes = [
      'src/main/projects/',
      'src/main/accounts/',
      'src/main/workflows/',
      'src/main/changesets/',
      'src/main/decisions/',
      'src/main/questions/',
      'src/main/bindings/',
      'src/main/artifacts/',
      'src/main/audit/',
      'src/main/health/',
      'src/main/templates/',
      'src/main/context/',
      'src/main/evidence/',
    ]

    const appFiles = allProdFiles.filter((f) => {
      const rel = normalizeRelative(f)
      return appServicePrefixes.some((prefix) => rel.startsWith(prefix))
    })
    expect(appFiles.length).toBeGreaterThan(0)

    const violations: string[] = []

    for (const file of appFiles) {
      const rel = normalizeRelative(file)
      const imports = extractImports(file)
      for (const spec of imports) {
        if (
          spec === '@shared/ipc' ||
          spec.startsWith('@shared/ipc/') ||
          spec.includes('/shared/ipc') ||
          spec.includes('main/ipc') ||
          spec.startsWith('@main/ipc') ||
          spec.includes('../ipc')
        ) {
          violations.push(`${rel} imports IPC transport: ${spec}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies infrastructure imports 0 application services or execution modules', () => {
    const infraPrefixes = [
      'src/main/db/',
      'src/main/process/',
      'src/main/git/',
      'src/main/terminal/',
      'src/main/logging/',
    ]

    const infraFiles = allProdFiles.filter((f) => {
      const rel = normalizeRelative(f)
      return infraPrefixes.some((prefix) => rel.startsWith(prefix))
    })
    expect(infraFiles.length).toBeGreaterThan(0)

    const forbiddenTargets = [
      '/projects/',
      '/accounts/',
      '/workflows/',
      '/changesets/',
      '/decisions/',
      '/questions/',
      '/bindings/',
      '/artifacts/',
      '/audit/',
      '/health/',
      '/templates/',
      '/core/',
      '/runtimes/',
      '/providers/',
    ]

    const violations: string[] = []

    for (const file of infraFiles) {
      const rel = normalizeRelative(file)
      const imports = extractImports(file)
      for (const spec of imports) {
        const resolved = resolveSpecifier(spec, file)
        if (resolved) {
          const resolvedRel = normalizeRelative(resolved)
          if (forbiddenTargets.some((target) => resolvedRel.includes(target))) {
            violations.push(`${rel} imports upward layer: ${resolvedRel} (via ${spec})`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies non-DB files import 0 drizzle-orm or db/schema modules', () => {
    const nonDbFiles = allProdFiles.filter((f) => !normalizeRelative(f).startsWith('src/main/db/'))
    expect(nonDbFiles.length).toBeGreaterThan(0)

    const violations: string[] = []

    for (const file of nonDbFiles) {
      const rel = normalizeRelative(file)
      const imports = extractImports(file)
      for (const spec of imports) {
        if (
          spec === 'drizzle-orm' ||
          spec.startsWith('drizzle-orm/') ||
          spec.includes('db/schema')
        ) {
          violations.push(`${rel} leaks database schema/ORM: ${spec}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies 0 circular dependencies across all production source files in src/', () => {
    const graph: Record<string, string[]> = {}

    for (const file of allProdFiles) {
      const relFile = normalizeRelative(file)
      graph[relFile] = []
    }

    for (const file of allProdFiles) {
      const relFile = normalizeRelative(file)
      const imports = extractImports(file)
      const resolvedTargets = new Set<string>()

      for (const spec of imports) {
        const resolved = resolveSpecifier(spec, file)
        if (resolved) {
          const relResolved = normalizeRelative(resolved)
          if (graph[relResolved] !== undefined) {
            resolvedTargets.add(relResolved)
          }
        }
      }

      graph[relFile] = Array.from(resolvedTargets).sort()
    }

    const sccs = tarjanSCC(graph)
    const cycles: string[][] = []

    for (const scc of sccs) {
      if (scc.length > 1) {
        cycles.push(scc)
      } else if (scc.length === 1) {
        const node = scc[0]
        if (node !== undefined) {
          const neighbors = graph[node]
          if (neighbors?.includes(node)) {
            cycles.push([node, node])
          }
        }
      }
    }

    expect(cycles).toEqual([])
  })
})
