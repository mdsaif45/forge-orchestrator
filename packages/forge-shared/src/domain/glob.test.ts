import { describe, expect, it } from 'vitest'
import { firstMatching, matchesAny, matchesGlob } from './glob'

/**
 * Glob matching.
 *
 * Every expectation here was measured against `picomatch` rather than recalled. That matters
 * more than it sounds: a scope policy that quietly matches more than the user wrote would let
 * an agent edit files the task forbade, and one that matches less would halt legitimate work.
 * Both failures are silent.
 */

describe('** crosses separators', () => {
  it('matches at any depth', () => {
    expect(matchesGlob('src/a.ts', 'src/**')).toBe(true)
    expect(matchesGlob('src/deep/nested/b.ts', 'src/**')).toBe(true)
  })

  it('matches the directory itself', () => {
    // Measured: picomatch treats `src/**` as matching `src`. A policy allowing `src/**` that
    // rejected `src` would be surprising in a way nobody would think to test for.
    expect(matchesGlob('src', 'src/**')).toBe(true)
  })

  it('does not match a sibling directory', () => {
    expect(matchesGlob('other/a.ts', 'src/**')).toBe(false)
    // The prefix must be a whole segment: `srcx/` is not inside `src/`.
    expect(matchesGlob('srcx/a.ts', 'src/**')).toBe(false)
  })

  it('matches at depth zero when leading', () => {
    // `**/*.ts` matching `a.ts` is the case a naive implementation gets wrong, because the
    // `**/` has nothing to consume.
    expect(matchesGlob('a.ts', '**/*.ts')).toBe(true)
    expect(matchesGlob('src/a.ts', '**/*.ts')).toBe(true)
    expect(matchesGlob('src/deep/a.ts', '**/*.ts')).toBe(true)
  })

  it('respects the extension when leading', () => {
    expect(matchesGlob('a.tsx', '**/*.ts')).toBe(false)
  })

  it('matches a named file at any depth', () => {
    expect(matchesGlob('package.json', '**/package.json')).toBe(true)
    expect(matchesGlob('packages/api/package.json', '**/package.json')).toBe(true)
  })
})

describe('* stops at a separator', () => {
  it('matches one segment only', () => {
    expect(matchesGlob('src/a.ts', 'src/*')).toBe(true)
    expect(matchesGlob('src/deep/b.ts', 'src/*')).toBe(false)
  })

  it('does not match across directories at the root', () => {
    expect(matchesGlob('package.lock', '*.lock')).toBe(true)
    expect(matchesGlob('sub/package.lock', '*.lock')).toBe(false)
  })
})

describe('? matches one character', () => {
  it('does not cross a separator', () => {
    expect(matchesGlob('a.ts', '?.ts')).toBe(true)
    expect(matchesGlob('ab.ts', '?.ts')).toBe(false)
    expect(matchesGlob('a/ts', '?.ts')).toBe(false)
  })
})

describe('literals', () => {
  it('matches an exact path', () => {
    expect(matchesGlob('src/math.ts', 'src/math.ts')).toBe(true)
    expect(matchesGlob('src/other.ts', 'src/math.ts')).toBe(false)
  })

  it('treats a dot as a literal, not a wildcard', () => {
    // A regex-naive implementation would let `.` match any character, so `srcXmath.ts` would
    // pass — which is how a scope policy accidentally widens.
    expect(matchesGlob('src/mathXts', 'src/math.ts')).toBe(false)
  })

  it('does not let a regex metacharacter in the pattern change the meaning', () => {
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true)
    expect(matchesGlob('aab.ts', 'a+b.ts')).toBe(false)
  })

  it('anchors both ends', () => {
    // Without anchoring, `src/math.ts` would match `vendor/src/math.ts.bak`.
    expect(matchesGlob('vendor/src/math.ts', 'src/math.ts')).toBe(false)
    expect(matchesGlob('src/math.ts.bak', 'src/math.ts')).toBe(false)
  })
})

describe('separator normalisation', () => {
  it('matches a Windows-style path against a POSIX pattern', () => {
    // Git reports POSIX paths, but a path arriving from elsewhere on Windows may not. Failing
    // to normalise would silently exempt those from every scope rule.
    expect(matchesGlob('src\\math.ts', 'src/**')).toBe(true)
    expect(matchesGlob('src\\deep\\b.ts', 'src/*')).toBe(false)
  })
})

describe('matchesAny', () => {
  it('is false for an empty pattern list', () => {
    // "Matches nothing" rather than "matches everything": the caller decides what an empty
    // list means, and the dangerous default would be to permit.
    expect(matchesAny('src/a.ts', [])).toBe(false)
  })

  it('is true when any pattern matches', () => {
    expect(matchesAny('docs/a.md', ['src/**', 'docs/**'])).toBe(true)
  })
})

describe('firstMatching', () => {
  it('names the pattern that matched, for an error a user can act on', () => {
    expect(firstMatching('migrations/001.sql', ['src/**', 'migrations/**'])).toBe('migrations/**')
  })

  it('returns null when nothing matches', () => {
    expect(firstMatching('src/a.ts', ['docs/**'])).toBeNull()
  })
})

describe('the patterns scope policies actually use', () => {
  it('handles the forbidden set from FORGE_RULES', () => {
    // R4 names these specifically: generated files, migrations, lockfiles.
    const forbidden = ['migrations/**', '**/*.lock', '**/generated/**', 'package-lock.json']

    expect(matchesAny('migrations/001_init.sql', forbidden)).toBe(true)
    expect(matchesAny('migrations/meta/_journal.json', forbidden)).toBe(true)
    expect(matchesAny('package-lock.json', forbidden)).toBe(true)
    expect(matchesAny('src/generated/types.ts', forbidden)).toBe(true)
    expect(matchesAny('yarn.lock', forbidden)).toBe(true)

    // And leaves ordinary source alone.
    expect(matchesAny('src/math.ts', forbidden)).toBe(false)
    expect(matchesAny('src/migrations.ts', forbidden)).toBe(false)
  })
})
