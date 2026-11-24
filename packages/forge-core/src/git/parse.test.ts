import { describe, expect, it } from 'vitest'
import { joinDiffFiles, parseNameStatus, parseNumstat, parseStatus } from './parse'

/**
 * Parser tests over captured `git 2.51` output.
 *
 * The records here are the literal bytes git produced for each case, recorded from
 * real repositories rather than written from memory — the irregular field counts
 * are the whole difficulty, and a hand-invented fixture would encode the same
 * misunderstanding into both the parser and its test.
 */

/** Builds `-z` records the way `splitNul` would hand them over. */
function records(...fields: string[]): string[] {
  return fields
}

describe('parseNameStatus', () => {
  it('reads the two-field records', () => {
    expect(parseNameStatus(records('A', 'added.txt', 'M', 'mod.txt', 'D', 'gone.txt'))).toEqual([
      { path: 'added.txt', changeType: 'added', previousPath: null },
      { path: 'mod.txt', changeType: 'modified', previousPath: null },
      { path: 'gone.txt', changeType: 'deleted', previousPath: null },
    ])
  })

  it('reads a rename as three fields and keeps the old path', () => {
    // "R075" \0 old \0 new — the record is one field longer than a modification,
    // so a fixed-stride reader would desynchronise from here onward.
    const parsed = parseNameStatus(records('R075', 'old.txt', 'new.txt', 'M', 'after.txt'))

    expect(parsed).toEqual([
      { path: 'new.txt', changeType: 'renamed', previousPath: 'old.txt' },
      // Proves the reader stayed in step after consuming the longer record.
      { path: 'after.txt', changeType: 'modified', previousPath: null },
    ])
  })

  it('treats a copy as an addition with no previous path', () => {
    expect(parseNameStatus(records('C100', 'source.txt', 'copy.txt'))).toEqual([
      { path: 'copy.txt', changeType: 'added', previousPath: null },
    ])
  })

  it('maps a type change to a modification', () => {
    expect(parseNameStatus(records('T', 'link.txt'))).toEqual([
      { path: 'link.txt', changeType: 'modified', previousPath: null },
    ])
  })

  it('skips a status letter it does not model rather than guessing one', () => {
    expect(parseNameStatus(records('U', 'conflict.txt'))).toEqual([])
  })

  it('decodes a non-ascii path', () => {
    // Byte-preserved utf8 for "café.txt", as `core.quotepath=false` emits it.
    const encoded = Buffer.from('café.txt', 'utf8').toString('latin1')
    expect(parseNameStatus(records('A', encoded))[0]?.path).toBe('café.txt')
  })
})

describe('parseNumstat', () => {
  it('reads inline counts', () => {
    expect(parseNumstat(records('1\t0\tadded.txt', '13\t4\tci.yml'))).toEqual([
      { path: 'added.txt', insertions: 1, deletions: 0, binary: false },
      { path: 'ci.yml', insertions: 13, deletions: 4, binary: false },
    ])
  })

  it('reads a rename, whose inline path is empty and paths follow', () => {
    // "1\t0\t" \0 old \0 new — the trailing tab leaves an empty third field.
    const parsed = parseNumstat(records('1\t0\t', 'old.txt', 'new.txt', '2\t2\tafter.txt'))

    expect(parsed).toEqual([
      { path: 'new.txt', insertions: 1, deletions: 0, binary: false },
      { path: 'after.txt', insertions: 2, deletions: 2, binary: false },
    ])
  })

  it('reports a binary file as zero counts and flags it', () => {
    // Git writes dashes, which are not integers; `changedFileSchema` requires
    // non-negative integers, so the flag is how binary stays distinguishable.
    expect(parseNumstat(records('-\t-\treal.bin'))).toEqual([
      { path: 'real.bin', insertions: 0, deletions: 0, binary: true },
    ])
  })
})

describe('joinDiffFiles', () => {
  it('joins on the new path, including for renames', () => {
    const joined = joinDiffFiles(
      [{ path: 'new.txt', changeType: 'renamed', previousPath: 'old.txt' }],
      [{ path: 'new.txt', insertions: 1, deletions: 0, binary: false }],
    )

    expect(joined).toEqual([
      {
        path: 'new.txt',
        changeType: 'renamed',
        previousPath: 'old.txt',
        insertions: 1,
        deletions: 0,
        binary: false,
      },
    ])
  })

  it('keeps a file whose counts are missing rather than dropping the change', () => {
    const joined = joinDiffFiles(
      [{ path: 'orphan.txt', changeType: 'modified', previousPath: null }],
      [],
    )

    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ path: 'orphan.txt', insertions: 0, deletions: 0 })
  })
})

describe('parseStatus', () => {
  it('reads the branch header and head sha', () => {
    const parsed = parseStatus(
      records(
        '# branch.oid 1aad1402c340bfadfcf2056118c7a6936c1b31d2',
        '# branch.head main',
        '# branch.upstream origin/main',
      ),
    )

    expect(parsed.branch).toBe('main')
    expect(parsed.headSha).toBe('1aad1402c340bfadfcf2056118c7a6936c1b31d2')
  })

  it('reports a detached head as a null branch', () => {
    expect(parseStatus(records('# branch.head (detached)')).branch).toBeNull()
  })

  it('reports an unborn head as a null sha', () => {
    expect(parseStatus(records('# branch.oid (initial)')).headSha).toBeNull()
  })

  it('separates staged from unstaged for the same file', () => {
    const staged =
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 587be6b4 added.txt'
    const unstaged = '1 .M N... 100644 100644 100644 c5e82d74 c5e82d74 edited.txt'

    const parsed = parseStatus(records(staged, unstaged))

    expect(parsed.entries).toEqual([
      { path: 'added.txt', changeType: 'added', previousPath: null, staged: true, unstaged: false },
      {
        path: 'edited.txt',
        changeType: 'modified',
        previousPath: null,
        staged: false,
        unstaged: true,
      },
    ])
  })

  it('reads a rename, whose old path follows the new one', () => {
    // Note the order is the reverse of `git diff`: v2 puts the new path inline.
    const rename = '2 R. N... 100644 100644 100644 83db48f8 84275f99 R75 new.txt'

    const parsed = parseStatus(records(rename, 'old.txt', '? untracked.txt'))

    expect(parsed.entries).toEqual([
      {
        path: 'new.txt',
        changeType: 'renamed',
        previousPath: 'old.txt',
        staged: true,
        unstaged: false,
      },
    ])
    // Proves the extra path record was consumed and did not shift the next entry.
    expect(parsed.untracked).toEqual(['untracked.txt'])
  })

  it('collects untracked, ignored and conflicted paths separately', () => {
    const conflict = 'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc both.txt'

    const parsed = parseStatus(records('? new.txt', '! dist/out.js', conflict))

    expect(parsed.untracked).toEqual(['new.txt'])
    expect(parsed.ignored).toEqual(['dist/out.js'])
    expect(parsed.conflicted).toEqual(['both.txt'])
    // A conflict is not a normal change entry; it needs a resolution, not a diff.
    expect(parsed.entries).toEqual([])
  })

  it('keeps a path containing spaces intact', () => {
    const entry = '1 M. N... 100644 100644 100644 c5e82d74 0c312dab src/my folder/a b.txt'

    expect(parseStatus(records(entry)).entries[0]?.path).toBe('src/my folder/a b.txt')
  })
})
