import { randomUUID } from 'node:crypto'
import {
  accountIdSchema,
  accountStatusSchema,
  type Account,
  type AccountStatus,
} from '@shared/domain'
import type { AccountView } from '@shared/ipc'
import type { AccountStore } from '../db/accountStore'

export class AccountService {
  constructor(private readonly accounts: AccountStore) {}

  list(provider?: string): readonly AccountView[] {
    const list = this.accounts.list(provider)
    return list.map((a) => this.toView(a))
  }

  register(input: { readonly provider: string; readonly label: string }): AccountView {
    const aId = accountIdSchema.parse(randomUUID())
    const now = new Date().toISOString()

    const account: Account = {
      id: aId,
      provider: input.provider,
      label: input.label,
      status: 'connected',
      lastUsedAt: null,
      createdAt: now,
    }

    const created = this.accounts.register(account, 'user', now)
    return this.toView(created)
  }

  updateStatus(input: { readonly accountId: string; readonly status: AccountStatus }): AccountView {
    const aId = accountIdSchema.parse(input.accountId)
    const status = accountStatusSchema.parse(input.status)
    const now = new Date().toISOString()

    const updated = this.accounts.updateStatus(aId, status, 'user', now)
    return this.toView(updated)
  }

  remove(accountId: string): void {
    const aId = accountIdSchema.parse(accountId)
    const now = new Date().toISOString()
    this.accounts.remove(aId, 'user', now)
  }

  private toView(account: Account): AccountView {
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      status: account.status,
      lastUsedAt: account.lastUsedAt,
      createdAt: account.createdAt,
    }
  }
}
