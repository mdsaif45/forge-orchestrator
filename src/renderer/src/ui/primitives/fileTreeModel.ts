import type { ChangedFileView, DiscrepancyView } from '@shared/ipc'

export interface TreeNode {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly isDirectory: boolean
  readonly children: readonly TreeNode[]
  readonly changeType?: 'added' | 'modified' | 'deleted' | 'renamed' | undefined
  readonly insertions?: number | undefined
  readonly deletions?: number | undefined
  readonly hasDiscrepancy?: boolean | undefined
  readonly changedDescendantsCount?: number | undefined
}

interface MutableTreeNode {
  id: string
  name: string
  path: string
  isDirectory: boolean
  children: Map<string, MutableTreeNode>
  changeType?: 'added' | 'modified' | 'deleted' | 'renamed' | undefined
  insertions?: number | undefined
  deletions?: number | undefined
  hasDiscrepancy?: boolean | undefined
  changedDescendantsCount?: number | undefined
}

/**
 * Normalizes any Windows backslashes into POSIX standard slashes.
 */
export function normalizePath(p: string): string {
  return p.split('\\').join('/').replace(/^\/+/, '')
}

/**
 * Builds a hierarchical tree from a flat list of file paths and git changed files.
 */
export function buildFileTree(
  filePaths: readonly string[],
  changedFiles: readonly ChangedFileView[] = [],
  discrepancies: readonly DiscrepancyView[] = [],
): readonly TreeNode[] {
  const changedMap = new Map<string, ChangedFileView>()
  for (const cf of changedFiles) {
    changedMap.set(normalizePath(cf.path), cf)
  }

  const discrepancyPaths = new Set<string>()
  for (const d of discrepancies) {
    discrepancyPaths.add(normalizePath(d.path))
  }

  // Combine unique file paths from both all files and changed files
  const allUniquePaths = new Set<string>()
  for (const p of filePaths) {
    allUniquePaths.add(normalizePath(p))
  }
  for (const cf of changedFiles) {
    allUniquePaths.add(normalizePath(cf.path))
  }

  const rootChildren = new Map<string, MutableTreeNode>()

  for (const rawPath of allUniquePaths) {
    if (!rawPath.trim()) continue
    const segments = rawPath.split('/')
    let currentMap = rootChildren
    let accumulatedPath = ''

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? ''
      if (!segment) continue

      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment
      const isFile = i === segments.length - 1

      let node = currentMap.get(segment)
      if (!node) {
        node = {
          id: accumulatedPath,
          name: segment,
          path: accumulatedPath,
          isDirectory: !isFile,
          children: new Map<string, MutableTreeNode>(),
        }
        currentMap.set(segment, node)
      }

      if (isFile) {
        const change = changedMap.get(accumulatedPath)
        if (change) {
          node.changeType = change.changeType
          node.insertions = change.insertions
          node.deletions = change.deletions
        }
        if (discrepancyPaths.has(accumulatedPath)) {
          node.hasDiscrepancy = true
        }
      }

      currentMap = node.children
    }
  }

  function freezeAndSort(map: Map<string, MutableTreeNode>): readonly TreeNode[] {
    const list: TreeNode[] = []

    for (const node of map.values()) {
      const frozenChildren = freezeAndSort(node.children)

      let changedDescendants = 0
      if (node.isDirectory) {
        for (const child of frozenChildren) {
          if (child.changeType !== undefined) {
            changedDescendants += 1
          }
          if (child.changedDescendantsCount !== undefined) {
            changedDescendants += child.changedDescendantsCount
          }
        }
      }

      list.push({
        id: node.id,
        name: node.name,
        path: node.path,
        isDirectory: node.isDirectory,
        children: frozenChildren,
        changeType: node.changeType,
        insertions: node.insertions,
        deletions: node.deletions,
        hasDiscrepancy: node.hasDiscrepancy,
        changedDescendantsCount: changedDescendants > 0 ? changedDescendants : undefined,
      })
    }

    return list.sort((a, b) => {
      // Directories first, then alphabetical by name
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    })
  }

  return freezeAndSort(rootChildren)
}

/**
 * Recursively filters the tree matching nodes by query substring.
 * Preserves directory ancestry if any child matches.
 */
export function filterFileTree(
  nodes: readonly TreeNode[],
  query: string,
): readonly TreeNode[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return nodes

  const result: TreeNode[] = []

  for (const node of nodes) {
    if (node.isDirectory) {
      const filteredChildren = filterFileTree(node.children, trimmed)
      const nameMatches = node.name.toLowerCase().includes(trimmed)

      if (filteredChildren.length > 0 || nameMatches) {
        result.push({
          ...node,
          children: filteredChildren.length > 0 ? filteredChildren : node.children,
        })
      }
    } else {
      if (node.name.toLowerCase().includes(trimmed) || node.path.toLowerCase().includes(trimmed)) {
        result.push(node)
      }
    }
  }

  return result
}

/**
 * Returns all directory paths in the tree.
 */
export function collectAllDirectoryPaths(nodes: readonly TreeNode[]): readonly string[] {
  const paths: string[] = []

  function visit(list: readonly TreeNode[]) {
    for (const node of list) {
      if (node.isDirectory) {
        paths.push(node.path)
        visit(node.children)
      }
    }
  }

  visit(nodes)
  return paths
}

/**
 * Gets all parent directory paths for a given file path.
 * e.g. "src/renderer/src/App.tsx" -> ["src", "src/renderer", "src/renderer/src"]
 */
export function getAncestorsOfPath(filePath: string): readonly string[] {
  const normalized = normalizePath(filePath)
  const segments = normalized.split('/')
  const ancestors: string[] = []

  let acc = ''
  for (let i = 0; i < segments.length - 1; i++) {
    const s = segments[i]
    if (!s) continue
    acc = acc ? `${acc}/${s}` : s
    ancestors.push(acc)
  }

  return ancestors
}
