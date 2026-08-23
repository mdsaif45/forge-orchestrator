import { projectIdSchema, questionIdSchema, type OpenQuestion } from '@shared/domain'
import type { OpenQuestionView } from '@shared/ipc'
import type { QuestionStore } from '../db/questionStore'

export interface QuestionServiceOptions {
  readonly questions: QuestionStore
  readonly onQuestionAnswered?: (question: OpenQuestion) => void
}

export class QuestionService {
  constructor(private readonly options: QuestionServiceOptions) {}

  list(projectId: string, unansweredOnly?: boolean): readonly OpenQuestionView[] {
    const pId = projectIdSchema.parse(projectId)
    const list = this.options.questions.listForProject(pId, {
      unansweredOnly: unansweredOnly === true,
    })
    return list.map(toView)
  }

  get(questionId: string): OpenQuestionView | null {
    const qId = questionIdSchema.parse(questionId)
    const q = this.options.questions.find(qId)
    return q === null ? null : toView(q)
  }

  answer(questionId: string, answerText: string): OpenQuestionView {
    const qId = questionIdSchema.parse(questionId)
    const now = new Date().toISOString()
    const updated = this.options.questions.answer(qId, answerText, 'user', now)
    this.options.onQuestionAnswered?.(updated)
    return toView(updated)
  }
}

function toView(q: OpenQuestion): OpenQuestionView {
  return {
    id: q.id,
    question: q.question,
    whyUndetermined: q.whyUndetermined,
    evidence: q.evidence.map((e) => ({
      path: e.path,
      line: e.line,
      note: e.note,
    })),
    options: [...q.options],
    recommendation: q.recommendation,
    askedBy: q.askedBy,
    askedAt: q.askedAt,
    answer: q.answer,
    answeredAt: q.answeredAt,
    answeredBy: q.answeredBy,
  }
}
