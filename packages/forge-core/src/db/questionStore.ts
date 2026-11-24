import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  evidenceRefSchema,
  openQuestionSchema,
  projectIdSchema,
  type Actor,
  type DecisionId,
  type OpenQuestion,
  type ProjectId,
  type QuestionId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { fromJson, parseRow } from './rows'
import { openQuestions } from './schema'

/**
 * Persists and queries open questions.
 *
 * Implements axiom A2: unknown != assume. When an agent cannot answer a question
 * from repository exploration, it records the question with evidence here.
 *
 * All mutations write through the event log (`question.asked`, `question.answered`)
 * before updating read models.
 */
export class QuestionStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(questionId: QuestionId): OpenQuestion | null {
    const row = this.db.select().from(openQuestions).where(eq(openQuestions.id, questionId)).get()

    if (row === undefined) return null
    return toOpenQuestion(row)
  }

  listForProject(
    projectId: ProjectId,
    options: { readonly unansweredOnly?: boolean } = {},
  ): readonly OpenQuestion[] {
    const query =
      options.unansweredOnly === true
        ? this.db
            .select()
            .from(openQuestions)
            .where(and(eq(openQuestions.projectId, projectId), isNull(openQuestions.answeredAt)))
        : this.db.select().from(openQuestions).where(eq(openQuestions.projectId, projectId))

    const rows = query.all()
    return rows.map(toOpenQuestion)
  }

  listUnanswered(): readonly OpenQuestion[] {
    const rows = this.db.select().from(openQuestions).where(isNull(openQuestions.answeredAt)).all()

    return rows.map(toOpenQuestion)
  }

  ask(
    question: OpenQuestion,
    projectId: ProjectId,
    actor: Actor,
    occurredAt: string,
  ): OpenQuestion {
    // Validate domain schema before appending
    openQuestionSchema.parse(question)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'question.asked', payload: { question } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(question.id)
    if (created === null) {
      throw new Error(`Question ${question.id} was not projected after being asked`)
    }
    return created
  }

  answer(
    questionId: QuestionId,
    answer: string,
    actor: 'user',
    occurredAt: string,
    promotedToDecisionId: DecisionId | null = null,
  ): OpenQuestion {
    const existing = this.find(questionId)
    if (existing === null) {
      throw new Error(`Question ${questionId} not found`)
    }

    const projectId = this.projectIdOf(questionId)

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'question.answered',
          payload: { questionId, answer, answeredAt: occurredAt, promotedToDecisionId },
        },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const updated = this.find(questionId)
    if (updated === null) {
      throw new Error(`Question ${questionId} was not found after being answered`)
    }
    return updated
  }

  private projectIdOf(questionId: QuestionId): ProjectId {
    const row = this.db
      .select({ projectId: openQuestions.projectId })
      .from(openQuestions)
      .where(eq(openQuestions.id, questionId))
      .get()

    if (row === undefined) {
      throw new Error(`Question ${questionId} not found`)
    }
    return projectIdSchema.parse(row.projectId)
  }
}

function toOpenQuestion(row: typeof openQuestions.$inferSelect): OpenQuestion {
  return parseRow(
    openQuestionSchema,
    {
      id: row.id,
      question: row.question,
      whyUndetermined: row.whyUndetermined,
      evidence: fromJson(z.array(evidenceRefSchema), row.evidence, 'open_questions.evidence'),
      options: fromJson(z.array(z.string()), row.options, 'open_questions.options'),
      recommendation: row.recommendation,
      askedBy: row.askedBy,
      askedAt: row.askedAt,
      answer: row.answer,
      answeredAt: row.answeredAt,
      answeredBy: row.answeredBy,
    },
    'open_questions',
  )
}
