import { describe, expect, it } from 'vitest'
import {
  correctionFindings,
  isPathAllowed,
  reconcile,
  scopeRefusalFor,
  shouldHalt,
  summariseDiscrepancies,
} from './reconcile'
import type { ChangedFile } from './changeset'
import type { ScopePolicy } from './task'

/**
 * Reconciling a claim against reality.
 *
 * Axiom A3 made mechanical. The cases that matter are the dishonest ones and the
 * out-of-scope ones, and the distinction between them: a dishonest claim is a review
 * finding that loops, while an out-of-scope edit is a policy breach that halts.
 */

function file(path: string, insertions = 1, deletions = 1): ChangedFile {
  return { path, changeType: 'modified', previousPath: null, insertions, deletions }
}

function scope(overrides: Partial<ScopePolicy> = {}): ScopePolicy {
  return { allowedPaths: [], forbiddenPaths: [], ...overrides }
}

describe('an accurate claim', () => {
  it('produces no discrepancies', () => {
    const result = reconcile({
      claimed: ['src/math.ts'],
      actual: [file('src/math.ts')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    expect(result.discrepancies).toEqual([])
    expect(result.claimAccurate).toBe(true)
    expect(result.inScope).toBe(true)
    expect(shouldHalt(result)).toBe(false)
  })

  it('does not care about the order paths are listed in', () => {
    const result = reconcile({
      claimed: ['src/b.ts', 'src/a.ts'],
      actual: [file('src/a.ts'), file('src/b.ts')],
      scope: scope(),
    })

    expect(result.claimAccurate).toBe(true)
  })

  it('treats a Windows-style claim as the same file', () => {
    // A claim written with backslashes describes the file git reports with forward slashes.
    // Treating them as different would invent two discrepancies out of one correct claim.
    const result = reconcile({
      claimed: ['src\\math.ts'],
      actual: [file('src/math.ts')],
      scope: scope(),
    })

    expect(result.claimAccurate).toBe(true)
  })
})

describe('claimed but unchanged', () => {
  it('catches the liar', () => {
    // The scenario axiom A3 exists for: the report claims a file changed and the repository
    // shows nothing.
    const result = reconcile({
      claimed: ['src/math.ts'],
      actual: [],
      scope: scope(),
    })

    expect(result.discrepancies).toEqual([
      {
        path: 'src/math.ts',
        kind: 'claimed-but-unchanged',
        detail: 'src/math.ts was reported as changed but the repository shows no change',
      },
    ])
    expect(result.claimAccurate).toBe(false)
  })

  it('does not halt — it is a correction, not a breach', () => {
    // A dishonest claim goes back to the agent as a finding. That is the loop working, not a
    // reason to stop the workflow.
    const result = reconcile({ claimed: ['src/math.ts'], actual: [], scope: scope() })

    expect(shouldHalt(result)).toBe(false)
    expect(correctionFindings(result)).toHaveLength(1)
  })
})

describe('changed but unclaimed', () => {
  it('catches an agent that does not know what it did', () => {
    // Worse than lying: an agent that misreports its own edits cannot be reasoned with about
    // them on the next iteration.
    const result = reconcile({
      claimed: ['src/math.ts'],
      actual: [file('src/math.ts'), file('src/other.ts')],
      scope: scope(),
    })

    expect(result.discrepancies).toEqual([
      {
        path: 'src/other.ts',
        kind: 'changed-but-unclaimed',
        detail: 'src/other.ts was modified but the agent did not report it',
      },
    ])
  })

  it('tells the agent what to do about it', () => {
    const result = reconcile({
      claimed: [],
      actual: [file('src/other.ts')],
      scope: scope(),
    })

    expect(correctionFindings(result).at(0)).toMatch(/Report every path you modify/)
  })
})

describe('scope enforcement', () => {
  it('halts on an edit outside the allowed paths', () => {
    // The definition of done: the scope-creep case. Note the claim is *accurate* — the agent
    // reported the forbidden edit honestly. The violation is the edit, not the report.
    const result = reconcile({
      claimed: ['src/math.ts', 'package.json'],
      actual: [file('src/math.ts'), file('package.json')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    expect(result.outOfScope).toEqual(['package.json'])
    expect(shouldHalt(result)).toBe(true)
    expect(result.claimAccurate).toBe(true)
  })

  it('names the offending file and the rule', () => {
    const result = reconcile({
      claimed: ['migrations/001.sql'],
      actual: [file('migrations/001.sql')],
      scope: scope({ forbiddenPaths: ['migrations/**'] }),
    })

    const discrepancy = result.discrepancies.at(0)
    expect(discrepancy?.kind).toBe('outside-scope')
    expect(discrepancy?.detail).toContain('migrations/001.sql')
    // The pattern is named, so a user can act on it rather than guessing which rule fired.
    expect(discrepancy?.detail).toContain('migrations/**')
  })

  it('lets a forbidden path win over an allowed one', () => {
    // A prohibition does not read as "unless something also permits it".
    const policy = scope({ allowedPaths: ['src/**'], forbiddenPaths: ['src/generated/**'] })

    expect(isPathAllowed('src/math.ts', policy)).toBe(true)
    expect(isPathAllowed('src/generated/types.ts', policy)).toBe(false)
  })

  it('treats an empty allow list as "anywhere not forbidden"', () => {
    // The common case early in a project. Defaulting to "nothing is allowed" would halt every
    // workflow until someone wrote a glob.
    const policy = scope({ forbiddenPaths: ['migrations/**'] })

    expect(isPathAllowed('anything/at/all.ts', policy)).toBe(true)
    expect(isPathAllowed('migrations/001.sql', policy)).toBe(false)
  })

  it('produces no correction finding for a scope violation', () => {
    // There is nothing to ask the agent to fix: the run halts rather than looping.
    const result = reconcile({
      claimed: ['package.json'],
      actual: [file('package.json')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    expect(correctionFindings(result)).toEqual([])
  })

  it('explains why a path was refused', () => {
    expect(
      scopeRefusalFor('migrations/x.sql', scope({ forbiddenPaths: ['migrations/**'] })),
    ).toMatch(/forbidden pattern/)
    expect(scopeRefusalFor('docs/a.md', scope({ allowedPaths: ['src/**'] }))).toMatch(
      /outside the allowed paths/,
    )
    expect(scopeRefusalFor('src/a.ts', scope({ allowedPaths: ['src/**'] }))).toBeNull()
  })
})

describe('all three kinds at once', () => {
  it('reports each separately, worst first', () => {
    // A step can be dishonest *and* out of scope. Collapsing them would hide which problem
    // the user has to deal with, and they need different responses.
    const result = reconcile({
      claimed: ['src/math.ts', 'src/never-touched.ts'],
      actual: [file('src/math.ts'), file('src/surprise.ts'), file('migrations/001.sql')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    // Three files, three discrepancies -- migrations/001.sql is out of scope *and*
    // unreported, and yields one finding rather than two.
    expect(result.discrepancies.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'outside-scope:migrations/001.sql',
      'changed-but-unclaimed:src/surprise.ts',
      'claimed-but-unchanged:src/never-touched.ts',
    ])
    expect(result.claimAccurate).toBe(false)
    expect(result.inScope).toBe(false)
  })

  it('counts an out-of-scope file once, even when also unreported', () => {
    // One file, one discrepancy. Reporting it as both out-of-scope *and* unclaimed would
    // inflate the number a user sees and imply two problems where there is one file. Scope is
    // the more serious fact and subsumes the reporting question: the run halts either way, so
    // whether the agent also mentioned it is moot.
    const result = reconcile({
      claimed: [],
      actual: [file('migrations/001.sql')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies.at(0)?.kind).toBe('outside-scope')
    // Honesty is still judged independently: the agent did fail to report it, and reading
    // that off the filtered list would call an unreported forbidden edit accurate.
    expect(result.claimAccurate).toBe(false)
  })

  it('orders deterministically, by path within each kind', () => {
    // Shown to a user and written into an event payload; an order that varied by iteration
    // would make two identical reconciliations look different.
    const input = {
      claimed: [],
      actual: [file('src/z.ts'), file('src/a.ts'), file('src/m.ts')],
      scope: scope(),
    }

    const first = reconcile(input)
    const second = reconcile({ ...input, actual: [...input.actual].reverse() })

    expect(first.discrepancies.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/m.ts',
      'src/z.ts',
    ])
    expect(second.discrepancies).toEqual(first.discrepancies)
  })
})

describe('summarising for a user', () => {
  it('says nothing when there is nothing to say', () => {
    const result = reconcile({ claimed: ['src/a.ts'], actual: [file('src/a.ts')], scope: scope() })

    expect(summariseDiscrepancies(result)).toBeNull()
  })

  it('counts each kind, so the summary is scannable', () => {
    // Surfaced prominently rather than buried: a discrepancy a user has to go looking for is
    // one they will not see, which defeats the point of reconciling at all.
    const result = reconcile({
      claimed: ['src/gone.ts'],
      actual: [file('src/surprise.ts'), file('package.json')],
      scope: scope({ allowedPaths: ['src/**'] }),
    })

    const summary = summariseDiscrepancies(result)
    expect(summary).toContain('1 file(s) outside the task scope')
    // src/surprise.ts only: package.json is counted once, under scope.
    expect(summary).toContain('1 changed but unreported')
    expect(summary).toContain('1 reported but unchanged')
  })
})

describe('an empty step', () => {
  it('is accurate when nothing was claimed and nothing changed', () => {
    // A planner or reviewer legitimately changes nothing. That is not a discrepancy.
    const result = reconcile({ claimed: [], actual: [], scope: scope() })

    expect(result.discrepancies).toEqual([])
    expect(result.claimAccurate).toBe(true)
    expect(shouldHalt(result)).toBe(false)
  })
})
