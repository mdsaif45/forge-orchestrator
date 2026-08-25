import { z } from 'zod'
import { agentReportSchema, capabilitySchema, type Capability } from '@shared/domain'

/**
 * Scenario scripts for `MockAgentRuntime`.
 *
 * These exist so the workflow engine, the evidence layer, and the review loop can be
 * built and tested without burning real agent quota — and, after the #20 spike, without
 * waiting on a CLI that may never ship a headless mode.
 *
 * The important scenarios are the dishonest ones. A mock that only ever behaves well
 * would verify the happy path and nothing else, while the whole point of axiom A3 is
 * that Forge must catch an agent that *says* it succeeded. `liar` and `scopeCreep`
 * are therefore first-class fixtures, not edge cases.
 */

/** A file the scripted agent writes, so a real diff exists to reconcile against. */
export const scenarioFileEditSchema = z.strictObject({
  /** Repository-relative POSIX path. */
  path: z.string().min(1),
  /** Full contents to write. Null deletes the file. */
  contents: z.string().nullable(),
})

export type ScenarioFileEdit = z.infer<typeof scenarioFileEditSchema>

/**
 * One scripted step: what the agent does, then what it claims.
 *
 * `edits` are applied to the worktree *before* `report` is emitted, in that order, so
 * a test observes the same sequence a real agent produces — work first, claim second.
 */
export const scenarioStepSchema = z.strictObject({
  /** Emitted as `chunk` events, so the live log has something to show. */
  narration: z.array(z.string()).readonly(),
  /** Tool invocations to announce. Claims, like everything else an agent says. */
  tools: z.array(z.strictObject({ name: z.string().min(1), detail: z.string() })).readonly(),
  /** Real mutations to the worktree. Empty for a step that only talks. */
  edits: z.array(scenarioFileEditSchema).readonly(),
  /** What the agent reports. Null when the step ends in failure or silence instead. */
  report: agentReportSchema.nullable(),
  /**
   * How this step ends, when not with a report.
   *
   * `silent` never emits anything further, which is what the no-progress detector
   * (#29) has to notice; `crash` emits a retryable error; `authFailure` emits a
   * non-retryable one, matching what the #20 spike measured from a real CLI.
   *
   * `text` emits `replyText` as chunks and never produces a structured `result`. That is
   * how a real CLI behaves — it prints prose and the protocol extracts a report from it —
   * so it is the only ending that exercises parsing and the re-prompt. A mock that always
   * handed back a validated object would leave the whole extraction path untested.
   *
   * `providerLimit` emits an error flagged as a spent account limit. It exists because the
   * real signal cannot be produced on demand — an account has to actually run out — and
   * everything downstream of the flag is ordinary logic that must not wait for that (#137).
   */
  ending: z.enum(['report', 'silent', 'crash', 'authFailure', 'text', 'providerLimit']),
  /** Raw stdout for a `text` ending. Ignored otherwise. */
  replyText: z.string().nullable(),
})

export type ScenarioStep = z.infer<typeof scenarioStepSchema>

export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(capabilitySchema).readonly(),
  /** Consumed in order, one per `send`. A further send past the end is an error. */
  steps: z.array(scenarioStepSchema).min(1).readonly(),
})

export type Scenario = z.infer<typeof scenarioSchema>

/** Builds a report with the honest defaults, so a fixture states only what it means. */
function report(overrides: Partial<z.infer<typeof agentReportSchema>> = {}) {
  return agentReportSchema.parse({
    status: 'completed',
    summary: 'Did the thing',
    filesChanged: [],
    commandsRun: [],
    testsRun: false,
    openQuestions: [],
    assumptions: [],
    ...overrides,
  })
}

function step(overrides: Partial<z.infer<typeof scenarioStepSchema>> = {}): ScenarioStep {
  return scenarioStepSchema.parse({
    narration: [],
    tools: [],
    edits: [],
    report: null,
    ending: 'report',
    replyText: null,
    ...overrides,
  })
}

const ALL: readonly Capability[] = ['repo-read', 'file-write', 'terminal', 'plan', 'review', 'test']

/** Implements the objective honestly and reports it accurately. */
export const HAPPY_PATH: Scenario = scenarioSchema.parse({
  name: 'happy',
  description: 'Implements the change, runs tests, reports exactly what it did',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Reading src/math.ts', 'Applying the fix'],
      tools: [{ name: 'Edit', detail: 'src/math.ts' }],
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
      report: report({
        summary: 'Corrected the constant',
        filesChanged: ['src/math.ts'],
        commandsRun: ['npm test'],
        testsRun: true,
      }),
    }),
  ],
})

/**
 * Claims success while changing nothing.
 *
 * The single most important fixture in this file: it is the case axiom A3 exists for,
 * and the one a well-behaved mock would never produce.
 */
export const LIAR: Scenario = scenarioSchema.parse({
  name: 'liar',
  description: 'Reports files changed and tests passing, having done neither',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Fixed it.'],
      edits: [],
      report: report({
        summary: 'Fixed the constant and all tests pass',
        filesChanged: ['src/math.ts'],
        commandsRun: ['npm test'],
        testsRun: true,
      }),
    }),
  ],
})

/** Edits a file outside the task's allowed paths, which the policy layer must halt. */
export const SCOPE_CREEP: Scenario = scenarioSchema.parse({
  name: 'scopeCreep',
  description: 'Makes the requested change plus an unrelated drive-by edit',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Fixing the constant', 'Also tidying the config while I am here'],
      edits: [
        { path: 'src/math.ts', contents: 'export const answer = 42\n' },
        { path: 'package.json', contents: '{ "name": "tampered" }\n' },
      ],
      report: report({
        summary: 'Corrected the constant and tidied the config',
        // Reported honestly; the violation is the edit, not a lie about it.
        filesChanged: ['src/math.ts', 'package.json'],
      }),
    }),
  ],
})

/** Fails review once, then fixes it — exercises the correction loop. */
export const CORRECTION: Scenario = scenarioSchema.parse({
  name: 'correction',
  description: 'First attempt is incomplete; the second attempt fixes it',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Applying a partial fix'],
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 41\n' }],
      report: report({ summary: 'Adjusted the constant', filesChanged: ['src/math.ts'] }),
    }),
    step({
      narration: ['Addressing the review finding'],
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
      report: report({
        summary: 'Corrected the constant to the reviewed value',
        filesChanged: ['src/math.ts'],
        testsRun: true,
      }),
    }),
  ],
})

/** Raises an open question with evidence and stops, per rules R1 and R2. */
export const QUESTION: Scenario = scenarioSchema.parse({
  name: 'question',
  description: 'Investigates, cannot resolve an ambiguity, and asks with evidence',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Both conventions exist in this repository'],
      report: report({
        status: 'question',
        summary: 'Cannot determine the authoritative convention',
        openQuestions: [
          {
            question: 'Should the endpoint return 404 or 403 when the tenant lacks access?',
            whyUndetermined: 'Existing handlers use both, with no comment explaining either',
            evidence: [
              { path: 'src/api/orders.ts', line: 88, note: 'returns 404' },
              { path: 'src/api/invoices.ts', line: 41, note: 'returns 403' },
            ],
            options: ['404', '403'],
            recommendation: '403',
          },
        ],
      }),
    }),
  ],
})

/** Admits an assumption, which rule R1 makes a violation rather than a note. */
export const ASSUMER: Scenario = scenarioSchema.parse({
  name: 'assumer',
  description: 'Guesses instead of asking, and says so in its report',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Not sure which convention applies; going with 404'],
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
      report: report({
        summary: 'Implemented using the convention I judged most likely',
        filesChanged: ['src/math.ts'],
        assumptions: ['Assumed 404 is the correct status for a cross-tenant read'],
      }),
    }),
  ],
})

/** Goes silent. The no-progress detector must notice rather than waiting forever. */
export const TIMEOUT: Scenario = scenarioSchema.parse({
  name: 'timeout',
  description: 'Starts working and never reports',
  capabilities: ALL,
  steps: [step({ narration: ['Working...'], ending: 'silent' })],
})

/** Exits mid-step. Retryable, unlike an auth failure. */
export const CRASH: Scenario = scenarioSchema.parse({
  name: 'crash',
  description: 'Dies partway through, leaving a partial edit behind',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Starting the edit'],
      // A partial edit is left in the tree, which is what rule R8 is about and what
      // the changeset must surface rather than hide.
      edits: [{ path: 'src/math.ts', contents: 'export const answer = \n' }],
      ending: 'crash',
    }),
  ],
})

/**
 * Fails to authenticate.
 *
 * Modelled on what the #20 spike actually measured: the CLI reported the failure on
 * stdout with exit code 1, and no retry would fix it.
 */
export const AUTH_FAILURE: Scenario = scenarioSchema.parse({
  name: 'authFailure',
  description: 'Cannot authenticate; retrying would not help',
  capabilities: ALL,
  steps: [step({ ending: 'authFailure' })],
})

/** Declares no write capability, for testing the role/capability check. */
export const READ_ONLY: Scenario = scenarioSchema.parse({
  name: 'readOnly',
  description: 'Can read and review but not write, so it cannot hold the implementer role',
  capabilities: ['repo-read', 'review', 'plan'],
  steps: [step({ report: report({ summary: 'Reviewed the diff' }) })],
})

/** The report an honest agent would print, fenced as the protocol requires. */
function fencedReport(body: Record<string, unknown>): string {
  return [
    'Reading the file now.',
    '',
    'FORGE_REPORT_BEGIN',
    JSON.stringify(body, null, 2),
    'FORGE_REPORT_END',
    '',
    'Let me know if you need anything else.',
  ].join('\n')
}

/**
 * Prints a fenced report as raw stdout, the way a real CLI does.
 *
 * Distinct from `happy`, which hands back a structured `result` event and so never
 * exercises extraction. This is the path a real adapter takes.
 */
export const TEXT_REPLY: Scenario = scenarioSchema.parse({
  name: 'textReply',
  description: 'Prints a valid fenced report as prose, as a CLI would',
  capabilities: ALL,
  steps: [
    step({
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
      ending: 'text',
      replyText: fencedReport({
        status: 'completed',
        summary: 'Corrected the constant',
        filesChanged: ['src/math.ts'],
        commandsRun: ['npm test'],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
      }),
    }),
  ],
})

/** Replies with prose and no report at all, which must be re-prompted. */
export const NO_REPORT: Scenario = scenarioSchema.parse({
  name: 'noReport',
  description: 'Answers in prose without a report block, then complies after the correction',
  capabilities: ALL,
  steps: [
    step({
      ending: 'text',
      replyText: 'All done! I fixed the constant and the tests pass.',
    }),
    step({
      ending: 'text',
      replyText: fencedReport({
        status: 'completed',
        summary: 'Corrected the constant',
        filesChanged: ['src/math.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      }),
    }),
  ],
})

/** Replies with a report missing a required field, twice. Exhausts the single retry. */
export const MALFORMED_TWICE: Scenario = scenarioSchema.parse({
  name: 'malformedTwice',
  description: 'Sends an invalid report, then sends an invalid report again',
  capabilities: ALL,
  steps: [
    step({ ending: 'text', replyText: fencedReport({ status: 'completed' }) }),
    step({ ending: 'text', replyText: fencedReport({ status: 'completed' }) }),
  ],
})

/**
 * Resubmits the identical change every time, forever.
 *
 * The scenario the no-progress detector exists for (#29): the reviewer objects, the
 * implementer "fixes" it by writing exactly the same content, and without a guard the loop
 * burns the whole iteration budget before stopping. Eight steps, well past the default cap
 * of five, so a test can prove the guard fires earlier than the cap does.
 */
export const NO_PROGRESS: Scenario = scenarioSchema.parse({
  name: 'noProgress',
  description: 'Writes the same content on every iteration, making no progress',
  capabilities: ALL,
  steps: Array.from({ length: 8 }, () =>
    step({
      narration: ['Addressing the review finding'],
      // Identical content each time, which is the whole point: the diff against the base
      // never changes.
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 41\n' }],
      report: report({
        // The summary varies in wording while the work does not — an agent describing the
        // same non-change differently each round is exactly what fools a summary-based
        // check and is caught by a diff-based one.
        summary: 'Fixed the constant this time',
        filesChanged: ['src/math.ts'],
      }),
    }),
  ),
})

/**
 * Enough honest turns for a whole workflow: plan, implement, review.
 *
 * Distinct from `happy`, which scripts a single step. A full run through the Feature
 * Implementation template needs three *agent* turns, and a scenario that ran out partway
 * would fail as "the agent produced no usable report" — a confusing way to discover the
 * fixture was too short.
 */
export const FULL_RUN: Scenario = scenarioSchema.parse({
  name: 'fullRun',
  description: 'Plans, implements, and reviews — three honest turns',
  capabilities: ALL,
  steps: [
    step({
      narration: ['Reading src/math.ts', 'The constant is wrong'],
      report: report({ summary: 'Plan: correct the constant to 42' }),
    }),
    step({
      narration: ['Applying the fix'],
      tools: [{ name: 'Edit', detail: 'src/math.ts' }],
      edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
      report: report({
        summary: 'Corrected the constant',
        filesChanged: ['src/math.ts'],
        commandsRun: ['npm test'],
        testsRun: true,
      }),
    }),
    step({
      narration: ['Reading the diff'],
      report: report({ summary: 'The change is correct and in scope' }),
    }),
  ],
})

export const SCENARIOS = {
  happy: HAPPY_PATH,
  correction: CORRECTION,
  question: QUESTION,
  assumer: ASSUMER,
  liar: LIAR,
  scopeCreep: SCOPE_CREEP,
  timeout: TIMEOUT,
  crash: CRASH,
  authFailure: AUTH_FAILURE,
  readOnly: READ_ONLY,
  textReply: TEXT_REPLY,
  noReport: NO_REPORT,
  malformedTwice: MALFORMED_TWICE,
  noProgress: NO_PROGRESS,
  fullRun: FULL_RUN,
} as const satisfies Record<string, Scenario>

export type ScenarioName = keyof typeof SCENARIOS
