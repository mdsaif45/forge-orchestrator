import { describe, expect, it } from 'vitest'
import {
  compileContext,
  rankFiles,
  truncationNotice,
  type ContextInput,
  type FileCandidate,
} from './contextEngine'
import { isForbiddenPath, redactSecrets } from './redaction'
import { renderPromptPacket } from './protocol'
import { decisionIdSchema, taskIdSchema } from './ids'
import type { Task } from './task'
import type { EffectiveRule } from './policy'

/**
 * The context engine.
 *
 * Three properties are asserted here rather than trusted: that identical state produces a
 * byte-identical packet, that nothing secret can reach one, and that a locked decision is
 * never trimmed to fit a budget. Each is a guarantee the rest of Forge relies on, and each
 * would fail silently if it broke.
 */

const TASK_ID = taskIdSchema.parse('7c9e6679-7425-40de-944b-e07fc1f90ae7')
const DECISION_ID = decisionIdSchema.parse('550e8400-e29b-41d4-a716-446655440000')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    objective: 'Correct the constant in src/math.ts',
    constraints: ['Do not change the public API'],
    completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: ['migrations/**'] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    ...overrides,
  }
}

function rule(key: string, statement: string): EffectiveRule {
  return { key, statement, scope: 'global', source: 'docs/FORGE_RULES.md', shadowed: [] }
}

function input(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    role: 'implementer',
    task: task(),
    rules: [rule('R1', 'Never guess.')],
    lockedDecisions: [],
    files: [],
    previousAttempt: null,
    reviewFindings: [],
    answeredQuestions: [],
    ...overrides,
  }
}

describe('determinism', () => {
  it('produces a byte-identical packet for identical state', () => {
    // Packets are snapshotted per step and compared across runs. A packet that varied by
    // iteration order or wall clock would make every comparison meaningless.
    const subject = input({
      files: [
        { path: 'src/b.ts', inScope: true },
        { path: 'src/a.ts', inScope: true },
      ],
    })

    const first = compileContext(subject)
    const second = compileContext(subject)

    expect(second.packet).toEqual(first.packet)
    expect(renderPromptPacket(second.packet)).toBe(renderPromptPacket(first.packet))
  })

  it('does not depend on the order candidates arrive in', () => {
    const files: FileCandidate[] = [
      { path: 'src/a.ts', inScope: true },
      { path: 'src/b.ts', inScope: true },
      { path: 'src/c.ts', inScope: true },
    ]

    const forward = compileContext(input({ files }))
    const reversed = compileContext(input({ files: [...files].reverse() }))

    expect(reversed.packet.relevantFiles).toEqual(forward.packet.relevantFiles)
  })

  it('breaks ties by path so equal signals still order stably', () => {
    // Without a tie-break, two files with identical signals would order by arrival and the
    // packet would differ between otherwise identical runs.
    const ranked = rankFiles([
      { path: 'src/z.ts', inScope: true },
      { path: 'src/a.ts', inScope: true },
    ])

    expect(ranked.map((file) => file.path)).toEqual(['src/a.ts', 'src/z.ts'])
  })
})

describe('secrets can never enter a packet', () => {
  it('excludes .env and every variant', () => {
    // The definition of done. Excluded wholesale rather than scrubbed line by line: a .env
    // can hold a hostname or a feature flag that looks harmless and is still nobody's
    // business.
    const compiled = compileContext(
      input({
        files: [
          { path: '.env', mentionedInTask: true, inScope: true },
          { path: '.env.local', mentionedInTask: true },
          { path: '.env.production', mentionedInTask: true },
          { path: 'config/.env.test', mentionedInTask: true },
          { path: 'src/math.ts', inScope: true },
        ],
      }),
    )

    expect(compiled.packet.relevantFiles).toEqual(['src/math.ts'])
    // Named in the trace, so the exclusion is visible rather than mysterious.
    expect(compiled.trace.filesForbidden).toHaveLength(4)
  })

  it('excludes key material and credential stores', () => {
    const compiled = compileContext(
      input({
        files: [
          { path: 'certs/server.pem', mentionedInTask: true },
          { path: 'certs/server.key', mentionedInTask: true },
          { path: '.ssh/id_rsa', mentionedInTask: true },
          { path: '.aws/credentials', mentionedInTask: true },
          { path: '.npmrc', mentionedInTask: true },
          { path: 'secrets.json', mentionedInTask: true },
          { path: 'src/math.ts', inScope: true },
        ],
      }),
    )

    expect(compiled.packet.relevantFiles).toEqual(['src/math.ts'])
  })

  it('excludes a forbidden file even when the task names it and nothing else is available', () => {
    // The strongest signal in the ranking is "the task mentions it". That must still lose to
    // A7, or a task objective could be used to extract a credential.
    const compiled = compileContext(
      input({ files: [{ path: '.env', mentionedInTask: true, inScope: true }] }),
    )

    expect(compiled.packet.relevantFiles).toEqual([])
  })

  it('scrubs secret-shaped values out of every string it sends', () => {
    // Path exclusion is not enough on its own: a secret can arrive through an objective, a
    // review finding, or an answered question.
    const compiled = compileContext(
      input({
        task: task({
          objective: 'Rotate the key: AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE',
          constraints: ['Keep using Authorization: Bearer abcdef1234567890'],
        }),
        reviewFindings: ['The token GITHUB_TOKEN=ghp_realsecretvalue123 is hardcoded'],
        answeredQuestions: [{ question: 'Which db?', answer: 'postgres://user:hunter2@host/db' }],
        previousAttempt: { summary: 'Set api_key=supersecret999', diffStat: '1 file' },
      }),
    )

    const rendered = renderPromptPacket(compiled.packet)

    expect(rendered).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(rendered).not.toContain('abcdef1234567890')
    expect(rendered).not.toContain('ghp_realsecretvalue123')
    expect(rendered).not.toContain('hunter2')
    expect(rendered).not.toContain('supersecret999')
    // The keys survive, so the agent knows what was withheld.
    expect(rendered).toContain('AWS_SECRET_ACCESS_KEY=')
  })

  it('classifies forbidden paths by shape, on either separator', () => {
    expect(isForbiddenPath('.env')).toBe(true)
    expect(isForbiddenPath('packages/api/.env.local')).toBe(true)
    // Windows separators reach here from a caller that forgot to normalise; matching both
    // costs nothing and a miss costs a credential.
    expect(isForbiddenPath('packages\\api\\.env')).toBe(true)

    expect(isForbiddenPath('src/environment.ts')).toBe(false)
    expect(isForbiddenPath('docs/DOMAIN.md')).toBe(false)
  })
})

describe('locked decisions', () => {
  it('includes them verbatim, with the rationale', () => {
    const compiled = compileContext(
      input({
        lockedDecisions: [
          { id: DECISION_ID, statement: 'Use Redis as the backplane', rationale: 'Shared state' },
        ],
      }),
    )

    expect(compiled.packet.lockedDecisions).toEqual([
      'Use Redis as the backplane — because Shared state',
    ])
  })

  it('never drops one to fit a budget', () => {
    // A4. Silently dropping a decision would let an agent contradict something the user
    // locked, which is the failure this whole mechanism exists to prevent. A budget too
    // small for the decisions is a wrong budget, not a reason to trim them.
    const compiled = compileContext(
      input({
        budget: { maxChars: 10 },
        lockedDecisions: [
          { id: DECISION_ID, statement: 'A'.repeat(500), rationale: 'B'.repeat(500) },
        ],
        files: [{ path: 'src/math.ts', inScope: true }],
      }),
    )

    expect(compiled.packet.lockedDecisions.at(0)?.length).toBeGreaterThan(1000)
    // The files are what gave way instead.
    expect(compiled.packet.relevantFiles).toEqual([])
    expect(compiled.trace.truncated).toBe(true)
  })
})

describe('selection by role', () => {
  const many: FileCandidate[] = Array.from({ length: 40 }, (_, index) => ({
    path: `src/file${String(index).padStart(2, '0')}.ts`,
    inScope: true,
  }))

  it('gives a planner fewer files than an implementer', () => {
    // A planner reasons about structure and must not be handed forty implementation files.
    const planner = compileContext(input({ role: 'planner', files: many }))
    const implementer = compileContext(input({ role: 'implementer', files: many }))

    expect(planner.packet.relevantFiles.length).toBeLessThan(
      implementer.packet.relevantFiles.length,
    )
  })

  it('withholds review findings from a planner', () => {
    // A planner is deciding what to do, not correcting an attempt; findings from a previous
    // implementation would be noise at best and misleading at worst.
    const compiled = compileContext(
      input({ role: 'planner', reviewFindings: ['The value is wrong'] }),
    )

    expect(compiled.packet.reviewFindings).toEqual([])
  })

  it('gives an implementer the previous attempt and the findings', () => {
    const compiled = compileContext(
      input({
        role: 'implementer',
        reviewFindings: ['The value is wrong'],
        previousAttempt: { summary: 'Changed it', diffStat: '1 file, +1 -1' },
      }),
    )

    expect(compiled.packet.reviewFindings).toEqual(['The value is wrong'])
    expect(compiled.packet.previousAttempt?.diffStat).toBe('1 file, +1 -1')
  })
})

describe('ranking', () => {
  it('puts a file the task names above every heuristic', () => {
    // The user said so; no heuristic outranks that.
    const ranked = rankFiles([
      { path: 'src/close.ts', importDistance: 0, recentlyChanged: true, inScope: true },
      { path: 'src/named.ts', mentionedInTask: true },
    ])

    expect(ranked.at(0)?.path).toBe('src/named.ts')
  })

  it('prefers in-scope files to out-of-scope ones', () => {
    const ranked = rankFiles([
      { path: 'src/out.ts', recentlyChanged: true },
      { path: 'src/in.ts', inScope: true },
    ])

    expect(ranked.at(0)?.path).toBe('src/in.ts')
  })

  it('prefers closer files in the import graph', () => {
    const ranked = rankFiles([
      { path: 'src/far.ts', importDistance: 4 },
      { path: 'src/near.ts', importDistance: 1 },
    ])

    expect(ranked.at(0)?.path).toBe('src/near.ts')
  })

  it('stops rewarding proximity beyond a few hops', () => {
    // Past about five hops, "imports something that imports something" says nothing useful,
    // and continuing to reward it would crowd out a recently-changed file.
    const ranked = rankFiles([
      { path: 'src/distant.ts', importDistance: 9 },
      { path: 'src/changed.ts', recentlyChanged: true },
    ])

    expect(ranked.at(0)?.path).toBe('src/changed.ts')
  })
})

describe('the budget', () => {
  it('caps the number of files', () => {
    const compiled = compileContext(
      input({
        budget: { maxFiles: 3 },
        files: Array.from({ length: 10 }, (_, index) => ({
          path: `src/f${String(index)}.ts`,
          inScope: true,
        })),
      }),
    )

    expect(compiled.packet.relevantFiles).toHaveLength(3)
    expect(compiled.trace.filesTruncated).toHaveLength(7)
  })

  it('reports a truncation explicitly rather than cutting silently', () => {
    // An agent that does not know its view was trimmed will reason as though it saw
    // everything, and confidently conclude something wrong.
    const compiled = compileContext(
      input({
        budget: { maxFiles: 1 },
        files: [
          { path: 'src/a.ts', inScope: true },
          { path: 'src/b.ts', inScope: true },
        ],
      }),
    )

    const notice = truncationNotice(compiled.trace)
    expect(notice).toContain('omitted to fit the context budget')
    expect(notice).toContain('src/b.ts')
  })

  it('says nothing when nothing was dropped', () => {
    const compiled = compileContext(input({ files: [{ path: 'src/a.ts', inScope: true }] }))

    expect(compiled.trace.truncated).toBe(false)
    expect(truncationNotice(compiled.trace)).toBeNull()
  })

  it('respects the role cap even when a caller asks for more', () => {
    // A caller cannot widen a planner's view past what the role strategy allows.
    const compiled = compileContext(
      input({
        role: 'planner',
        budget: { maxFiles: 999 },
        files: Array.from({ length: 30 }, (_, index) => ({
          path: `src/f${String(index).padStart(2, '0')}.ts`,
          inScope: true,
        })),
      }),
    )

    expect(compiled.packet.relevantFiles.length).toBeLessThanOrEqual(12)
  })
})

describe('the golden packet', () => {
  it('matches the recorded shape exactly', () => {
    // A golden test over assembly, as the definition of done asks. Written inline rather than
    // as a separate fixture file so a deliberate change and its justification land in the
    // same diff — a fixture in another directory is a fixture nobody reads when it changes.
    const compiled = compileContext({
      role: 'implementer',
      task: task(),
      rules: [rule('R1', 'Never guess.'), rule('R4', 'Stay in scope.')],
      lockedDecisions: [
        { id: DECISION_ID, statement: 'Use Redis as the backplane', rationale: 'Shared state' },
      ],
      files: [
        { path: 'src/math.ts', mentionedInTask: true, inScope: true },
        { path: 'src/math.test.ts', inScope: true, recentlyChanged: true },
        { path: '.env', mentionedInTask: true },
        { path: 'docs/DOMAIN.md', importDistance: 3 },
      ],
      previousAttempt: { summary: 'Set it to 41', diffStat: '1 file, +1 -1' },
      reviewFindings: ['The value should be 42'],
      answeredQuestions: [{ question: 'Which value?', answer: '42' }],
    })

    expect(compiled.packet).toEqual({
      role: 'implementer',
      objective: 'Correct the constant in src/math.ts',
      constraints: ['Do not change the public API'],
      rules: ['Never guess.', 'Stay in scope.'],
      lockedDecisions: ['Use Redis as the backplane — because Shared state'],
      allowedPaths: ['src/**'],
      forbiddenPaths: ['migrations/**'],
      // Ranked: named by the task, then in-scope and recently changed, then distant. `.env`
      // is absent entirely.
      relevantFiles: ['src/math.ts', 'src/math.test.ts', 'docs/DOMAIN.md'],
      reviewFindings: ['The value should be 42'],
      previousAttempt: { summary: 'Set it to 41', diffStat: '1 file, +1 -1' },
      completionCriteria: ['the test suite passes'],
      answeredQuestions: [{ question: 'Which value?', answer: '42' }],
      // Null here and always: a correction is attached by `exchange()` on the single
      // re-prompt, not compiled from context. The context engine never sets it.
      correction: null,
      // Null because this fixture supplies none. When a repository has a CLAUDE.md it
      // appears here instead, which is the guarantee #133 adds.
      repositoryInstructions: null,
    })

    expect(compiled.trace).toEqual({
      role: 'implementer',
      filesConsidered: 4,
      filesIncluded: 3,
      filesForbidden: ['.env'],
      filesTruncated: [],
      // 143 for the fixed content (objective, constraints, locked decision, rules) plus
      // 44 for the three file paths. Verified by hand rather than pasted from the failure.
      charsUsed: 187,
      truncated: false,
    })
  })

  it('renders to the recorded text', () => {
    // The packet is what is stored; the rendering is what an agent reads. Both have to be
    // stable, since a prompt that changed shape between runs would make two runs
    // incomparable.
    const compiled = compileContext(
      input({
        rules: [rule('R1', 'Never guess.')],
        lockedDecisions: [{ id: DECISION_ID, statement: 'Use Redis', rationale: 'Shared state' }],
        files: [{ path: 'src/math.ts', mentionedInTask: true }],
      }),
    )

    const rendered = renderPromptPacket(compiled.packet)

    expect(rendered).toContain('ROLE\nimplementer')
    expect(rendered).toContain('1. Never guess.')
    expect(rendered).toContain('LOCKED DECISIONS')
    expect(rendered).toContain('Use Redis — because Shared state')
    expect(rendered).toContain('src/math.ts')
    expect(rendered).toContain('FORGE_REPORT_BEGIN')
  })
})

describe('redactSecrets', () => {
  it('leaves ordinary text untouched', () => {
    const text = 'Corrected the constant in src/math.ts and ran the tests'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe("the repository's own instructions (#133)", () => {
  it('carries the repository instructions into the packet, since the CLI is stopped from loading them', () => {
    const compiled = compileContext(
      input({ repositoryInstructions: '# House style\n\nPrefer composition.' }),
    )

    expect(compiled.packet.repositoryInstructions).toBe('# House style\n\nPrefer composition.')
  })

  it('is silent when the repository has none, which is the common case', () => {
    expect(
      compileContext(input({ repositoryInstructions: null })).packet.repositoryInstructions,
    ).toBeNull()
    expect(compileContext(input('   \n  ')).packet.repositoryInstructions).toBeNull()
  })

  it('redacts it, because this is repository content Forge did not write', () => {
    const compiled = compileContext(
      input({ repositoryInstructions: 'Deploy with api_key=sk-live-abcdef123456 when releasing.' }),
    )

    expect(compiled.packet.repositoryInstructions).not.toContain('sk-live-abcdef123456')
  })

  it('truncates a long file on a line boundary and says that it did', () => {
    // Mid-sentence would leave an agent acting on half an instruction, and a silent cut
    // would leave the user unable to tell why guidance they wrote was ignored.
    const long = Array.from({ length: 500 }, (_, i) => `Rule number ${String(i)} goes here.`).join(
      '\n',
    )
    const compiled = compileContext(input({ repositoryInstructions: long }))
    const sent = compiled.packet.repositoryInstructions

    expect(sent).not.toBeNull()
    expect(sent?.length).toBeLessThan(long.length)
    expect(sent).toContain('[Truncated by Forge:')
    // The kept portion ends at a line break, not part-way through a sentence.
    const kept = sent?.split('\n\n[Truncated by Forge:')[0] ?? ''
    expect(long.startsWith(kept)).toBe(true)
  })

  it('does not let a long file crowd out the ranked relevant files', () => {
    // The failure this prevents: a project that documents itself thoroughly would get
    // *worse* context, because the instruction file consumed the budget files compete for.
    const long = 'x'.repeat(50_000)

    const withFiles = {
      ...input({ repositoryInstructions: long }),
      files: [
        { path: 'src/a.ts', mentionedInTask: true, inScope: true },
        { path: 'src/b.ts', inScope: true, recentlyChanged: true },
      ],
    }

    const compiled = compileContext(withFiles)

    expect(compiled.packet.relevantFiles.length).toBeGreaterThan(0)
  })
})

describe('rendering the repository instructions', () => {
  it('attributes them, so an agent is not told two things in one voice', () => {
    const compiled = compileContext(
      input({ repositoryInstructions: 'Prefer composition over inheritance.' }),
    )

    const rendered = renderPromptPacket(compiled.packet)

    // Forge's rules are policy it enforces and halts on; this is the repository's own
    // guidance. Under one heading, a style preference reads as a rule that fails a step.
    expect(rendered).toContain("PROJECT INSTRUCTIONS — this repository's own guidance")
    expect(rendered).toContain('Prefer composition over inheritance.')
    expect(rendered.indexOf('RULES')).toBeLessThan(rendered.indexOf('PROJECT INSTRUCTIONS'))
  })

  it('omits the section entirely when there are none', () => {
    const compiled = compileContext(input({ repositoryInstructions: null }))

    expect(renderPromptPacket(compiled.packet)).not.toContain('PROJECT INSTRUCTIONS')
  })
})
