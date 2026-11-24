import { createHash } from 'node:crypto'

export interface ArtifactInfo {
  readonly id: string
  readonly name: string
  readonly checksum?: string | undefined
  readonly stepId?: string | undefined
  readonly kind?: string | undefined
  readonly sizeBytes?: number | undefined
}

export interface MerkleProofStep {
  readonly position: 'left' | 'right'
  readonly hash: string
}

export interface MerkleLeafRecord {
  readonly artifactId: string
  readonly name: string
  readonly hash: string
  readonly stepId?: string | undefined
  readonly proof: readonly MerkleProofStep[]
}

export interface ArtifactMerkleReport {
  readonly valid: boolean
  readonly rootHash: string
  readonly artifactCount: number
  readonly treeDepth: number
  readonly leaves: readonly MerkleLeafRecord[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function computeArtifactLeafHash(art: ArtifactInfo): string {
  const payload = `${art.id}:${art.name}:${art.checksum ?? 'none'}:${art.stepId ?? 'none'}`
  return sha256(payload)
}

/**
 * Builds a binary Merkle tree over artifacts, returning the root hash and audit proof paths (Axioms A1, A3, A4).
 */
export function generateArtifactMerkleTree(
  artifacts: readonly ArtifactInfo[],
): ArtifactMerkleReport {
  if (artifacts.length === 0) {
    const emptyRoot = sha256('empty-lineage')
    return {
      valid: true,
      rootHash: emptyRoot,
      artifactCount: 0,
      treeDepth: 0,
      leaves: [],
      formattedSummary: `MERKLE LINEAGE VERIFIED: 0 artifacts (Root: ${emptyRoot})`,
    }
  }

  // Deterministically sort artifacts by ID
  const sorted = [...artifacts].sort((a, b) => a.id.localeCompare(b.id))

  // Layer 0: Leaf hashes
  const leafNodes = sorted.map((art) => ({
    artifact: art,
    hash: computeArtifactLeafHash(art),
  }))

  const initialLayer = leafNodes.map((l) => l.hash)
  const treeLayers: string[][] = [initialLayer]
  let currentLayer = initialLayer

  while (currentLayer.length > 1) {
    const nextLayer: string[] = []
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i] ?? ''
      const right = currentLayer[i + 1] ?? left
      nextLayer.push(sha256(`${left}:${right}`))
    }
    treeLayers.push(nextLayer)
    currentLayer = nextLayer
  }

  const rootHash = currentLayer[0] ?? ''
  const treeDepth = treeLayers.length - 1

  // Compute Merkle audit proofs for each leaf
  const leaves: MerkleLeafRecord[] = leafNodes.map((leaf, leafIndex) => {
    const proof: MerkleProofStep[] = []
    let currentIndex = leafIndex

    for (let layerIdx = 0; layerIdx < treeLayers.length - 1; layerIdx++) {
      const layer = treeLayers[layerIdx] ?? []
      const isEven = currentIndex % 2 === 0
      const siblingIndex = isEven ? currentIndex + 1 : currentIndex - 1

      if (siblingIndex < layer.length) {
        proof.push({
          position: isEven ? 'right' : 'left',
          hash: layer[siblingIndex] ?? '',
        })
      } else {
        // Self-hash for odd element
        proof.push({
          position: 'right',
          hash: layer[currentIndex] ?? '',
        })
      }

      currentIndex = Math.floor(currentIndex / 2)
    }

    return {
      artifactId: leaf.artifact.id,
      name: leaf.artifact.name,
      hash: leaf.hash,
      stepId: leaf.artifact.stepId,
      proof,
    }
  })

  const formattedSummary =
    `MERKLE LINEAGE VERIFIED\n` +
    `  Root Hash:      ${rootHash}\n` +
    `  Artifact Count: ${String(artifacts.length)}\n` +
    `  Tree Depth:     ${String(treeDepth)}`

  return {
    valid: true,
    rootHash,
    artifactCount: artifacts.length,
    treeDepth,
    leaves,
    formattedSummary,
  }
}

/**
 * Cryptographically verifies an artifact's inclusion proof against an expected Merkle root (Axiom A3).
 */
export function verifyMerkleProof(
  artifact: ArtifactInfo,
  proof: readonly MerkleProofStep[],
  expectedRoot: string,
): boolean {
  let currentHash = computeArtifactLeafHash(artifact)

  for (const step of proof) {
    if (step.position === 'right') {
      currentHash = sha256(`${currentHash}:${step.hash}`)
    } else {
      currentHash = sha256(`${step.hash}:${currentHash}`)
    }
  }

  return currentHash === expectedRoot
}
