import { z } from 'zod'
import { changeTypeSchema, verdictSchema } from './enums'
import {
  actorSchema,
  changeSetIdSchema,
  repoPathSchema,
  shaSchema,
  stepIdSchema,
  taskIdSchema,
  timestampSchema,
} from './ids'

/** One file's change, as reported by git. */
export const changedFileSchema = z.strictObject({
  path: repoPathSchema,
  changeType: changeTypeSchema,
  /** Set only for renames, so the move is traceable. */
  previousPath: repoPathSchema.nullable(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

export type ChangedFile = z.infer<typeof changedFileSchema>

/**
 * A mismatch between what an agent claimed and what the repository shows.
 *
 * This entity is the concrete form of axiom A3. Both directions matter: a file
 * claimed but unchanged suggests the work was not done, and a file changed but
 * unclaimed suggests the agent does not know what it did.
 */
export const discrepancySchema = z.strictObject({
  path: repoPathSchema,
  kind: z.enum(['claimed-but-unchanged', 'changed-but-unclaimed', 'outside-scope']),
  detail: z.string().min(1),
})

export type Discrepancy = z.infer<typeof discrepancySchema>

/**
 * What the repository actually shows after a step ran.
 *
 * Built by diffing against `baseSha`, captured **before** the step started.
 * Distinct from a step's output, which is only what the agent said.
 */
export const changeSetSchema = z
  .strictObject({
    id: changeSetIdSchema,
    /** The snapshot the diff was taken against. */
    baseSha: shaSchema,
    /** Null while the work is uncommitted, which is the normal MVP case. */
    headSha: shaSchema.nullable(),
    files: z.array(changedFileSchema).readonly(),
    /** The unified patch, kept so review sees the real thing, not a summary. */
    patch: z.string(),
    /** Which agent produced it, and which step and task it belongs to. */
    authorActor: actorSchema,
    stepId: stepIdSchema,
    taskId: taskIdSchema,
    /** Which changeset this one fixes, giving the correction loop lineage. */
    correctsChangeSetId: changeSetIdSchema.nullable(),
    reviewVerdict: verdictSchema.nullable(),
    discrepancies: z.array(discrepancySchema).readonly(),
    capturedAt: timestampSchema,
  })
  .check((ctx) => {
    const changeSet = ctx.value

    // A patch with no files, or files with no patch, means the capture went wrong;
    // treating either as a valid empty change would hide a broken diff.
    const hasFiles = changeSet.files.length > 0
    const hasPatch = changeSet.patch.trim().length > 0

    if (hasFiles !== hasPatch) {
      ctx.issues.push({
        code: 'custom',
        input: changeSet,
        path: ['patch'],
        message: 'A changeset must have either both files and a patch, or neither',
      })
    }
  })

export type ChangeSet = z.infer<typeof changeSetSchema>

/** True when a step produced no repository change at all. */
export function isEmptyChangeSet(changeSet: ChangeSet): boolean {
  return changeSet.files.length === 0
}

/** Total lines touched — used by the no-progress detector in #29. */
export function changeSetSize(changeSet: ChangeSet): number {
  return changeSet.files.reduce((total, file) => total + file.insertions + file.deletions, 0)
}
