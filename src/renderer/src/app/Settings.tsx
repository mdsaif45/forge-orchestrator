import { useState } from 'react'
import type { EffectiveRuleView } from '@shared/ipc'
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
