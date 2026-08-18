import { describe, expect, it } from 'vitest'
import {
  actorSchema,
  changeSetSchema,
  changeSetSize,
  decisionSchema,
  domainEventSchema,
  isEmptyChangeSet,
  isTerminalWorkflowState,
  openQuestionSchema,
  permissionsSchema,
  repoPathSchema,
  ruleScopeSpecificity,
  shaSchema,
  taskSchema,
  workflowSchema,
  WORKFLOW_STATES,
} from './index'

const NOW = '2026-08-18T12:00:00.000Z'
const UUID_A = '550e8400-e29b-41d4-a716-446655440000'
const UUID_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const UUID_C = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

describe('identifiers', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(shaSchema.safeParse('4fa1fc5').success).toBe(true)
    expect(shaSchema.safeParse('4fa1fc5a4fa1fc5a4fa1fc5a4fa1fc5a4fa1fc5a').success).toBe(true)
    expect(shaSchema.safeParse('4FA1FC5').success).toBe(false)
    expect(shaSchema.safeParse('xyz').success).toBe(false)
    expect(shaSchema.safeParse('4fa1fc').success).toBe(false)
  })

  describe('repository paths', () => {
    it('accepts a relative posix path', () => {
      expect(repoPathSchema.safeParse('src/main/index.ts').success).toBe(true)
    })

    it('rejects backslashes, which would not match git output or scope globs', () => {
      expect(repoPathSchema.safeParse('src\\main\\index.ts').success).toBe(false)
    })

    it('rejects absolute paths in either style', () => {
      expect(repoPathSchema.safeParse('/etc/passwd').success).toBe(false)
      expect(repoPathSchema.safeParse('C:/Windows/System32').success).toBe(false)
    })
  })

  describe('actor', () => {
    it('accepts user, system, and a qualified agent', () => {
      expect(actorSchema.safeParse('user').success).toBe(true)
      expect(actorSchema.safeParse('system').success).toBe(true)
      expect(actorSchema.safeParse('agent:planner-1').success).toBe(true)
    })

    it('rejects an agent with no identifier', () => {
      // 'agent:' would make the log unable to attribute an action to a runtime.
      expect(actorSchema.safeParse('agent:').success).toBe(false)
    })

    it('rejects an unknown actor kind', () => {
      expect(actorSchema.safeParse('robot').success).toBe(false)
    })
  })
})

describe('workflow states', () => {
  it('marks exactly the four terminal states as terminal', () => {
    const terminal = WORKFLOW_STATES.filter(isTerminalWorkflowState)

    expect(terminal).toEqual(['DONE', 'HALTED_LIMIT', 'HALTED_POLICY', 'CANCELLED'])
  })

  it('does not treat an in-progress state as terminal', () => {
    expect(isTerminalWorkflowState('IMPLEMENTING')).toBe(false)
    expect(isTerminalWorkflowState('AWAITING_USER')).toBe(false)
  })
})

describe('rule scope specificity', () => {
  it('orders scopes from global to task', () => {
    expect(ruleScopeSpecificity('global')).toBeLessThan(ruleScopeSpecificity('project'))
    expect(ruleScopeSpecificity('project')).toBeLessThan(ruleScopeSpecificity('task'))
  })
})

describe('permissions', () => {
  it('denies everything privileged by default', () => {
    const permissions = permissionsSchema.parse({})

    expect(permissions).toMatchObject({
      writeFiles: false,
      runTests: false,
      installPackages: false,
      gitWrite: false,
      network: false,
    })
  })

  it('allows reading by default, since inspection is always required', () => {
    const permissions = permissionsSchema.parse({})

    expect(permissions.readFiles).toBe(true)
    expect(permissions.gitRead).toBe(true)
  })
})

describe('decision', () => {
  const proposed = {
    id: UUID_A,
    statement: 'Use a Redis backplane',
    rationale: 'Multiple API containers need shared connection state',
    status: 'proposed' as const,
    proposedBy: 'agent:planner-1',
    proposedAt: NOW,
    lockedAt: null,
    lockedBy: null,
    supersededBy: null,
    originQuestionId: null,
  }

  it('accepts a proposed decision', () => {
    expect(decisionSchema.safeParse(proposed).success).toBe(true)
  })

  it('requires a rationale, so a decision can be re-evaluated later', () => {
    expect(decisionSchema.safeParse({ ...proposed, rationale: '' }).success).toBe(false)
  })

  it('requires lock metadata on a locked decision', () => {
    const result = decisionSchema.safeParse({ ...proposed, status: 'locked' })

    expect(result.success).toBe(false)
  })

  it('accepts a decision locked by the user', () => {
    const result = decisionSchema.safeParse({
      ...proposed,
      status: 'locked',
      lockedAt: NOW,
      lockedBy: 'user',
    })

    expect(result.success).toBe(true)
  })

  it('refuses a decision locked by an agent (axiom A4)', () => {
    // The schema-level half of decision lock: no agent may lock, even if a command
    // path were to try.
    const result = decisionSchema.safeParse({
      ...proposed,
      status: 'locked',
      lockedAt: NOW,
      lockedBy: 'agent:planner-1',
    })

    expect(result.success).toBe(false)
  })

  it('requires a superseded decision to name its replacement', () => {
    expect(decisionSchema.safeParse({ ...proposed, status: 'superseded' }).success).toBe(false)
    expect(
      decisionSchema.safeParse({ ...proposed, status: 'superseded', supersededBy: UUID_B }).success,
    ).toBe(true)
  })

  it('refuses a replacement on a decision that is not superseded', () => {
    expect(decisionSchema.safeParse({ ...proposed, supersededBy: UUID_B }).success).toBe(false)
  })
})

describe('open question', () => {
  const asked = {
    id: UUID_A,
    question: 'Should this endpoint return 403 or 404 for a cross-tenant resource?',
    whyUndetermined: 'Existing endpoints use both behaviours',
    evidence: [
      { path: 'src/AuthService.cs', line: 212, note: 'Returns 403 here' },
      { path: 'src/TenantController.cs', line: 88, note: 'Returns 404 here' },
    ],
    options: ['403', '404'],
    recommendation: '403',
    askedBy: 'agent:planner-1',
    askedAt: NOW,
    answer: null,
    answeredAt: null,
    answeredBy: null,
  }

  it('accepts a question with evidence', () => {
    expect(openQuestionSchema.safeParse(asked).success).toBe(true)
  })

  it('rejects a question with no evidence (axiom A2)', () => {
    // This is the structural enforcement of "probe before asking": a question that
    // skipped investigation cannot be constructed.
    expect(openQuestionSchema.safeParse({ ...asked, evidence: [] }).success).toBe(false)
  })

  it('requires a reason the repository could not settle it', () => {
    expect(openQuestionSchema.safeParse({ ...asked, whyUndetermined: '' }).success).toBe(false)
  })

  it('rejects a recommendation that is not one of the options', () => {
    expect(openQuestionSchema.safeParse({ ...asked, recommendation: '500' }).success).toBe(false)
  })

  it('requires answer, answeredAt and answeredBy to agree', () => {
    expect(openQuestionSchema.safeParse({ ...asked, answer: '403' }).success).toBe(false)
    expect(
      openQuestionSchema.safeParse({
        ...asked,
        answer: '403',
        answeredAt: NOW,
        answeredBy: 'user',
      }).success,
    ).toBe(true)
  })

  it('refuses an answer from an agent', () => {
    const result = openQuestionSchema.safeParse({
      ...asked,
      answer: '403',
      answeredAt: NOW,
      answeredBy: 'agent:planner-1',
    })

    expect(result.success).toBe(false)
  })
})

describe('task', () => {
  const task = {
    id: UUID_A,
    objective: 'Implement OAuth scope endpoints',
    constraints: ['Do not change public contracts'],
    completionCriteria: [
      { kind: 'build' as const, description: 'Build succeeds', params: {} },
      { kind: 'tests' as const, description: 'Tests pass', params: {} },
    ],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: ['migrations/**'] },
    lockedDecisionIds: [UUID_B],
    correctsTaskId: null,
    createdAt: NOW,
  }

  it('accepts a task with criteria', () => {
    expect(taskSchema.safeParse(task).success).toBe(true)
  })

  it('rejects a task with no completion criteria', () => {
    // Without a criterion, "done" would be a matter of opinion.
    expect(taskSchema.safeParse({ ...task, completionCriteria: [] }).success).toBe(false)
  })

  it('rejects an unknown criterion kind', () => {
    const result = taskSchema.safeParse({
      ...task,
      completionCriteria: [{ kind: 'vibes', description: 'Looks right', params: {} }],
    })

    expect(result.success).toBe(false)
  })
})

describe('workflow', () => {
  const workflow = {
    id: UUID_A,
    taskId: UUID_B,
    templateId: 'feature-implementation',
    state: 'IMPLEMENTING' as const,
    iteration: 1,
    limits: {
      maxIterations: 5,
      stepTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      totalTimeoutMs: 1000,
      maxRetries: 3,
    },
    steps: [],
    checkpoint: null,
    resumeState: null,
    blockedByQuestionId: null,
    haltReason: null,
    startedAt: NOW,
    finishedAt: null,
  }

  it('accepts a running workflow', () => {
    expect(workflowSchema.safeParse(workflow).success).toBe(true)
  })

  it('requires a resume state when awaiting the user', () => {
    // Without it, an answered question would have nowhere to resume into.
    expect(workflowSchema.safeParse({ ...workflow, state: 'AWAITING_USER' }).success).toBe(false)
    expect(
      workflowSchema.safeParse({
        ...workflow,
        state: 'AWAITING_USER',
        resumeState: 'IMPLEMENTING',
        blockedByQuestionId: UUID_C,
      }).success,
    ).toBe(true)
  })

  it('refuses a blocking question on a workflow that is not waiting', () => {
    expect(workflowSchema.safeParse({ ...workflow, blockedByQuestionId: UUID_C }).success).toBe(
      false,
    )
  })

  it('requires a halt reason when halted', () => {
    expect(workflowSchema.safeParse({ ...workflow, state: 'HALTED_LIMIT' }).success).toBe(false)
    expect(
      workflowSchema.safeParse({
        ...workflow,
        state: 'HALTED_LIMIT',
        haltReason: 'max-iterations',
      }).success,
    ).toBe(true)
  })

  it('refuses an iteration count above the configured maximum', () => {
    expect(workflowSchema.safeParse({ ...workflow, iteration: 6 }).success).toBe(false)
  })

  it('applies default limits', () => {
    const parsed = workflowSchema.parse({ ...workflow, limits: {} })

    expect(parsed.limits.maxIterations).toBe(5)
    expect(parsed.limits.idleTimeoutMs).toBe(10 * 60 * 1000)
  })
})

describe('changeset', () => {
  const changeSet = {
    id: UUID_A,
    baseSha: '4fa1fc5',
    headSha: null,
    files: [
      {
        path: 'src/main/index.ts',
        changeType: 'modified' as const,
        previousPath: null,
        insertions: 12,
        deletions: 3,
      },
    ],
    patch: '--- a/src/main/index.ts\n+++ b/src/main/index.ts\n',
    authorActor: 'agent:implementer-1',
    stepId: UUID_B,
    taskId: UUID_C,
    correctsChangeSetId: null,
    reviewVerdict: null,
    discrepancies: [],
    capturedAt: NOW,
  }

  it('accepts a captured changeset', () => {
    expect(changeSetSchema.safeParse(changeSet).success).toBe(true)
  })

  it('accepts an empty changeset with no patch', () => {
    const result = changeSetSchema.safeParse({ ...changeSet, files: [], patch: '' })

    expect(result.success).toBe(true)
  })

  it('rejects files without a patch, which means the capture went wrong', () => {
    expect(changeSetSchema.safeParse({ ...changeSet, patch: '' }).success).toBe(false)
  })

  it('rejects a patch with no files', () => {
    expect(changeSetSchema.safeParse({ ...changeSet, files: [] }).success).toBe(false)
  })

  it('records discrepancies between claim and reality', () => {
    const result = changeSetSchema.safeParse({
      ...changeSet,
      discrepancies: [
        {
          path: 'src/other.ts',
          kind: 'changed-but-unclaimed',
          detail: 'Modified but not reported',
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it('reports emptiness and size', () => {
    const parsed = changeSetSchema.parse(changeSet)

    expect(isEmptyChangeSet(parsed)).toBe(false)
    expect(changeSetSize(parsed)).toBe(15)
  })
})

describe('domain event', () => {
  const event = {
    id: UUID_A,
    projectId: UUID_B,
    seq: 1,
    type: 'project.created' as const,
    payload: { name: 'Forge' },
    actor: 'user',
    reason: null,
    occurredAt: NOW,
  }

  it('accepts an event', () => {
    expect(domainEventSchema.safeParse(event).success).toBe(true)
  })

  it('requires seq to be a positive integer', () => {
    expect(domainEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false)
    expect(domainEventSchema.safeParse({ ...event, seq: 1.5 }).success).toBe(false)
  })

  it('rejects an unknown event type', () => {
    // A projection switches exhaustively over this union, so an unrecognised type
    // must not be storable.
    expect(domainEventSchema.safeParse({ ...event, type: 'project.vanished' }).success).toBe(false)
  })
})

describe('schema strictness', () => {
  it('rejects unknown keys across every entity', () => {
    // Silent key-dropping would let a field be added in one place and quietly
    // ignored in another, which is how persistence and packets drift apart.
    const injected = { injected: true }

    expect(domainEventSchema.safeParse({ ...injected }).success).toBe(false)
    expect(taskSchema.safeParse({ ...injected }).success).toBe(false)
    expect(changeSetSchema.safeParse({ ...injected }).success).toBe(false)
  })
})
