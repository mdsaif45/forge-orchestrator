import { createHash } from 'node:crypto'

/**
 * The CLI session id a Forge step runs under.
 *
 * The Claude CLI accepts `--session-id <uuid>` and honours it exactly — measured:
 * a turn started with a supplied id reports that same id back, and `--resume <id>`
 * against it recalls the earlier turn's context.
 *
 * Deriving the id rather than storing one has a specific consequence: the same
 * step always maps to the same CLI session, so a resume is possible even after
 * Forge restarts and has lost whatever the provider reported. Storing the id
 * would work too, right up until the process that held it died mid-run — which
 * is exactly when resuming matters.
 *
 * ```
 * workflow + step  ──sha1──> uuid v5-shaped id ──> --session-id / --resume
 * ```
 *
 * A v5-shaped UUID rather than a random one: the CLI validates the format, and
 * this must be reproducible from inputs Forge already has. The namespace is a
 * fixed constant so two different Forge installations working on the same
 * workflow id do not collide with each other's sessions by accident.
 */
const FORGE_SESSION_NAMESPACE = 'a4f1c2e8-6b7d-4e3a-9f10-2c5d8e0b7a63'

/**
 * A stable UUID for a step's CLI session.
 *
 * Includes the iteration because a correction retry is a *new* conversation, not
 * a continuation of the attempt that failed: resuming into the transcript that
 * produced a rejected report would ask the agent to correct itself while still
 * reading its own mistake as established context.
 */
export function claudeSessionId(input: {
  readonly workflowId: string
  readonly stepIndex: number
  readonly iteration: number
}): string {
  const name = `${input.workflowId}/${String(input.stepIndex)}/${String(input.iteration)}`
  return uuidV5(FORGE_SESSION_NAMESPACE, name)
}

/**
 * RFC 4122 v5 (SHA-1) UUID, computed rather than pulled from a dependency.
 *
 * `node:crypto` has `randomUUID` but no name-based variant, and the algorithm is
 * short enough that adding a package for it would be the larger cost.
 */
function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest()

  const bytes = Buffer.from(hash.subarray(0, 16))
  // Version 5 in the high nibble of byte 6, and the RFC 4122 variant in byte 8.
  // Without these a validator rejects the value, and the CLI does validate.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}
