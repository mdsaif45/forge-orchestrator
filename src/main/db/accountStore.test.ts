import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountIdSchema, type Account } from '@shared/domain'
import { AccountStore } from './accountStore'
import { initialiseDatabase, type ForgeDatabase } from './index'
import { EventStore } from './eventStore'

describe('AccountStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let accounts: AccountStore

  beforeEach(() => {
    const handle = initialiseDatabase(':memory:')
    db = handle.db
    close = handle.close

    events = new EventStore(db)
    accounts = new AccountStore(db, events)
  })

  afterEach(() => {
    close()
  })

  it('registers and retrieves an account', () => {
    const aId = accountIdSchema.parse(randomUUID())
    const account: Account = {
      id: aId,
      provider: 'claude',
      label: 'Work Pro Account',
      status: 'connected',
      lastUsedAt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
    }

    const created = accounts.register(account, 'user', '2026-08-24T00:00:00.000Z')
    expect(created).toEqual(account)

    const found = accounts.find(aId)
    expect(found).toEqual(account)

    const list = accounts.list('claude')
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe('Work Pro Account')
  })

  it('updates account status and last used time', () => {
    const aId = accountIdSchema.parse(randomUUID())
    const account: Account = {
      id: aId,
      provider: 'antigravity',
      label: 'Team AGY',
      status: 'connected',
      lastUsedAt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
    }
    accounts.register(account, 'user', '2026-08-24T00:00:00.000Z')

    const updated = accounts.updateStatus(
      aId,
      'rate_limited',
      'system',
      '2026-08-24T01:00:00.000Z',
      '2026-08-24T01:00:00.000Z',
    )
    expect(updated.status).toBe('rate_limited')
    expect(updated.lastUsedAt).toBe('2026-08-24T01:00:00.000Z')
  })

  it('removes an account cleanly', () => {
    const aId = accountIdSchema.parse(randomUUID())
    const account: Account = {
      id: aId,
      provider: 'openai',
      label: 'Codex Tier 5',
      status: 'connected',
      lastUsedAt: null,
      createdAt: '2026-08-24T00:00:00.000Z',
    }
    accounts.register(account, 'user', '2026-08-24T00:00:00.000Z')
    expect(accounts.list()).toHaveLength(1)

    accounts.remove(aId, 'user', '2026-08-24T02:00:00.000Z')
    expect(accounts.find(aId)).toBeNull()
    expect(accounts.list()).toHaveLength(0)
  })
})
