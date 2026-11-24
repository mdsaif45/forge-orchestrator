import { describe, expect, it } from 'vitest'
import { generateArtifactMerkleTree, verifyMerkleProof, type ArtifactInfo } from './merkleLineage'

describe('ArtifactMerkleLineage (EVIDENCE-006)', () => {
  const artifacts: ArtifactInfo[] = [
    {
      id: 'art-001',
      name: 'prompt-packet.json',
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      stepId: 'step-01',
      kind: 'json',
      sizeBytes: 1024,
    },
    {
      id: 'art-002',
      name: 'verification-result.json',
      checksum: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      stepId: 'step-02',
      kind: 'json',
      sizeBytes: 512,
    },
    {
      id: 'art-003',
      name: 'execution-diff.patch',
      checksum: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
      stepId: 'step-02',
      kind: 'diff',
      sizeBytes: 2048,
    },
  ]

  it('generates a deterministic Merkle root hash for an artifact set', () => {
    const report1 = generateArtifactMerkleTree(artifacts)
    const report2 = generateArtifactMerkleTree([...artifacts].reverse())

    expect(report1.valid).toBe(true)
    expect(report1.artifactCount).toBe(3)
    expect(report1.treeDepth).toBe(2)
    expect(report1.rootHash).toBe(report2.rootHash)
    expect(report1.leaves.length).toBe(3)
  })

  it('verifies cryptographic Merkle inclusion proofs for each leaf', () => {
    const report = generateArtifactMerkleTree(artifacts)

    for (const art of artifacts) {
      const leaf = report.leaves.find((l) => l.artifactId === art.id)
      expect(leaf).toBeDefined()
      if (leaf) {
        const verified = verifyMerkleProof(art, leaf.proof, report.rootHash)
        expect(verified).toBe(true)
      }
    }
  })

  it('detects byte-level and metadata tampering immediately (A3)', () => {
    const report = generateArtifactMerkleTree(artifacts)
    const firstArt = artifacts[0]
    expect(firstArt).toBeDefined()
    if (!firstArt) return
    const tamperedArtifact: ArtifactInfo = {
      ...firstArt,
      checksum: 'tampered-checksum-12345',
    }

    const leaf = report.leaves.find((l) => l.artifactId === tamperedArtifact.id)!
    const verified = verifyMerkleProof(tamperedArtifact, leaf.proof, report.rootHash)
    expect(verified).toBe(false)
  })

  it('handles empty artifact sets deterministically', () => {
    const emptyReport = generateArtifactMerkleTree([])
    expect(emptyReport.valid).toBe(true)
    expect(emptyReport.artifactCount).toBe(0)
    expect(emptyReport.treeDepth).toBe(0)
    expect(emptyReport.rootHash).toBeDefined()
  })
})
