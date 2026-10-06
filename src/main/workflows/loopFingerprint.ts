import { createHash } from 'node:crypto'
import type { ChangeSet, WorkflowArtifact } from '@shared/domain'
import { canonicalizeJson, tryCanonicalizeJsonString } from '@shared/domain'

export interface RouterDecisionRecord {
  readonly routerNodeId: string
  readonly selectedEdgeId: string
  readonly targetNodeId: string
  readonly isFeedback?: boolean | undefined
}

export interface IterationFingerprintInput {
  readonly changeSet?: ChangeSet | null | undefined
  readonly diffPatch?: string | null | undefined
  readonly artifacts?: readonly WorkflowArtifact[] | undefined
  readonly routerDecisions?: readonly RouterDecisionRecord[] | undefined
  readonly context?: Readonly<Record<string, string>> | undefined
}

/**
 * Normalizes repository-relative paths to POSIX format.
 */
function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Strips operational/ephemeral metadata keys from artifact metadata.
 * Only semantic business properties are preserved.
 */
function filterSemanticMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {}
  const operationalKeys = new Set([
    'id',
    'createdAt',
    'timestamp',
    'durationMs',
    'attempt',
    'nodeRunId',
    'workflowId',
    'graphRunId',
  ])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (!operationalKeys.has(key)) {
      result[key] = value
    }
  }
  return result
}

/**
 * Computes the canonical CodeDiffShape from a ChangeSet or diffPatch.
 */
export function computeCodeDiffShape(
  changeSet?: ChangeSet | null,
  diffPatch?: string | null,
): string {
  if (changeSet && (changeSet.files.length > 0 || changeSet.patch.trim())) {
    const sortedFiles = [...changeSet.files].sort((a, b) =>
      normalizePath(a.path).localeCompare(normalizePath(b.path)),
    )
    const fileShape = sortedFiles
      .map((f) => `${normalizePath(f.path)}:${String(f.insertions)}:${String(f.deletions)}`)
      .join('|')

    const patchHash = createHash('sha256').update(changeSet.patch.trim()).digest('hex').slice(0, 16)

    return `${fileShape}#${patchHash}`
  }

  if (diffPatch?.trim()) {
    return `PATCH#${createHash('sha256').update(diffPatch.trim()).digest('hex').slice(0, 16)}`
  }

  return 'EMPTY'
}

/**
 * Computes the canonical SemanticArtifactsDigest from a list of artifacts.
 * Strips operational metadata (random UUIDs, timestamps, workflow IDs) while preserving
 * semantic fields (nodeId, kind, title, format, canonicalized content, and semantic metadata).
 */
export function computeSemanticArtifactsDigest(
  artifacts: readonly WorkflowArtifact[] = [],
): string {
  if (artifacts.length === 0) {
    return 'EMPTY'
  }

  const normalized = artifacts.map((art) => ({
    nodeId: art.nodeId,
    kind: art.kind,
    title: art.title,
    format: art.format,
    content: tryCanonicalizeJsonString(art.content),
    metadata: filterSemanticMetadata(art.metadata),
  }))

  normalized.sort((a, b) => {
    const nodeCmp = a.nodeId.localeCompare(b.nodeId)
    if (nodeCmp !== 0) return nodeCmp
    const kindCmp = a.kind.localeCompare(b.kind)
    if (kindCmp !== 0) return kindCmp
    return a.title.localeCompare(b.title)
  })

  return createHash('sha256').update(canonicalizeJson(normalized)).digest('hex')
}

/**
 * Computes the canonical RouterDecisionsDigest from executed router decisions.
 */
export function computeRouterDecisionsDigest(
  decisions: readonly RouterDecisionRecord[] = [],
): string {
  if (decisions.length === 0) {
    return 'EMPTY'
  }

  const sorted = [...decisions].sort((a, b) => a.routerNodeId.localeCompare(b.routerNodeId))
  return createHash('sha256').update(canonicalizeJson(sorted)).digest('hex')
}

/**
 * Computes the canonical ContextDigest from execution context.
 */
export function computeContextDigest(context?: Readonly<Record<string, string>>): string {
  if (!context || Object.keys(context).length === 0) {
    return 'EMPTY'
  }

  const sortedKeys = Object.keys(context).sort()
  const sortedObj = Object.fromEntries(sortedKeys.map((k) => [k, context[k]]))
  return createHash('sha256').update(canonicalizeJson(sortedObj)).digest('hex')
}

/**
 * Computes the canonical semantic iteration fingerprint Φ(iteration).
 *
 * Combines:
 * - CodeDiffShape (ChangeSet files + patch)
 * - SemanticArtifactsDigest (loop artifacts with operational metadata stripped)
 * - RouterDecisionsDigest (router node choices)
 * - ContextDigest (immutable/updated execution context)
 *
 * Guarantees that semantically identical states produce identical fingerprints,
 * while any meaningful change in code, artifacts, router decisions, or context alters it.
 */
export function computeIterationFingerprint(input: IterationFingerprintInput): string {
  const codeDiffShape = computeCodeDiffShape(input.changeSet, input.diffPatch)
  const artifactsDigest = computeSemanticArtifactsDigest(input.artifacts)
  const routerDecisionsDigest = computeRouterDecisionsDigest(input.routerDecisions)
  const contextDigest = computeContextDigest(input.context)

  return createHash('sha256')
    .update(`${codeDiffShape}::${artifactsDigest}::${routerDecisionsDigest}::${contextDigest}`)
    .digest('hex')
}

/**
 * Calculates the number of consecutive occurrences of `current` in history.
 * Example:
 * If history ends with [F], and current === F, returns 1.
 * If history ends with [F, F], and current === F, returns 2.
 * If history is empty or ends with a different fingerprint, returns 0.
 */
export function getConsecutiveRepeatCount(history: readonly string[], current: string): number {
  let count = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === current) {
      count++
    } else {
      break
    }
  }
  return count
}
