import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  changedFileSchema,
  changeSetSchema,
  discrepancySchema,
  type Actor,
  type ChangeSet,
  type ChangeSetId,
  type Finding,
  type ProjectId,
  type Verdict,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { fromJson, parseRow } from './rows'
import { changeSets } from './schema'

export interface RecordReviewInput {
  readonly changeSetId: ChangeSetId
  readonly verdict: Verdict
  readonly claimedVerdict: Verdict
  readonly overridden: boolean
  readonly reason: string
  readonly findings: readonly Finding[]
  readonly reviewedBy: Actor
}

/**
 * Persists and reads ChangeSets from the projected read model.
 */
export class ChangeSetStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(changeSetId: ChangeSetId): ChangeSet | null {
    const row = this.db.select().from(changeSets).where(eq(changeSets.id, changeSetId)).get()

    if (row === undefined) return null
    return toChangeSet(row)
  }

  listForProject(projectId: ProjectId): readonly ChangeSet[] {
    const rows = this.db.select().from(changeSets).where(eq(changeSets.projectId, projectId)).all()

    return rows.map(toChangeSet)
  }

  record(changeSet: ChangeSet, projectId: ProjectId, actor: Actor, occurredAt: string): ChangeSet {
    changeSetSchema.parse(changeSet)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'changeset.captured', payload: { changeSet } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(changeSet.id)
    if (created === null) {
      throw new Error(`ChangeSet ${changeSet.id} was not found after being recorded`)
    }
    return created
  }

  recordReview(
    input: RecordReviewInput,
    projectId: ProjectId,
    actor: Actor,
    occurredAt: string,
  ): void {
    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'changeset.reviewed', payload: input },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }
}

function toChangeSet(row: typeof changeSets.$inferSelect): ChangeSet {
  return parseRow(
    changeSetSchema,
    {
      id: row.id,
      baseSha: row.baseSha,
      headSha: row.headSha,
      files: fromJson(z.array(changedFileSchema), row.files, 'change_sets.files'),
      patch: row.patch,
      authorActor: row.authorActor,
      stepId: row.stepId,
      taskId: row.taskId,
      correctsChangeSetId: row.correctsChangeSetId,
      reviewVerdict: row.reviewVerdict,
      discrepancies: fromJson(
        z.array(discrepancySchema),
        row.discrepancies,
        'change_sets.discrepancies',
      ),
      capturedAt: row.capturedAt,
    },
    'change_sets',
  )
}
