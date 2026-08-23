import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openQuestionSchema,
  projectIdSchema,
  questionIdSchema,
  repositoryIdSchema,
  type OpenQuestion,
  type ProjectId,
} from '@shared/domain'
import { openDatabase, runMigrations } from '.'
import type { ForgeDatabase } from './connection'
import { EventStore } from './eventStore'
import { MIGRATIONS } from './migrations.generated'
import { QuestionStore } from './questionStore'
import { ProjectStore } from './projectStore'
import { rebuildProjections } from './projections'

describe('QuestionStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let questions: QuestionStore
  let projects: ProjectStore
  let projectId: ProjectId

  const NOW = '2026-08-23T12:00:00.000Z'

  beforeEach(() => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    events = new EventStore(db)
    questions = new QuestionStore(db, events)
    projects = new ProjectStore(db, events)

    projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: 'D:/Projects/Test',
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )
  })

  afterEach(() => {
    close()
  })

  it('persists an asked question with evidence and retrieves it', () => {
    const questionId = questionIdSchema.parse(randomUUID())
    const openQ: OpenQuestion = {
      id: questionId,
      question: 'Which API endpoint should handle auth?',
      whyUndetermined: 'Found both /api/v1/auth and /api/v2/auth referenced in routes.',
      evidence: [
        { path: 'src/routes/v1.ts', line: 42, note: 'Defines legacy /auth' },
        { path: 'src/routes/v2.ts', line: 15, note: 'Defines next-gen /auth' },
      ],
      options: ['Use v1 endpoint', 'Use v2 endpoint'],
      recommendation: 'Use v2 endpoint',
      askedBy: 'agent:planner',
      askedAt: NOW,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    }

    const saved = questions.ask(openQ, projectId, 'agent:planner', NOW)
    expect(saved.id).toBe(questionId)
    expect(saved.question).toBe('Which API endpoint should handle auth?')
    expect(saved.evidence).toHaveLength(2)
    expect(saved.evidence[0]?.path).toBe('src/routes/v1.ts')

    const found = questions.find(questionId)
    expect(found).toEqual(saved)
  })

  it('answers an open question and updates state', () => {
    const questionId = questionIdSchema.parse(randomUUID())
    const openQ: OpenQuestion = {
      id: questionId,
      question: 'Use postgres or sqlite?',
      whyUndetermined: 'Config has flags for both drivers.',
      evidence: [{ path: 'config.json', line: 5, note: 'driver: sqlite' }],
      options: ['postgres', 'sqlite'],
      recommendation: 'sqlite',
      askedBy: 'agent:implementer',
      askedAt: NOW,
      answer: null,
      answeredAt: null,
      answeredBy: null,
    }

    questions.ask(openQ, projectId, 'agent:implementer', NOW)
    expect(questions.listUnanswered()).toHaveLength(1)

    const answered = questions.answer(questionId, 'sqlite', 'user', '2026-08-23T12:05:00.000Z')
    expect(answered.answer).toBe('sqlite')
    expect(answered.answeredBy).toBe('user')
    expect(answered.answeredAt).toBe('2026-08-23T12:05:00.000Z')

    expect(questions.listUnanswered()).toHaveLength(0)
    expect(questions.listForProject(projectId, { unansweredOnly: true })).toHaveLength(0)
    expect(questions.listForProject(projectId)).toHaveLength(1)
  })

  it('rebuilds question projections identically from event log', () => {
    const q1 = questionIdSchema.parse(randomUUID())
    const q2 = questionIdSchema.parse(randomUUID())

    questions.ask(
      {
        id: q1,
        question: 'Q1?',
        whyUndetermined: 'Reason 1',
        evidence: [{ path: 'a.ts', line: 1, note: 'Note 1' }],
        options: ['A', 'B'],
        recommendation: 'A',
        askedBy: 'agent:planner',
        askedAt: NOW,
        answer: null,
        answeredAt: null,
        answeredBy: null,
      },
      projectId,
      'agent:planner',
      NOW,
    )

    questions.ask(
      {
        id: q2,
        question: 'Q2?',
        whyUndetermined: 'Reason 2',
        evidence: [{ path: 'b.ts', line: 2, note: 'Note 2' }],
        options: ['C', 'D'],
        recommendation: null,
        askedBy: 'agent:implementer',
        askedAt: NOW,
        answer: null,
        answeredAt: null,
        answeredBy: null,
      },
      projectId,
      'agent:implementer',
      NOW,
    )

    questions.answer(q1, 'A', 'user', '2026-08-23T12:02:00.000Z')

    const before = questions.listForProject(projectId)
    const allEvents = events.read(projectId)

    // Rebuild projection from event stream
    rebuildProjections(db, projectId, allEvents)

    const after = questions.listForProject(projectId)
    expect(after).toEqual(before)
  })

  it('rejects a question with empty evidence (Axiom A2)', () => {
    expect(() => {
      openQuestionSchema.parse({
        id: questionIdSchema.parse(randomUUID()),
        question: 'Lazy question?',
        whyUndetermined: 'Did not check',
        evidence: [], // Violates min(1)
        options: ['Yes', 'No'],
        recommendation: null,
        askedBy: 'agent:planner',
        askedAt: NOW,
        answer: null,
        answeredAt: null,
        answeredBy: null,
      })
    }).toThrow()
  })
})
