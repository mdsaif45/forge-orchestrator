import { z } from 'zod'
import { actorSchema, questionIdSchema, timestampSchema } from './ids'

/**
 * A file an agent actually looked at before asking.
 *
 * `path:line` is preferred over a bare path so the user can be taken straight to
 * what the agent saw (#39).
 */
export const evidenceRefSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  /** What the agent concluded from this file — the reason it was not enough. */
  note: z.string().min(1),
})

export type EvidenceRef = z.infer<typeof evidenceRefSchema>

/**
 * A question an agent could not answer from the repository (axiom A2).
 *
 * The shape is the enforcement mechanism for "probe before asking": `evidence`
 * must be non-empty, so a question that skipped investigation cannot be
 * constructed. `whyUndetermined` must say what the investigation could not settle,
 * which is the difference between "I don't know" and "I looked, and here is
 * precisely why I still need you".
 */
export const openQuestionSchema = z
  .strictObject({
    id: questionIdSchema,
    question: z.string().min(1),
    whyUndetermined: z.string().min(1),
    /** Non-empty by construction: probe first, then ask. */
    evidence: z.array(evidenceRefSchema).min(1).readonly(),
    options: z.array(z.string().min(1)).readonly(),
    recommendation: z.string().min(1).nullable(),
    askedBy: actorSchema,
    askedAt: timestampSchema,
    answer: z.string().min(1).nullable(),
    answeredAt: timestampSchema.nullable(),
    /** Only ever `user`: no agent may answer a question, including its own. */
    answeredBy: z.literal('user').nullable(),
  })
  .check((ctx) => {
    const question = ctx.value
    const isAnswered = question.answer !== null

    if (isAnswered !== (question.answeredAt !== null)) {
      ctx.issues.push({
        code: 'custom',
        input: question,
        path: ['answeredAt'],
        message: 'An answered question must record when it was answered',
      })
    }

    if (isAnswered !== (question.answeredBy !== null)) {
      ctx.issues.push({
        code: 'custom',
        input: question,
        path: ['answeredBy'],
        message: 'An answered question must record who answered it',
      })
    }

    // A recommendation that is not among the options would leave the user
    // choosing between a list and a suggestion that contradicts it.
    if (
      question.recommendation !== null &&
      question.options.length > 0 &&
      !question.options.includes(question.recommendation)
    ) {
      ctx.issues.push({
        code: 'custom',
        input: question,
        path: ['recommendation'],
        message: 'A recommendation must be one of the listed options',
      })
    }
  })

export type OpenQuestion = z.infer<typeof openQuestionSchema>

export function isAnswered(question: OpenQuestion): boolean {
  return question.answer !== null
}
