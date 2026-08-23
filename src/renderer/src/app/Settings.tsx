import { useEffect, useState } from 'react'
import type { AccountView, EffectiveRuleView } from '@shared/ipc'
import { unwrap } from '@renderer/ipc'
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  Field,
  Input,
  ScrollArea,
  Select,
  Separator,
  Textarea,
  useToast,
} from '../ui'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'

const SETTINGS = ROUTES[7]

/**
 * Settings — the effective policy, and where each rule came from.
 *
 * ```
 * global ──> workspace ──> project ──> workflow ──> agent ──> task
 *                  most-specific scope wins on conflict
 * ```
 *
 * Provenance is the point of this screen. A resolved rule alone would not tell the
 * user whether a value is inherited from Forge's defaults or overridden here, and an
 * override that looks identical to an original is how a global safety rule
 * disappears without anyone noticing.
 */
export function Settings(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const applyRule = useProjectStore((state) => state.applyRule)
  const removeRule = useProjectStore((state) => state.removeRule)
  const { show } = useToast()

  const [key, setKey] = useState('')
  const [scope, setScope] = useState('project')
  const [statement, setStatement] = useState('')
  const [saving, setSaving] = useState(false)

  // Account management state (#44)
  const [accounts, setAccounts] = useState<readonly AccountView[]>([])
  const [accountProvider, setAccountProvider] = useState('default')
  const [accountLabel, setAccountLabel] = useState('')
  const [registeringAccount, setRegisteringAccount] = useState(false)

  useEffect(() => {
    window.forge.account
      .list()
      .then((res) => {
        const data = unwrap(res)
        setAccounts(data.accounts)
      })
      .catch((err: unknown) => {
        console.error('Failed to load accounts:', err)
      })
  }, [])

  async function registerAccount(): Promise<void> {
    if (accountLabel.trim() === '') return
    setRegisteringAccount(true)
    try {
      const res = await window.forge.account.register({
        provider: accountProvider,
        label: accountLabel.trim(),
      })
      const created = unwrap(res)
      setAccounts((prev) => [...prev, created])
      setAccountLabel('')
      show({ tone: 'success', title: `Account "${created.label}" registered` })
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not register account',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setRegisteringAccount(false)
    }
  }

  async function removeAccount(accountId: string): Promise<void> {
    try {
      const res = await window.forge.account.remove(accountId)
      unwrap(res)
      setAccounts((prev) => prev.filter((a) => a.id !== accountId))
      show({ tone: 'success', title: 'Account removed' })
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not remove account',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    }
  }

  async function save(): Promise<void> {
    if (key.trim() === '' || statement.trim() === '') return

    setSaving(true)
    try {
      await applyRule(scope, key.trim(), statement.trim())
      show({ tone: 'success', title: `Rule ${key.trim()} set at ${scope} scope` })
      setKey('')
      setStatement('')
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not set the rule',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">
            {SETTINGS.label}
          </h1>
        </div>

        {detail === null ? (
          <div className="grid flex-1 place-content-center">
            <EmptyState title={SETTINGS.empty.title} description={SETTINGS.empty.description} />
          </div>
        ) : (
          <div className="grid gap-4 p-6">
            <Card tone="raised">
              <CardHeader>
                <div>
                  <CardTitle>Effective policy</CardTitle>
                  <CardDescription>
                    Every rule an agent in this project receives, after inheritance
                  </CardDescription>
                </div>
                <Badge tone="neutral" size="sm">
                  {detail.policy.length}
                </Badge>
              </CardHeader>

              <ul className="mt-3 grid list-none gap-2 p-0">
                {detail.policy.map((rule) => (
                  <PolicyRow
                    key={rule.key}
                    rule={rule}
                    onRemove={
                      // Only a stored rule can be removed. Forge's own defaults are
                      // code constants: a narrower scope may override one, but nothing
                      // deletes it.
                      detail.rules.find(
                        (stored) => stored.key === rule.key && stored.scope === rule.scope,
                      )?.id
                    }
                    remove={removeRule}
                  />
                ))}
              </ul>
            </Card>

            <Card tone="raised">
              <CardHeader>
                <div>
                  <CardTitle>Set a rule</CardTitle>
                  <CardDescription>
                    Reuse a key to override that concern at a narrower scope
                  </CardDescription>
                </div>
              </CardHeader>

              <div className="mt-3 grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Key" required hint="R4 to override a Forge default">
                    {(bind) => (
                      <Input
                        {...bind}
                        mono
                        value={key}
                        placeholder="R4"
                        onChange={(event) => {
                          setKey(event.target.value)
                        }}
                      />
                    )}
                  </Field>

                  <Field label="Scope" required>
                    {(bind) => (
                      <Select
                        {...bind}
                        // Only the scopes that exist today can be written: workflow,
                        // agent, and task rules are set by the thing they belong to,
                        // which does not exist yet.
                        options={[
                          { value: 'project', label: 'project' },
                          { value: 'workspace', label: 'workspace' },
                        ]}
                        value={scope}
                        onChange={(event) => {
                          setScope(event.target.value)
                        }}
                      />
                    )}
                  </Field>
                </div>

                <Field label="Statement" required>
                  {(bind) => (
                    <Textarea
                      {...bind}
                      rows={3}
                      value={statement}
                      placeholder="migrations may be modified in this project"
                      onChange={(event) => {
                        setStatement(event.target.value)
                      }}
                    />
                  )}
                </Field>

                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      void save()
                    }}
                    disabled={saving || key.trim() === '' || statement.trim() === ''}
                  >
                    {saving ? 'Saving…' : 'Set rule'}
                  </Button>
                </div>
              </div>
            </Card>

            {/* Multi-Account Registry (#44) */}
            <Card tone="raised">
              <CardHeader>
                <div>
                  <CardTitle>Provider Accounts</CardTitle>
                  <CardDescription>
                    Manage connected agent accounts across providers. Hot-swapping accounts
                    preserves full workflow state and history.
                  </CardDescription>
                </div>
                <Badge tone="accent" size="sm">
                  {accounts.length}
                </Badge>
              </CardHeader>

              <div className="mt-3 grid gap-3">
                {accounts.length === 0 ? (
                  <p className="m-0 text-xs text-neutral-400">
                    No external accounts registered yet.
                  </p>
                ) : (
                  <ul className="grid list-none gap-2 p-0">
                    {accounts.map((acc) => (
                      <li
                        key={acc.id}
                        className="flex items-center justify-between rounded-md bg-neutral-900/60 p-3 border border-neutral-800"
                      >
                        <div className="flex items-center gap-3">
                          <Badge tone="neutral" size="sm">
                            {acc.provider}
                          </Badge>
                          <div>
                            <p className="m-0 text-sm font-medium text-neutral-200">{acc.label}</p>
                            <p className="m-0 text-xs text-neutral-500">
                              Status:{' '}
                              <span
                                className={
                                  acc.status === 'connected'
                                    ? 'text-emerald-400'
                                    : acc.status === 'rate_limited'
                                      ? 'text-amber-400'
                                      : 'text-rose-400'
                                }
                              >
                                {acc.status}
                              </span>
                              {acc.lastUsedAt !== null &&
                                ` · Last used: ${new Date(acc.lastUsedAt).toLocaleTimeString()}`}
                            </p>
                          </div>
                        </div>

                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void removeAccount(acc.id)
                          }}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <Separator className="my-2" />

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Provider ID" required hint="e.g. cli-adapter, api-service">
                    {(bind) => (
                      <Input
                        {...bind}
                        value={accountProvider}
                        placeholder="provider-id"
                        onChange={(e) => {
                          setAccountProvider(e.target.value)
                        }}
                      />
                    )}
                  </Field>

                  <Field label="Account Label" required hint="e.g. Work Pro, Personal Max">
                    {(bind) => (
                      <Input
                        {...bind}
                        value={accountLabel}
                        placeholder="Work Pro (Tier 4)"
                        onChange={(e) => {
                          setAccountLabel(e.target.value)
                        }}
                      />
                    )}
                  </Field>
                </div>

                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      void registerAccount()
                    }}
                    disabled={registeringAccount || accountLabel.trim() === ''}
                  >
                    {registeringAccount ? 'Registering…' : 'Register Account'}
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function PolicyRow({
  rule,
  onRemove,
  remove,
}: {
  readonly rule: EffectiveRuleView
  readonly onRemove: string | undefined
  readonly remove: (ruleId: string) => Promise<void>
}): React.JSX.Element {
  const overridden = rule.shadowed.length > 0

  return (
    <li className="grid gap-1 rounded-(--radius-md) bg-(--color-surface-inset) p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Code>{rule.key}</Code>
        <Badge tone="neutral" size="sm">
          {rule.scope}
        </Badge>
        {overridden ? (
          <Badge tone="warning" size="sm">
            overrides {rule.shadowed.length}
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            inherited
          </Badge>
        )}
        <span className="ml-auto text-(length:--text-xs) text-(--color-text-muted)">
          {rule.source}
        </span>
        {onRemove !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void remove(onRemove)
            }}
          >
            Remove
          </Button>
        )}
      </div>

      <p className="m-0 text-(length:--text-xs) text-(--color-text)">{rule.statement}</p>

      {overridden && (
        <>
          <Separator className="my-1" />
          <div className="grid gap-1">
            {rule.shadowed.map((shadowed) => (
              <p
                key={`${shadowed.scope}-${shadowed.source}`}
                className="m-0 text-(length:--text-xs) text-(--color-text-muted) line-through"
              >
                <Badge tone="neutral" size="sm">
                  {shadowed.scope}
                </Badge>{' '}
                {shadowed.statement}
              </p>
            ))}
          </div>
        </>
      )}
    </li>
  )
}
