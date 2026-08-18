import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promptPacketSchema, type PromptPacket } from '@shared/domain'

/**
 * Snapshots prompt packets to disk.
 *
 * A step records a `contextRef` rather than the packet itself, and this is what that
 * reference points at. Two things depend on it:
 *
 *   - **replay.** A resumed step must send the packet it was originally sending, not one
 *     recompiled from state that has moved on since the crash (#28).
 *   - **audit.** "Why did the agent do that?" is answerable only if what the agent was told
 *     still exists, byte for byte, months later (A7 — legible by design).
 *
 * Content-addressed: the reference *is* the hash of the packet. Identical context therefore
 * writes one file rather than many, and a reference cannot point at a packet that has since
 * been edited — the hash would no longer match. That is a stronger guarantee than a
 * sequential id, which says only "the packet that was here".
 */

export interface PacketStoreOptions {
  /** Directory the snapshots live in. Created on first write. */
  readonly directory: string
}

export class PacketStore {
  constructor(private readonly options: PacketStoreOptions) {}

  /**
   * Writes a packet and returns its reference.
   *
   * Idempotent by construction: the same packet yields the same reference and rewrites the
   * same bytes. A step redone after a crash therefore produces the same `contextRef`, which
   * is what makes "did the resumed step send the same context?" a checkable question rather
   * than a hopeful one.
   */
  async save(packet: PromptPacket): Promise<string> {
    const serialised = serialise(packet)
    const reference = hashOf(serialised)

    await mkdir(this.options.directory, { recursive: true })
    await writeFile(this.pathFor(reference), serialised, 'utf8')

    return reference
  }

  /**
   * Reads a packet back, validating it.
   *
   * Parsed rather than trusted: a snapshot that was hand-edited, or written by an older
   * version with a different shape, must fail here with a precise message rather than flow
   * into a step as a plausible-looking packet.
   */
  async load(reference: string): Promise<PromptPacket | null> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(reference), 'utf8')
    } catch {
      return null
    }

    // The reference is the hash, so a mismatch means the file changed after it was written.
    // Reported as absent rather than returned, because a packet that is not what it claims
    // to be is worse than no packet: replay would silently send different context.
    if (hashOf(raw) !== reference) return null

    return promptPacketSchema.parse(JSON.parse(raw))
  }

  private pathFor(reference: string): string {
    return join(this.options.directory, `${reference}.json`)
  }
}

/**
 * Serialises a packet deterministically, with keys sorted at every depth.
 *
 * The context engine builds its object in a fixed order, so insertion order is already
 * stable for packets it produces. Sorting anyway matters because a packet arriving from
 * anywhere else — a test fixture, a future caller, a hand-written replay — must hash the
 * same, and a reference that depended on key order would break exactly the audit property
 * this store exists to provide.
 *
 * Sorted by rebuilding the object rather than with `JSON.stringify`'s replacer-array form.
 * Measured: that form applies the key list at *every* depth, so a nested object whose keys
 * are not in the top-level list is emitted as `{}` — `previousAttempt` became empty and
 * `answeredQuestions` lost its contents. A snapshot like that would replay the wrong context
 * with no sign anything was missing.
 */
function serialise(packet: PromptPacket): string {
  return JSON.stringify(sortKeys(packet), null, 2)
}

/** Recursively rebuilds a value with object keys in sorted order. Arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }

  return value
}

function hashOf(serialised: string): string {
  // SHA-256 truncated to 16 bytes. Not a security boundary — it identifies Forge's own
  // packets — but long enough that a collision between two packets in one project is not a
  // thing that happens.
  return createHash('sha256').update(serialised).digest('hex').slice(0, 32)
}
