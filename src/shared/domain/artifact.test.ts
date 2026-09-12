import { describe, expect, it } from 'vitest'
import {
  artifactIdSchema,
  artifactMetadataSchema,
  artifactUri,
  parseArtifactUri,
  runIdSchema,
} from './index'

const UUID_1 = '550e8400-e29b-41d4-a716-446655440000'
const UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

describe('Artifact domain schema and URI helpers', () => {
  it('validates a valid ArtifactMetadata', () => {
    const runId = runIdSchema.parse(UUID_1)
    const artifactId = artifactIdSchema.parse(UUID_2)

    const metadata = {
      id: artifactId,
      runId,
      stepId: null,
      kind: 'stdout' as const,
      name: 'build.log',
      mimeType: 'text/plain',
      sizeBytes: 1024,
      sha256: 'abc123def456',
      relativePath: `artifacts/${runId}/${artifactId}-build.log`,
      createdAt: new Date().toISOString(),
    }

    const parsed = artifactMetadataSchema.parse(metadata)
    expect(parsed.id).toBe(artifactId)
    expect(parsed.kind).toBe('stdout')
    expect(parsed.sizeBytes).toBe(1024)
  })

  it('formats and parses artifact URIs correctly', () => {
    const runId = runIdSchema.parse(UUID_1)
    const artifactId = artifactIdSchema.parse(UUID_2)

    const uri = artifactUri(runId, artifactId)
    expect(uri).toBe(`forge-artifact://${runId}/${artifactId}`)

    const parsed = parseArtifactUri(uri)
    expect(parsed).not.toBeNull()
    expect(parsed?.runId).toBe(runId)
    expect(parsed?.artifactId).toBe(artifactId)
  })

  it('returns null for malformed artifact URIs', () => {
    expect(parseArtifactUri('invalid-uri')).toBeNull()
    expect(parseArtifactUri('forge-artifact://not-a-uuid/also-not')).toBeNull()
    expect(parseArtifactUri('http://localhost/artifacts/123')).toBeNull()
  })
})
