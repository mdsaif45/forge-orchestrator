import { describe, expect, it } from 'vitest'
import {
  buildFileTree,
  collectAllDirectoryPaths,
  filterFileTree,
  getAncestorsOfPath,
  normalizePath,
} from './fileTreeModel'
import type { ChangedFileView } from '@shared/ipc'

describe('fileTreeModel', () => {
  it('normalizes paths properly', () => {
    expect(normalizePath('src\\renderer\\App.tsx')).toBe('src/renderer/App.tsx')
    expect(normalizePath('/src/main.ts')).toBe('src/main.ts')
  })

  it('builds a hierarchical tree from flat paths', () => {
    const paths = [
      'package.json',
      'src/main/index.ts',
      'src/renderer/App.tsx',
      'src/renderer/styles.css',
      'README.md',
    ]

    const changedFiles: ChangedFileView[] = [
      {
        path: 'src/renderer/App.tsx',
        changeType: 'modified',
        previousPath: null,
        insertions: 5,
        deletions: 2,
      },
    ]

    const tree = buildFileTree(paths, changedFiles)

    // Root should have 1 directory ('src') and 2 files ('package.json', 'README.md')
    expect(tree).toHaveLength(3)
    expect(tree[0]?.name).toBe('src')
    expect(tree[0]?.isDirectory).toBe(true)
    expect(tree[0]?.changedDescendantsCount).toBe(1)

    // Check src/renderer
    const srcDir = tree[0]
    expect(srcDir?.children).toHaveLength(2) // main, renderer
    const rendererDir = srcDir?.children.find((c) => c.name === 'renderer')
    expect(rendererDir?.children).toHaveLength(2)

    const appFile = rendererDir?.children.find((c) => c.name === 'App.tsx')
    expect(appFile?.changeType).toBe('modified')
    expect(appFile?.insertions).toBe(5)
    expect(appFile?.deletions).toBe(2)
  })

  it('filters tree by search query preserving hierarchy', () => {
    const paths = ['src/main/index.ts', 'src/renderer/App.tsx', 'README.md']
    const tree = buildFileTree(paths)

    const filtered = filterFileTree(tree, 'App')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.name).toBe('src')

    const src = filtered[0]
    expect(src?.children).toHaveLength(1)
    expect(src?.children[0]?.name).toBe('renderer')
    expect(src?.children[0]?.children[0]?.name).toBe('App.tsx')
  })

  it('collects all directory paths and computes ancestors', () => {
    const paths = ['src/a/b/file.ts', 'docs/readme.md']
    const tree = buildFileTree(paths)

    const dirs = collectAllDirectoryPaths(tree)
    expect(dirs).toContain('src')
    expect(dirs).toContain('src/a')
    expect(dirs).toContain('src/a/b')
    expect(dirs).toContain('docs')

    const ancestors = getAncestorsOfPath('src/a/b/file.ts')
    expect(ancestors).toEqual(['src', 'src/a', 'src/a/b'])
  })
})
