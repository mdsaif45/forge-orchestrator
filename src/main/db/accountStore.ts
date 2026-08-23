import { eq } from 'drizzle-orm'
import {
  accountSchema,
  projectIdSchema,
  type Account,
  type AccountId,
  type AccountStatus,
  type Actor,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { parseRow } from './rows'
import { accounts } from './schema'

/**
 * Persists and manages provider accounts (#44).
 *
 * Switching accounts changes only runtime credentials or active sessions, and never
 * mutates project state, decisions, or workflow history.
 */
export class AccountStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(id: AccountId): Account | null {
    const row = this.db.select().from(accounts).where(eq(accounts.id, id)).get()
    if (row === undefined) return null
    return toAccount(row)
  }

  list(provider?: string): readonly Account[] {
    const query =
      provider !== undefined
        ? this.db.select().from(accounts).where(eq(accounts.provider, provider))
        : this.db.select().from(accounts)

    const rows = query.all()
    return rows.map(toAccount)
  }

  register(account: Account, actor: Actor, occurredAt: string): Account {
    accountSchema.parse(account)

    const projectId = projectIdSchema.parse(account.id)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'account.registered', payload: { account } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(account.id)
    if (created === null) {
      throw new Error(`Account ${account.id} was not found after registration`)
    }
    return created
  }

  updateStatus(
    accountId: AccountId,
    status: AccountStatus,
    actor: Actor,
    occurredAt: string,
    lastUsedAt?: string | null,
  ): Account {
    const existing = this.find(accountId)
    if (existing === null) {
      throw new Error(`Account ${accountId} not found`)
    }

    const projectId = projectIdSchema.parse(accountId)

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'account.status_updated',
          payload: {
            accountId,
            status,
            lastUsedAt: lastUsedAt ?? undefined,
          },
        },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const updated = this.find(accountId)
    if (updated === null) {
      throw new Error(`Account ${accountId} was not found after status update`)
    }
    return updated
  }

  remove(accountId: AccountId, actor: Actor, occurredAt: string): void {
    const existing = this.find(accountId)
    if (existing === null) {
      throw new Error(`Account ${accountId} not found`)
    }

    const projectId = projectIdSchema.parse(accountId)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'account.removed', payload: { accountId } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return parseRow(
    accountSchema,
    {
      id: row.id,
      provider: row.provider,
      label: row.label,
      status: row.status,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    },
    'accounts',
  )
}
