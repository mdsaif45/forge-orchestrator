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
  TabPanel,
  Tabs,
  Textarea,
  useToast,
} from '../ui'
import { AccountEnrollment } from './AccountEnrollment'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'

/**
 * Found by path, not by position.
 *
 * This was `ROUTES[7]`, which broke silently the moment a route was removed from the
 * table (#102) — it pointed at nothing and every read of it became undefined.
 */
const SETTINGS = ((): (typeof ROUTES)[number] => {
  const route = ROUTES.find((candidate) => candidate.path === '/settings')
  if (route === undefined) throw new Error('The settings route is missing from ROUTES')
  return route
})()

type SettingsTab = 'rules' | 'accounts' | 'limits' | 'security' | 'storage'

/**
 * Settings — the effective policy, provenance, accounts, limits, and security configuration.
 *
 * ```
 * global ──> workspace ──> project ──> workflow ──> agent ──> task
 *                  most-specific scope wins on conflict
 * ```
 *
 * Provenance is always visible: every field indicates its effective value and the
 * exact scope that defined it (Axiom A1, A4, A7).
 */
export function Settings(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const applyRule = useProjectStore((state) => state.applyRule)
  const removeRule = useProjectStore((state) => state.removeRule)
  const { show } = useToast()

  const [activeTab, setActiveTab] = useState<SettingsTab>('rules')

  // Rule override state
  const [key, setKey] = useState('')
  const [scope, setScope] = useState('project')
  const [statement, setStatement] = useState('')
  const [saving, setSaving] = useState(false)

  // Account management state (#44)
  const [accounts, setAccounts] = useState<readonly AccountView[]>([])
  const [accountProvider, setAccountProvider] = useState('default')
  const [accountLabel, setAccountLabel] = useState('')
  const [registeringAccount, setRegisteringAccount] = useState(false)

  // Runtime limits state (Project overrides)
  const [maxIterations, setMaxIterations] = useState('10')
  const [stepTimeoutMs, setStepTimeoutMs] = useState('300000')
  const [idleTimeoutMs, setIdleTimeoutMs] = useState('60000')

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

  const [runtimes, setRuntimes] = useState<readonly { id: string; simulated: boolean }[]>([])

  // The registered runtimes, so an account is bound to a CLI that actually exists.
  useEffect(() => {
    window.forge.runtime
      .list()
      .then((res) => {
        const list = unwrap(res).runtimes
        setRuntimes(list.map((r) => ({ id: r.id, simulated: r.simulated })))
        setAccountProvider((current) => (current === '' ? (list[0]?.id ?? '') : current))
      })
      .catch((err: unknown) => {
        console.error('Failed to load runtimes:', err)
      })
  }, [])

  async function registerAccount(): Promise<void> {
    if (accountLabel.trim() === '') return
    setRegisteringAccount(true)
    try {
      const res = await window.forge.account.register({
        provider: accountProvider.trim() || 'default',
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

  async function saveRule(): Promise<void> {
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
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">
                {SETTINGS.label}
              </h1>
              <p className="text-(length:--text-xs) text-(--color-text-muted)">
                Provenance & Configuration: Global ➔ Workspace ➔ Project ➔ Workflow ➔ Agent ➔ Task
              </p>
            </div>
            {detail !== null && (
              <Badge tone="neutral" size="sm">
                Project: {detail.project.name}
              </Badge>
            )}
          </div>

          <Tabs
            aria-label="Settings Categories"
            className="mt-4"
            value={activeTab}
            onChange={(val) => {
              setActiveTab(val)
            }}
            items={[
              {
                value: 'rules',
                label: 'Rules & Policy',
                adornment: detail ? (
                  <Badge tone="neutral" size="sm">
                    {detail.policy.length}
                  </Badge>
                ) : undefined,
              },
              {
                value: 'accounts',
                label: 'Agent Accounts',
                adornment: (
                  <Badge tone="neutral" size="sm">
                    {accounts.length}
                  </Badge>
                ),
              },
              { value: 'limits', label: 'Runtime & Limits' },
              { value: 'security', label: 'Security & Scope' },
              { value: 'storage', label: 'Storage & Diagnostics' },
            ]}
          />
        </div>

        {detail === null ? (
          <div className="grid flex-1 place-content-center">
            <EmptyState title={SETTINGS.empty.title} description={SETTINGS.empty.description} />
          </div>
        ) : (
          <div className="p-6">
            {/* TAB 1: Rules & Policy */}
            <TabPanel active={activeTab === 'rules'}>
              <div className="grid gap-4">
                <Card tone="raised">
                  <CardHeader>
                    <div>
                      <CardTitle>Effective policy & Scope Provenance</CardTitle>
                      <CardDescription>
                        Every resolved rule an agent receives. Inherited defaults are traceable to
                        their origin scope.
                      </CardDescription>
                    </div>
                    <Badge tone="neutral" size="sm">
                      {detail.policy.length} active
                    </Badge>
                  </CardHeader>

                  <ul className="mt-3 grid list-none gap-2 p-0">
                    {detail.policy.map((rule) => (
                      <PolicyRow
                        key={rule.key}
                        rule={rule}
                        onRemove={
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
                      <CardTitle>Set a Rule Override</CardTitle>
                      <CardDescription>
                        Reuse a key (e.g. R4, R7) to override safety or operational rules at project
                        or workspace scope.
                      </CardDescription>
                    </div>
                  </CardHeader>

                  <div className="mt-3 grid gap-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Key" required hint="e.g. R4 to override a Forge default">
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
                          void saveRule()
                        }}
                        disabled={saving || key.trim() === '' || statement.trim() === ''}
                      >
                        {saving ? 'Saving…' : 'Set rule'}
                      </Button>
                    </div>
                  </div>
                </Card>
              </div>
            </TabPanel>

            {/* TAB 2: Agent Accounts */}
            <TabPanel active={activeTab === 'accounts'}>
              <Card tone="raised">
                <CardHeader>
                  <div>
                    <CardTitle>Provider Accounts Registry</CardTitle>
                    <CardDescription>
                      Manage agent execution credentials and runtime accounts. Hot-swapping accounts
                      mid-workflow never loses project state or decisions.
                    </CardDescription>
                  </div>
                  <Badge tone="accent" size="sm">
                    {accounts.length}
                  </Badge>
                </CardHeader>

                <div className="mt-3 grid gap-3">
                  {accounts.length === 0 ? (
                    <p className="m-0 text-(length:--text-xs) text-(--color-text-muted)">
                      No provider accounts registered yet.
                    </p>
                  ) : (
                    <ul className="grid list-none gap-2 p-0">
                      {accounts.map((acc) => (
                        <li
                          key={acc.id}
                          className="flex items-center justify-between rounded-(--radius-md) bg-(--color-surface-inset) p-3 border border-(--color-border)"
                        >
                          <div className="flex items-center gap-3">
                            <Badge tone="neutral" size="sm">
                              {acc.provider}
                            </Badge>
                            <div>
                              <p className="m-0 text-(length:--text-sm) font-medium text-(--color-text)">
                                {acc.label}
                              </p>
                              <p className="m-0 text-(length:--text-xs) text-(--color-text-muted)">
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

                          <div className="flex items-center gap-2">
                            <AccountEnrollment accountId={acc.id} runtimeId={acc.provider} />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                void removeAccount(acc.id)
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <Separator className="my-2" />

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Provider" required hint="Which CLI this account signs into">
                      {(bind) =>
                        // A registered runtime, not free text: an account exists to be
                        // signed into a specific CLI, and a typed value that matches no
                        // runtime could never be enrolled.
                        runtimes.length > 0 ? (
                          <Select
                            {...bind}
                            options={runtimes.map((runtime) => ({
                              value: runtime.id,
                              label: runtime.simulated ? `${runtime.id} (simulated)` : runtime.id,
                            }))}
                            value={accountProvider}
                            onChange={(e) => {
                              setAccountProvider(e.target.value)
                            }}
                          />
                        ) : (
                          <Input
                            {...bind}
                            value={accountProvider}
                            placeholder="provider-id"
                            onChange={(e) => {
                              setAccountProvider(e.target.value)
                            }}
                          />
                        )
                      }
                    </Field>

                    <Field label="Account Label" required hint="e.g. Work Pro, Primary Team">
                      {(bind) => (
                        <Input
                          {...bind}
                          value={accountLabel}
                          placeholder="Primary Account"
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
            </TabPanel>

            {/* TAB 3: Runtime & Limits */}
            <TabPanel active={activeTab === 'limits'}>
              <Card tone="raised">
                <CardHeader>
                  <div>
                    <CardTitle>Runtime & Loop Circuit Breakers</CardTitle>
                    <CardDescription>
                      Control workflow timeouts and iteration ceilings to prevent runaway agent
                      loops (Axiom A5).
                    </CardDescription>
                  </div>
                  <Badge tone="neutral" size="sm">
                    Axiom A5
                  </Badge>
                </CardHeader>

                <div className="mt-3 grid gap-4">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Max Iterations" required hint="Inherited from Forge Default: 10">
                      {(bind) => (
                        <Input
                          {...bind}
                          type="number"
                          value={maxIterations}
                          onChange={(e) => {
                            setMaxIterations(e.target.value)
                          }}
                        />
                      )}
                    </Field>

                    <Field
                      label="Step Timeout (ms)"
                      required
                      hint="Inherited from Forge Default: 300,000"
                    >
                      {(bind) => (
                        <Input
                          {...bind}
                          type="number"
                          value={stepTimeoutMs}
                          onChange={(e) => {
                            setStepTimeoutMs(e.target.value)
                          }}
                        />
                      )}
                    </Field>

                    <Field
                      label="Idle Timeout (ms)"
                      required
                      hint="Inherited from Forge Default: 60,000"
                    >
                      {(bind) => (
                        <Input
                          {...bind}
                          type="number"
                          value={idleTimeoutMs}
                          onChange={(e) => {
                            setIdleTimeoutMs(e.target.value)
                          }}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs) text-(--color-text-muted)">
                    <p className="m-0 font-medium text-(--color-text)">Circuit Breaker Policy:</p>
                    <ul className="m-0 mt-1 list-disc pl-4">
                      <li>Halt with HALTED_LIMIT when iteration ceiling is reached.</li>
                      <li>Halt with HALTED_POLICY on permission or command violations.</li>
                      <li>
                        Write-ahead checkpoints before every side-effect ensure clean crash
                        recovery.
                      </li>
                    </ul>
                  </div>
                </div>
              </Card>
            </TabPanel>

            {/* TAB 4: Security & Scope */}
            <TabPanel active={activeTab === 'security'}>
              <Card tone="raised">
                <CardHeader>
                  <div>
                    <CardTitle>Security & Redaction Engine</CardTitle>
                    <CardDescription>
                      Proactive command filtering, forbidden path enforcement, and secret masking
                      rules (Axiom A7).
                    </CardDescription>
                  </div>
                  <Badge tone="warning" size="sm">
                    Least Privilege
                  </Badge>
                </CardHeader>

                <div className="mt-3 grid gap-3">
                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
                    <p className="m-0 font-medium text-(--color-text)">
                      Forbidden Paths & Secrets Masking:
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge tone="danger" size="sm">
                        .env*
                      </Badge>
                      <Badge tone="danger" size="sm">
                        *.pem
                      </Badge>
                      <Badge tone="danger" size="sm">
                        *.key
                      </Badge>
                      <Badge tone="danger" size="sm">
                        id_rsa*
                      </Badge>
                      <Badge tone="danger" size="sm">
                        .git/*
                      </Badge>
                      <Badge tone="danger" size="sm">
                        node_modules/*
                      </Badge>
                    </div>
                  </div>

                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
                    <p className="m-0 font-medium text-(--color-text)">Dangerous Command Policy:</p>
                    <p className="m-0 mt-1 text-(--color-text-muted)">
                      Commands matching destructive patterns (e.g. rm -rf /, git push --force, dd,
                      mkfs) are blocked immediately and trigger a HALTED_POLICY transition with an
                      immutable audit trail.
                    </p>
                  </div>
                </div>
              </Card>
            </TabPanel>

            {/* TAB 5: Storage & Diagnostics */}
            <TabPanel active={activeTab === 'storage'}>
              <Card tone="raised">
                <CardHeader>
                  <div>
                    <CardTitle>Storage & Diagnostics</CardTitle>
                    <CardDescription>
                      Database persistence path, event log storage, and prompt cache maintenance.
                    </CardDescription>
                  </div>
                </CardHeader>

                <div className="mt-3 grid gap-3">
                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
                    <p className="m-0 text-(--color-text-muted)">Repository Path:</p>
                    <Code className="mt-1 block">{detail.project.repository.absolutePath}</Code>
                  </div>

                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
                    <p className="m-0 text-(--color-text-muted)">Database Storage:</p>
                    <Code className="mt-1 block">SQLite WAL (UserData / forge.db)</Code>
                  </div>

                  <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
                    <p className="m-0 text-(--color-text-muted)">Event Log Retention:</p>
                    <p className="m-0 mt-1 text-(--color-text)">
                      Append-only, permanent audit history for all workflows and decisions.
                    </p>
                  </div>
                </div>
              </Card>
            </TabPanel>
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
