import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  agentBindingSchema,
  capabilitySchema,
  permissionsSchema,
  type AgentBinding,
  type Actor,
  type ProjectId,
  type Role,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { fromJson } from './rows'
import { agentBindings } from './schema'

/**
 * Which runtime holds which role, per project (#31, #102).
 *
 * The indirection is what makes A6 real rather than decorative: a template names a
 * role, a binding names a runtime, and swapping which runtime plans and which
 * implements is a data change. Until this existed, `resolveBindings` hardcoded every
 * role to the same runtime, so the seam was present in the types and absent in
 * practice.
 */
export class BindingStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  list(projectId: ProjectId): readonly AgentBinding[] {
    const rows = this.db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.projectId, projectId))
      .all()

    return rows.map(toBinding)
  }

  find(projectId: ProjectId, role: Role): AgentBinding | null {
    const row = this.db
      .select()
      .from(agentBindings)
      .where(and(eq(agentBindings.projectId, projectId), eq(agentBindings.role, role)))
      .get()

    return row === undefined ? null : toBinding(row)
  }

  set(projectId: ProjectId, binding: AgentBinding, actor: Actor, occurredAt: string): AgentBinding {
    agentBindingSchema.parse(binding)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'binding.set', payload: { binding } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const stored = this.find(projectId, binding.role)
    if (stored === null) {
      throw new Error(`Binding for role ${binding.role} was not found after being set`)
    }

    return stored
  }
}

/**
 * Parsed back through the schema rather than cast.
 *
 * `capabilities` and `permissions` are JSON columns, so a row that predates a schema
 * change would otherwise flow into the domain as the wrong shape and fail somewhere
 * far from the cause.
 */
function toBinding(row: typeof agentBindings.$inferSelect): AgentBinding {
  return agentBindingSchema.parse({
    id: row.id,
    role: row.role,
    runtimeId: row.runtimeId,
    accountId: row.accountId,
    capabilities: fromJson(
      z.array(capabilitySchema),
      row.capabilities,
      'agent_bindings.capabilities',
    ),
    permissions: fromJson(permissionsSchema, row.permissions, 'agent_bindings.permissions'),
  })
}
