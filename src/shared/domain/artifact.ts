import { z } from 'zod'
import {
  artifactIdSchema,
  runIdSchema,
  stepIdSchema,
  timestampSchema,
  type ArtifactId,
  type RunId,
} from './ids'

/** The functional role or origin of the artifact. */
export const artifactKindSchema = z.enum([
  'stdout',
  'stderr',
  'tool-input',
  'tool-output',
  'diff',
  'prompt-packet',
  'agent-raw',
  'custom',
])

export type ArtifactKind = z.infer<typeof artifactKindSchema>

/**
 * Metadata describing a physical artifact file on disk.
 *
 * Implements Axiom A1/A3: The raw bytes live in the filesystem
 * under `<dataDir>/artifacts/<run-id>/<artifact-id>-<name>`, while
 * this metadata is stored in SQLite for querying and relational linkage.
 */
export const artifactMetadataSchema = z.strictObject({
  id: artifactIdSchema,
  runId: runIdSchema,
  stepId: stepIdSchema.nullable(),
  kind: artifactKindSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  relativePath: z.string().min(1),
  createdAt: timestampSchema,
})

export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>

/** Generates a standard content-addressable URI for an artifact. */
export function artifactUri(runId: RunId, artifactId: ArtifactId): string {
  return `forge-artifact://${runId}/${artifactId}`
}

/** Parses a standard artifact URI into its run and artifact IDs. */
export function parseArtifactUri(
  uri: string,
): { readonly runId: RunId; readonly artifactId: ArtifactId } | null {
  const match = /^forge-artifact:\/\/([^/]+)\/([^/]+)$/.exec(uri)
  if (match?.[1] === undefined || match[2] === undefined) {
    return null
  }

  const parsedRun = runIdSchema.safeParse(match[1])
  const parsedArtifact = artifactIdSchema.safeParse(match[2])

  if (!parsedRun.success || !parsedArtifact.success) {
    return null
  }

  return {
    runId: parsedRun.data,
    artifactId: parsedArtifact.data,
  }
}
