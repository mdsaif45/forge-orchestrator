import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  changeSetIdSchema,
  shaSchema,
  stepIdSchema,
  taskIdSchema,
  type ChangedFile,
  type ChangeSet,
} from '@shared/domain'
import { mergeChangeSets, normalizePath } from './changeSetMerger'

function makeChangeSet(overrides: {
  readonly id?: string
  readonly stepId?: string
  readonly files: readonly ChangedFile[]
  readonly patch?: string
}): ChangeSet {
  const generatedPatch =
    overrides.patch ??
    overrides.files
      .map((f) => `diff --git a/${f.path} b/${f.path}\nindex 000..111 100644\n`)
      .join('\n')
  return {
    id: changeSetIdSchema.parse(overrides.id ?? randomUUID()),
    baseSha: shaSchema.parse('a'.repeat(40)),
    headSha: shaSchema.parse('b'.repeat(40)),
    files: overrides.files,
    patch: generatedPatch,
    authorActor: 'agent:implementer',
    stepId: stepIdSchema.parse(overrides.stepId ?? randomUUID()),
    taskId: taskIdSchema.parse(randomUUID()),
    correctsChangeSetId: null,
    reviewVerdict: null,
    discrepancies: [],
    capturedAt: new Date().toISOString(),
  }
}

function makeFile(
  path: string,
  changeType: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified',
  previousPath: string | null = null,
): ChangedFile {
  return {
    path,
    changeType,
    previousPath,
    insertions: changeType === 'deleted' ? 0 : 5,
    deletions: changeType === 'added' ? 0 : 2,
  }
}

describe('normalizePath', () => {
  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizePath('src\\domain\\model.ts')).toBe('src/domain/model.ts')
  })

  it('strips leading ./ and leading /', () => {
    expect(normalizePath('./src/domain/model.ts')).toBe('src/domain/model.ts')
    expect(normalizePath('/src/domain/model.ts')).toBe('src/domain/model.ts')
  })

  it('strips trailing slashes', () => {
    expect(normalizePath('src/domain/')).toBe('src/domain')
  })
})

describe('mergeChangeSets', () => {
  it('returns ok for empty branch list', () => {
    const result = mergeChangeSets([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mergedFiles).toEqual([])
    expect(result.mergedPatch).toBe('')
  })

  it('returns sorted files and patch for a single branch', () => {
    const cs = makeChangeSet({
      files: [makeFile('b.ts'), makeFile('a.ts')],
      patch: 'patch-content',
    })
    const result = mergeChangeSets([cs])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mergedFiles.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(result.mergedPatch).toBe('patch-content')
  })

  it('merges multiple disjoint branches and sorts files deterministically', () => {
    const cs1 = makeChangeSet({
      stepId: randomUUID(),
      files: [makeFile('src/client.ts', 'added'), makeFile('src/util.ts', 'modified')],
      patch: 'diff --git a/src/client.ts b/src/client.ts\n+client',
    })
    const cs2 = makeChangeSet({
      stepId: randomUUID(),
      files: [makeFile('src/server.ts', 'added'), makeFile('README.md', 'modified')],
      patch: 'diff --git a/src/server.ts b/src/server.ts\n+server',
    })

    const result = mergeChangeSets([
      { branchId: 'node-client', changeSet: cs1 },
      { branchId: 'node-server', changeSet: cs2 },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mergedFiles.map((f) => f.path)).toEqual([
      'README.md',
      'src/client.ts',
      'src/server.ts',
      'src/util.ts',
    ])
    expect(result.mergedPatch).toContain('+client')
    expect(result.mergedPatch).toContain('+server')
  })

  it('detects modified-modified collision and halts with HALTED_POLICY', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('src/math.ts', 'modified')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('src/math.ts', 'modified')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-1', changeSet: cs1 },
      { branchId: 'branch-2', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.haltCode).toBe('HALTED_POLICY')
    expect(result.haltReason).toContain('HALTED_POLICY: merge-conflict')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.type).toBe('modified-modified')
    expect(result.conflicts[0]?.path).toBe('src/math.ts')
  })

  it('detects added-added collision even if contents could be identical', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('src/new-feature.ts', 'added')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('src/new-feature.ts', 'added')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-A', changeSet: cs1 },
      { branchId: 'branch-B', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.haltCode).toBe('HALTED_POLICY')
    expect(result.conflicts[0]?.type).toBe('added-added')
    expect(result.conflicts[0]?.path).toBe('src/new-feature.ts')
  })

  it('detects deleted-deleted collision', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('legacy.ts', 'deleted')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('legacy.ts', 'deleted')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-A', changeSet: cs1 },
      { branchId: 'branch-B', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.haltCode).toBe('HALTED_POLICY')
    expect(result.conflicts[0]?.type).toBe('deleted-deleted')
    expect(result.conflicts[0]?.path).toBe('legacy.ts')
  })

  it('detects modify-delete collisions in both directions', () => {
    // Branch 1 modifies, Branch 2 deletes
    const cs1 = makeChangeSet({
      files: [makeFile('common.ts', 'modified')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('common.ts', 'deleted')],
    })

    const result1 = mergeChangeSets([
      { branchId: 'branch-mod', changeSet: cs1 },
      { branchId: 'branch-del', changeSet: cs2 },
    ])

    expect(result1.ok).toBe(false)
    if (result1.ok) return
    expect(result1.haltCode).toBe('HALTED_POLICY')
    expect(result1.conflicts[0]?.type).toBe('modify-delete')
    expect(result1.conflicts[0]?.path).toBe('common.ts')

    // Branch 1 deletes, Branch 2 modifies
    const result2 = mergeChangeSets([
      { branchId: 'branch-del', changeSet: cs2 },
      { branchId: 'branch-mod', changeSet: cs1 },
    ])

    expect(result2.ok).toBe(false)
    if (result2.ok) return
    expect(result2.conflicts[0]?.type).toBe('modify-delete')
  })

  it('detects rename collisions when another branch touches the old path', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('new-name.ts', 'renamed', 'old-name.ts')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('old-name.ts', 'modified')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-rename', changeSet: cs1 },
      { branchId: 'branch-modify', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.type).toBe('rename-collision')
    expect(result.conflicts[0]?.path).toBe('old-name.ts')
  })

  it('detects rename collisions when another branch touches the new target path', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('new-name.ts', 'renamed', 'old-name.ts')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('new-name.ts', 'added')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-rename', changeSet: cs1 },
      { branchId: 'branch-add', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.type).toBe('rename-collision')
    expect(result.conflicts[0]?.path).toBe('new-name.ts')
  })

  it('detects rename-rename collision when both branches rename to the same target', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('target.ts', 'renamed', 'source-a.ts')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('target.ts', 'renamed', 'source-b.ts')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-A', changeSet: cs1 },
      { branchId: 'branch-B', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.type).toBe('rename-collision')
    expect(result.conflicts[0]?.path).toBe('target.ts')
  })

  it('detects mode change conflicts when both branches alter mode on identical paths', () => {
    const patchA = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
index 111..222
`
    const patchB = `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
index 111..333
`
    const cs1 = makeChangeSet({
      files: [makeFile('run.sh', 'modified')],
      patch: patchA,
    })
    const cs2 = makeChangeSet({
      files: [makeFile('run.sh', 'modified')],
      patch: patchB,
    })

    const result = mergeChangeSets([
      { branchId: 'branch-chmod-A', changeSet: cs1 },
      { branchId: 'branch-chmod-B', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.type).toBe('mode-conflict')
    expect(result.conflicts[0]?.path).toBe('run.sh')
  })

  it('detects directory vs file collisions where one branch path is a subpath of another file', () => {
    // Branch A creates a file at src/util
    const cs1 = makeChangeSet({
      files: [makeFile('src/util', 'added')],
    })
    // Branch B creates a file inside src/util/helper.ts (treating src/util as directory)
    const cs2 = makeChangeSet({
      files: [makeFile('src/util/helper.ts', 'added')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-file', changeSet: cs1 },
      { branchId: 'branch-dir', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.type).toBe('directory-file-collision')
    expect(result.conflicts[0]?.path).toBe('src/util')
  })

  it('does not falsely trigger directory collision on sibling files sharing prefix names', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('src/app.ts', 'added')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('src/app.tsx', 'added')],
    })

    const result = mergeChangeSets([
      { branchId: 'branch-ts', changeSet: cs1 },
      { branchId: 'branch-tsx', changeSet: cs2 },
    ])

    expect(result.ok).toBe(true)
  })

  it('normalizes Windows backslashes across branches to detect collisions', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('src\\common\\utils.ts', 'modified')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('src/common/utils.ts', 'modified')],
    })

    const result = mergeChangeSets([
      { branchId: 'win-branch', changeSet: cs1 },
      { branchId: 'posix-branch', changeSet: cs2 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts[0]?.path).toBe('src/common/utils.ts')
  })

  it('detects multiple conflicts across 3 concurrent branches', () => {
    const cs1 = makeChangeSet({
      files: [makeFile('shared1.ts', 'modified'), makeFile('shared2.ts', 'modified')],
    })
    const cs2 = makeChangeSet({
      files: [makeFile('shared1.ts', 'modified')],
    })
    const cs3 = makeChangeSet({
      files: [makeFile('shared2.ts', 'deleted')],
    })

    const result = mergeChangeSets([
      { branchId: 'b1', changeSet: cs1 },
      { branchId: 'b2', changeSet: cs2 },
      { branchId: 'b3', changeSet: cs3 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts.length).toBeGreaterThanOrEqual(2)
  })
})
