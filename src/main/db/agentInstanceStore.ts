import { eq } from 'drizzle-orm'
import {
  agentInstanceSchema,
  generateAgentName,
  type Actor,
  type AgentInstance,
  type AgentInstanceId,
  type ProjectId,
  type Role,
  type AccountId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { parseRow } from './rows'
import { agentInstances } from './schema'

/**
 * Persists and manages agent instances (#138).
 *
 * An agent instance is a first-class identity in Forge:
 * - Stable UUID identity
 * - Unique generated name within the project (e.g. "NobleFalcon")
 * - Editable display label
 * - Bound provider, optional account, and role
 */
export class AgentInstanceStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(id: AgentInstanceId): AgentInstance | null {
    const row = this.db.select().from(agentInstances).where(eq(agentInstances.id, id)).get()
    if (row === undefined) return null
    return toAgentInstance(row)
  }

  list(projectId: ProjectId): readonly AgentInstance[] {
    const rows = this.db
      .select()
      .from(agentInstances)
      .where(eq(agentInstances.projectId, projectId))
      .all()
    return rows.map(toAgentInstance)
  }

  create(
    input: {
      readonly id?: AgentInstanceId | undefined
      readonly projectId: ProjectId
      readonly label?: string | undefined
      readonly provider: string
      readonly accountId?: AccountId | null | undefined
      readonly role: Role
    },
    actor: Actor,
    occurredAt: string,
  ): AgentInstance {
    const existing = this.list(input.projectId)
    const existingNames = existing.map((a) => a.name)
    const name = generateAgentName(existingNames)
    const label = input.label && input.label.trim().length > 0 ? input.label.trim() : name

    const id = (input.id ?? crypto.randomUUID()) as AgentInstanceId

    const instance: AgentInstance = agentInstanceSchema.parse({
      id,
      projectId: input.projectId,
      name,
      label,
      provider: input.provider,
      accountId: input.accountId ?? null,
      role: input.role,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'agent_instance.created', payload: { agentInstance: instance } },
        { projectId: input.projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(id)
    if (created === null) {
      throw new Error(`Agent instance ${id} was not found after creation`)
    }
    return created
  }

  updateLabel(id: AgentInstanceId, label: string, actor: Actor, occurredAt: string): AgentInstance {
    const existing = this.find(id)
    if (existing === null) {
      throw new Error(`Agent instance ${id} not found`)
    }

    const trimmed = label.trim()
    if (trimmed.length === 0) {
      throw new Error('Agent instance label cannot be empty')
    }

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'agent_instance.updated',
          payload: {
            id,
            label: trimmed,
            updatedAt: occurredAt,
          },
        },
        { projectId: existing.projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const updated = this.find(id)
    if (updated === null) {
      throw new Error(`Agent instance ${id} was not found after update`)
    }
    return updated
  }

  remove(id: AgentInstanceId, actor: Actor, occurredAt: string): void {
    const existing = this.find(id)
    if (existing === null) {
      throw new Error(`Agent instance ${id} not found`)
    }

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'agent_instance.removed', payload: { id } },
        { projectId: existing.projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }
}

function toAgentInstance(row: typeof agentInstances.$inferSelect): AgentInstance {
  return parseRow(
    agentInstanceSchema,
    {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      label: row.label,
      provider: row.provider,
      accountId: row.accountId,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    'agent_instances',
  )
}
