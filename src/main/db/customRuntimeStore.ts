import { eq } from 'drizzle-orm'
import { projectIdSchema, type Actor, type Capability } from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { customRuntimes } from './schema'

export interface CustomRuntimeRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly command: string
  readonly argsTemplate: string | null
  readonly capabilities: readonly Capability[]
  readonly permissionMode: string
  readonly instructionFilenames: readonly string[]
  readonly env: Readonly<Record<string, string>> | null
  readonly createdAt: string
}

export interface CreateCustomRuntimeInput {
  readonly id?: string | undefined
  readonly slug: string
  readonly name: string
  readonly command: string
  readonly argsTemplate?: string | null | undefined
  readonly capabilities: readonly Capability[]
  readonly permissionMode?: string | undefined
  readonly instructionFilenames?: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>> | null | undefined
}

/**
 * Persists and manages user-configured custom CLI runtimes (#174).
 *
 * Configured as data in SQLite and the event log (Axiom A1 & A6),
 * surviving restarts and dynamically registered into the runtime registry.
 */
export class CustomRuntimeStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(id: string): CustomRuntimeRecord | null {
    const row = this.db.select().from(customRuntimes).where(eq(customRuntimes.id, id)).get()
    if (row === undefined) return null
    return toCustomRuntimeRecord(row)
  }

  findBySlug(slug: string): CustomRuntimeRecord | null {
    const row = this.db.select().from(customRuntimes).where(eq(customRuntimes.slug, slug)).get()
    if (row === undefined) return null
    return toCustomRuntimeRecord(row)
  }

  list(): readonly CustomRuntimeRecord[] {
    const rows = this.db.select().from(customRuntimes).all()
    return rows.map(toCustomRuntimeRecord)
  }

  create(input: CreateCustomRuntimeInput, actor: Actor, occurredAt: string): CustomRuntimeRecord {
    const id = input.id ?? crypto.randomUUID()
    const projectId = projectIdSchema.parse(crypto.randomUUID())

    const record: CustomRuntimeRecord = {
      id,
      slug: input.slug,
      name: input.name,
      command: input.command,
      argsTemplate: input.argsTemplate ?? null,
      capabilities: input.capabilities,
      permissionMode: input.permissionMode ?? 'developer',
      instructionFilenames: input.instructionFilenames ?? [],
      env: input.env ?? null,
      createdAt: occurredAt,
    }

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'custom_runtime.created',
          payload: {
            id: record.id,
            slug: record.slug,
            name: record.name,
            command: record.command,
            argsTemplate: record.argsTemplate,
            capabilities: record.capabilities,
            permissionMode: record.permissionMode,
            instructionFilenames: record.instructionFilenames,
            env: record.env,
            createdAt: record.createdAt,
          },
        },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(id)
    if (created === null) {
      throw new Error(`Custom runtime ${id} was not found after creation`)
    }
    return created
  }

  remove(id: string, actor: Actor, occurredAt: string): void {
    const existing = this.find(id)
    if (existing === null) {
      throw new Error(`Custom runtime ${id} not found`)
    }

    const projectId = projectIdSchema.parse(crypto.randomUUID())

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'custom_runtime.removed', payload: { id } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }
}

function toCustomRuntimeRecord(row: typeof customRuntimes.$inferSelect): CustomRuntimeRecord {
  const capabilities = parseJsonArray(row.capabilities) as readonly Capability[]
  const instructionFilenames = parseJsonArray(row.instructionFilenames)

  let env: Record<string, string> | null = null
  if (row.env) {
    try {
      env = JSON.parse(row.env) as Record<string, string>
    } catch {
      env = null
    }
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    command: row.command,
    argsTemplate: row.argsTemplate,
    capabilities,
    permissionMode: row.permissionMode,
    instructionFilenames,
    env,
    createdAt: row.createdAt,
  }
}

function parseJsonArray(raw: string): readonly string[] {
  try {
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}
