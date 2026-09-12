import { desc, eq } from 'drizzle-orm'
import {
  artifactMetadataSchema,
  type ArtifactId,
  type ArtifactMetadata,
  type RunId,
  type StepId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { parseRow } from './rows'
import { artifacts } from './schema'

/**
 * Metadata repository for on-disk execution artifacts.
 *
 * Implements Axiom A1/A3: Metadata and content hashes live in SQLite,
 * while raw file bytes reside in the filesystem.
 */
export class ArtifactStore {
  constructor(private readonly db: ForgeDatabase) {}

  /**
   * Records metadata for an artifact stored on disk.
   */
  record(metadata: ArtifactMetadata): ArtifactMetadata {
    const validated = parseRow(artifactMetadataSchema, metadata, 'artifactStore.record input')

    this.db
      .insert(artifacts)
      .values({
        id: validated.id,
        runId: validated.runId,
        stepId: validated.stepId,
        kind: validated.kind,
        name: validated.name,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
        sha256: validated.sha256,
        relativePath: validated.relativePath,
        createdAt: validated.createdAt,
      })
      .run()

    return validated
  }

  /**
   * Retrieves artifact metadata by its ID.
   */
  get(id: ArtifactId): ArtifactMetadata | null {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get()
    if (row === undefined) return null

    return parseRow(artifactMetadataSchema, row, 'artifacts.get')
  }

  /**
   * Lists all artifacts associated with an execution run.
   */
  listForRun(runId: RunId): readonly ArtifactMetadata[] {
    const rows = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(desc(artifacts.createdAt))
      .all()

    return rows.map((row) => parseRow(artifactMetadataSchema, row, 'artifacts.listForRun'))
  }

  /**
   * Lists all artifacts associated with a specific step.
   */
  listForStep(stepId: StepId): readonly ArtifactMetadata[] {
    const rows = this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.stepId, stepId))
      .orderBy(desc(artifacts.createdAt))
      .all()

    return rows.map((row) => parseRow(artifactMetadataSchema, row, 'artifacts.listForStep'))
  }
}
