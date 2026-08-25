import { describe, expect, it } from 'vitest'
import {
  assessReport,
  parseAgentReport,
  renderPromptPacket,
  REPORT_BEGIN,
  REPORT_END,
  REPORT_INSTRUCTIONS,
} from './protocol'
import {
  agentReportSchema,
  promptPacketSchema,
  type AgentReport,
  type PromptPacket,
} from './runtime'

/**
 * The wire protocol.
 *
 * This is the layer that replaces the user as the message bus, so the interesting cases are
 * the dishonest and the malformed ones: an agent that narrates around its report, omits a
 * field, admits an assumption, or claims a question without asking one. A protocol that only
 * handled well-formed replies would push all of that into the workflow engine.
 */

function report(overrides: Partial<AgentReport> = {}): AgentReport {
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

function packet(overrides: Partial<PromptPacket> = {}): PromptPacket {
  return promptPacketSchema.parse({
    role: 'implementer',
    objective: 'Correct the constant in src/math.ts',
    constraints: [],
    rules: [],
    lockedDecisions: [],
    allowedPaths: [],
    forbiddenPaths: [],
    relevantFiles: [],
    reviewFindings: [],
    previousAttempt: null,
    completionCriteria: [],
    answeredQuestions: [],
    ...overrides,
  })
}

/** Wraps a JSON body in the report fences, as an agent is instructed to. */
function fenced(body: string): string {
  return `${REPORT_BEGIN}\n${body}\n${REPORT_END}`
}

describe('parseAgentReport', () => {
  it('extracts a well-formed report', () => {
    const result = parseAgentReport(fenced(JSON.stringify(report({ summary: 'Fixed it' }))))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.report.summary).toBe('Fixed it')
  })

  it('ignores narration before and after the block', () => {
    // Rule R5 asks for a structured report; it does not stop a model explaining itself
    // around one, and rejecting that would fail on ordinary behaviour.
    const output = [
      "Sure! I'll take a look at that file now.",
      '',
      fenced(JSON.stringify(report())),
      '',
      'Let me know if you would like anything else.',
    ].join('\n')

    expect(parseAgentReport(output).ok).toBe(true)
  })

  it('tolerates a code fence inside the block', () => {
    // Models add one reflexively even when told not to. Burning the single retry on
    // formatting rather than substance would waste it.
    const output = `${REPORT_BEGIN}\n\`\`\`json\n${JSON.stringify(report())}\n\`\`\`\n${REPORT_END}`

    expect(parseAgentReport(output).ok).toBe(true)
  })

  it('uses the last end fence, so a report quoting the sentinel still parses', () => {
    // An agent echoing the instructions back is common; the naive first-match would cut
    // the JSON in half.
    const body = JSON.stringify(report({ summary: `Reply between ${REPORT_BEGIN} and X` }))
    const output = `${REPORT_BEGIN}\n${body}\n${REPORT_END}\n\nthat is the format I used.`

    const result = parseAgentReport(output)
    expect(result.ok).toBe(true)
  })

  it('reports a missing block by name', () => {
    const result = parseAgentReport('I finished the work. Everything looks good!')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('no-report')
    // The message is fed back to the agent verbatim, so it has to say what to do.
    expect(result.message).toContain(REPORT_BEGIN)
  })

  it('reports an unterminated block', () => {
    const result = parseAgentReport(`${REPORT_BEGIN}\n{"status":"completed"`)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unterminated-report')
  })

  it('reports invalid JSON', () => {
    const result = parseAgentReport(fenced('{ status: completed, }'))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-json')
  })

  it('reports a schema violation with the specific field', () => {
    // A vague "invalid report" would make the retry a guess; the whole reason for
    // validating with a schema is that the failure is actionable.
    const result = parseAgentReport(fenced(JSON.stringify({ status: 'completed' })))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('schema-violation')
    expect(result.message).toContain('summary')
  })

  it('rejects an unknown status rather than coercing it', () => {
    const result = parseAgentReport(fenced(JSON.stringify({ ...report(), status: 'mostly-done' })))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema-violation')
  })

  it('rejects an extra field, so a silently ignored key cannot hide meaning', () => {
    const result = parseAgentReport(fenced(JSON.stringify({ ...report(), definitelyDone: true })))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema-violation')
  })

  it('rejects a question with no evidence trail', () => {
    // Rule R2: a question without evidence is rejected back to the agent. The domain
    // schema enforces it, and this proves the protocol surfaces that rather than
    // accepting the question.
    const result = parseAgentReport(
      fenced(
        JSON.stringify({
          ...report(),
          status: 'question',
          openQuestions: [
            {
              question: 'Which convention applies?',
              whyUndetermined: 'Both exist',
              evidence: [],
              options: ['A', 'B'],
              recommendation: null,
            },
          ],
        }),
      ),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('schema-violation')
  })
})

describe('assessReport', () => {
  it('accepts a completed report as a claim entering verification', () => {
    const assessment = assessReport(report({ status: 'completed' }))

    expect(assessment.verdict).toBe('accept')
    // The wording keeps the distinction visible in the log: reported, not finished.
    expect(assessment.reason).toMatch(/claims/i)
  })

  it('halts on an admitted assumption', () => {
    // Rule R1 makes an assumption a violation, not a footnote.
    const assessment = assessReport(report({ assumptions: ['Assumed 404 is correct'] }))

    expect(assessment.verdict).toBe('halt-assumption')
    expect(assessment.reason).toContain('Assumed 404 is correct')
  })

  it('halts on an assumption even when the status claims completion', () => {
    // The ordering that matters: this pairing is exactly how R1 is violated in practice,
    // and taking `status` at face value first would let it through.
    const assessment = assessReport(
      report({ status: 'completed', summary: 'All done', assumptions: ['Guessed the format'] }),
    )

    expect(assessment.verdict).toBe('halt-assumption')
  })

  it('routes a question to the user and pauses', () => {
    const assessment = assessReport(
      report({
        status: 'question',
        openQuestions: [
          {
            question: '404 or 403?',
            whyUndetermined: 'Both conventions exist here',
            evidence: [{ path: 'src/api/orders.ts', line: 88, note: 'returns 404' }],
            options: ['404', '403'],
            recommendation: '403',
          },
        ],
      }),
    )

    expect(assessment.verdict).toBe('await-user')
  })

  it('treats a question status with no question as blocked', () => {
    // Claiming a question without asking one leaves the workflow with nothing to queue and
    // nothing to wait for, so it must not park indefinitely.
    const assessment = assessReport(report({ status: 'question', openQuestions: [] }))

    expect(assessment.verdict).toBe('halt-blocked')
    expect(assessment.reason).toMatch(/raised no question/)
  })

  it('halts on a blocked report, surfacing the agent’s own summary', () => {
    const assessment = assessReport(
      report({ status: 'blocked', summary: 'The build fails before my change' }),
    )

    expect(assessment.verdict).toBe('halt-blocked')
    expect(assessment.reason).toBe('The build fails before my change')
  })

  it('accepts a liar, because honesty is not a structural property', () => {
    // A report claiming files it never touched is *valid* — it is caught by reconciling
    // against a real diff (#34), not by this layer. Asserted so the boundary is explicit
    // rather than assumed: passing here does not mean the work happened.
    const assessment = assessReport(
      report({ filesChanged: ['src/math.ts'], commandsRun: ['npm test'], testsRun: true }),
    )

    expect(assessment.verdict).toBe('accept')
  })
})

describe('renderPromptPacket', () => {
  it('always states the role, the objective, and how to reply', () => {
    const text = renderPromptPacket(packet())

    expect(text).toContain('ROLE\nimplementer')
    expect(text).toContain('Correct the constant in src/math.ts')
    expect(text).toContain(REPORT_BEGIN)
    expect(text).toContain(REPORT_END)
  })

  it('omits empty sections rather than printing "none"', () => {
    // A packet is snapshotted per step and compared across runs; a wall of empty headings
    // makes a real change harder to see.
    const text = renderPromptPacket(packet())

    expect(text).not.toContain('CONSTRAINTS')
    expect(text).not.toContain('REVIEW FINDINGS')
    expect(text).not.toContain('PREVIOUS ATTEMPT')
  })

  it('includes rules without naming their scope', () => {
    // An agent is told what the rules are. Knowing one came from a project rather than
    // from Forge invites treating it as negotiable.
    const text = renderPromptPacket(packet({ rules: ['Never guess.', 'Stay in scope.'] }))

    expect(text).toContain('1. Never guess.')
    expect(text).toContain('2. Stay in scope.')
    expect(text).not.toContain('global')
    expect(text).not.toContain('project')
  })

  it('marks locked decisions as binding', () => {
    const text = renderPromptPacket(packet({ lockedDecisions: ['Use Redis as the backplane'] }))

    expect(text).toContain('LOCKED DECISIONS')
    expect(text).toContain('binding')
    expect(text).toContain('Use Redis as the backplane')
  })

  it('distinguishes what may be modified from what is merely relevant', () => {
    // `relevantFiles` is a hint and `allowedPaths` is a restriction; conflating them would
    // either over-constrain the agent or under-report the scope.
    const text = renderPromptPacket(
      packet({ allowedPaths: ['src/**'], relevantFiles: ['docs/DOMAIN.md'] }),
    )

    expect(text).toContain('YOU MAY MODIFY')
    expect(text).toContain('src/**')
    expect(text).toContain('not a limit')
    expect(text).toContain('docs/DOMAIN.md')
  })

  it('reports the previous attempt using Forge’s own measurement', () => {
    const text = renderPromptPacket(
      packet({
        previousAttempt: { summary: 'Changed the constant', diffStat: '1 file, +1 -1' },
        reviewFindings: ['The value is still wrong'],
      }),
    )

    expect(text).toContain('PREVIOUS ATTEMPT')
    expect(text).toContain('as measured by Forge')
    expect(text).toContain('1 file, +1 -1')
    expect(text).toContain('1. The value is still wrong')
  })

  it('says "(nothing)" when the previous attempt changed nothing', () => {
    // The liar case, stated to the next agent: an empty diffStat is information, and
    // printing an empty line would hide it.
    const text = renderPromptPacket(
      packet({ previousAttempt: { summary: 'Claimed to fix it', diffStat: '' } }),
    )

    expect(text).toContain('(nothing)')
  })

  it('states the completion criteria and who evaluates them', () => {
    const text = renderPromptPacket(
      packet({ completionCriteria: ['tests pass', 'build succeeds'] }),
    )

    expect(text).toContain('HOW COMPLETION IS JUDGED')
    // R6: telling the agent the criteria is not delegating the judgement.
    expect(text).toContain('Forge checks these itself')
  })

  it('marks answered questions as settled', () => {
    const text = renderPromptPacket(
      packet({ answeredQuestions: [{ question: '404 or 403?', answer: '403' }] }),
    )

    expect(text).toContain('do not ask again')
    expect(text).toContain('Q: 404 or 403?')
    expect(text).toContain('A: 403')
  })

  it('renders the same packet identically every time', () => {
    // The packet is snapshotted for replay, so rendering must be a pure function of its
    // input — no clock, no ordering that depends on object iteration.
    const subject = packet({ rules: ['a', 'b'], constraints: ['c'] })

    expect(renderPromptPacket(subject)).toBe(renderPromptPacket(subject))
  })
})

describe('the reply instructions', () => {
  it('show a filled-in example rather than a schema', () => {
    // A model reproduces a shape it has seen far more reliably than one it infers from
    // field descriptions.
    expect(REPORT_INSTRUCTIONS).toContain('"status": "completed"')
    expect(REPORT_INSTRUCTIONS).toContain('"assumptions": []')
  })

  it('state the rule that assumptions must be empty', () => {
    expect(REPORT_INSTRUCTIONS).toMatch(/assumptions.*MUST be empty/i)
  })

  it('state that Forge verifies rather than the agent deciding', () => {
    expect(REPORT_INSTRUCTIONS).toMatch(/you do not decide whether the task is done/i)
  })

  it('are parseable by the parser they describe', () => {
    // The example in the instructions must itself satisfy the schema, or the protocol
    // documents a shape it would reject.
    const result = parseAgentReport(REPORT_INSTRUCTIONS)

    expect(result.ok).toBe(true)
  })
})

describe('the read-only constraint', () => {
  function packetFor(role: string) {
    return promptPacketSchema.parse({
      role,
      objective: 'Fix add()',
      constraints: [],
      rules: [],
      lockedDecisions: [],
      allowedPaths: [],
      forbiddenPaths: [],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: [],
      answeredQuestions: [],
    })
  }

  it('tells a read-only role it may not write', () => {
    // The dogfood run's last defect (#130): the planner fixed the bug it was asked to
    // plan, and Forge halted it for reporting the change. The reconciler was right, but
    // the agent had never been told — and no CLI permission mode expresses "answer
    // normally but do not write", so the constraint belongs in the packet.
    const rendered = renderPromptPacket(packetFor('planner'))

    expect(rendered).toContain('YOU MAY NOT MODIFY ANY FILE')
    expect(rendered).toContain('a later step makes it')
  })

  it('says nothing of the kind to a role that writes', () => {
    const rendered = renderPromptPacket(packetFor('implementer'))

    expect(rendered).not.toContain('YOU MAY NOT MODIFY ANY FILE')
  })

  it('constrains a reviewer too, since it verifies rather than edits', () => {
    // A reviewer that could fix what it found would have no reason to report it.
    expect(renderPromptPacket(packetFor('reviewer'))).toContain('YOU MAY NOT MODIFY ANY FILE')
  })
})
