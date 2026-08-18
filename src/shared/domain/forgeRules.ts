import type { RuleScope } from './enums'

/**
 * The default global ruleset — Forge's own policy, not user data.
 *
 * These are the eight rules in `docs/FORGE_RULES.md`, and they are code constants
 * rather than rows for a reason: they belong to Forge itself, they must be present
 * for the axioms to mean anything, and they cannot be edited away by accident. A
 * project, workflow, agent, or task may *override* one by restating it at a narrower
 * scope — which is visible in the settings screen as an override — but nothing can
 * delete one.
 *
 * Keys are `R1` through `R8`, matching the document, so an override targets the same
 * concern rather than adding a near-duplicate rule beside it.
 *
 * Kept in sync with `docs/FORGE_RULES.md` by a test that compares the two, since a
 * doc that disagrees with the enforced policy is worse than no doc.
 */

export interface DefaultRule {
  readonly key: string
  readonly statement: string
  readonly scope: RuleScope
  readonly source: string
}

const SOURCE = 'docs/FORGE_RULES.md'

export const FORGE_DEFAULT_RULES: readonly DefaultRule[] = [
  {
    key: 'R1',
    statement:
      'Never guess. Inspect the repository, configuration, related implementation, and project state; if it is still ambiguous, raise an open question and stop. "I assumed X" is a rule violation, not a report.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R2',
    statement:
      'Probe before asking. A question must carry what needs deciding, why the repository could not answer it, the evidence inspected, the viable options, and a recommendation.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R3',
    statement:
      'Respect locked decisions. A locked decision is binding: to change it, file an architecture change request and stop. Never work around it or silently reinterpret it.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R4',
    statement:
      'Stay in scope. Modify only paths the current task permits. Never touch generated files, migrations without approval, lockfiles unless the task is a dependency change, or unrelated modules.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R5',
    statement:
      'Report facts, structured. Reply with a report stating status, summary, files changed, commands run, whether tests ran, and open questions. Assumptions must be empty.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R6',
    statement:
      'Verification is not yours to declare. You report; Forge runs the build, runs the tests, diffs the tree, and evaluates the completion criteria. Your text is a claim; the repository is the fact.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R7',
    statement:
      'Never exfiltrate secrets. Do not read, echo, log, or transmit .env files, keys, tokens, or credentials. If a task appears to require a secret, raise an open question instead.',
    scope: 'global',
    source: SOURCE,
  },
  {
    key: 'R8',
    statement:
      'Stop cleanly. When halting, leave the working tree coherent and say precisely where you stopped and why. Never leave a half-applied change with a confident summary.',
    scope: 'global',
    source: SOURCE,
  },
]

/** The keys Forge guarantees are present, for a test that no default is dropped. */
export const FORGE_DEFAULT_RULE_KEYS: readonly string[] = FORGE_DEFAULT_RULES.map(
  (rule) => rule.key,
)
