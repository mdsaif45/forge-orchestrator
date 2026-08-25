import { useState } from 'react'
import type { RepositoryProbe } from '@shared/ipc'
import { Button, Code, Field, Input, Select } from '../ui'

export interface DefaultBranchFieldProps {
  readonly probe: RepositoryProbe | null
  readonly value: string
  readonly onChange: (branch: string) => void
}

/**
 * Why each source reads the way it does.
 *
 * `origin/HEAD` is the remote stating its own default, so it is presented as something
 * Forge found rather than something to confirm. The other two are inferences that
 * happened to match, and saying so is the difference between a fact and a guess wearing
 * a fact's clothes (#140).
 */
const SOURCE_LABEL: Record<NonNullable<RepositoryProbe['defaultBranchSource']>, string> = {
  'origin-head': 'from origin/HEAD',
  config: 'from init.defaultBranch',
  convention: 'by convention — no remote said so',
}

/**
 * The default branch: stated when git answered authoritatively, asked when it did not.
 *
 * ```
 * origin/HEAD          -> fact + "Change"     nothing for the user to decide
 * config | convention  -> the field, prefilled  an inference worth confirming
 * undetected           -> the field, empty      the A2 case; must stay a question
 * ```
 *
 * Shared by both project dialogs deliberately: the create and edit forms drifting apart
 * on which of these cases they handle is how #100 stayed invisible in one of them.
 */
export function DefaultBranchField({
  probe,
  value,
  onChange,
}: DefaultBranchFieldProps): React.JSX.Element {
  const [overridden, setOverridden] = useState(false)

  const source = probe?.isRepository === true ? probe.defaultBranchSource : null
  const detected = probe?.isRepository === true ? probe.defaultBranch : null

  // Only `origin/HEAD` is authoritative enough to state rather than ask. A `main` that
  // merely exists is not evidence that it is the merge target.
  const authoritative = source === 'origin-head' && detected !== null && detected === value

  if (authoritative && !overridden) {
    return (
      <Field label="Default branch" hint="The merge target changes are measured against">
        {() => (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] px-3 py-2">
            <span className="flex items-baseline gap-2">
              <Code>{detected}</Code>
              <span className="text-xs text-[var(--color-text-muted)]">
                {SOURCE_LABEL['origin-head']}
              </span>
            </span>
            {/* Not a required field any more, but still changeable: a repository can
                have a merge target that differs from what origin/HEAD points at. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOverridden(true)
              }}
            >
              Change
            </Button>
          </div>
        )}
      </Field>
    )
  }

  return (
    <Field
      label="Default branch"
      // Required only while it is genuinely a question. A detected authoritative value
      // is not one, and marking it required would ask the user to affirm what git said.
      required
      hint={
        source !== null && detected !== null
          ? `Detected ${detected} ${SOURCE_LABEL[source]}`
          : 'The merge target changes are measured against'
      }
    >
      {(bind) =>
        probe?.isRepository === true && probe.branches.length > 0 ? (
          <Select
            {...bind}
            // Every branch, not just the checkout: the default branch is frequently not
            // the one currently checked out, and offering a single option made the
            // correct answer unselectable (#100).
            options={probe.branches.map((name) => ({ value: name, label: name }))}
            value={value}
            onChange={(event) => {
              onChange(event.target.value)
            }}
          />
        ) : (
          <Input
            {...bind}
            mono
            value={value}
            placeholder="main"
            onChange={(event) => {
              onChange(event.target.value)
            }}
          />
        )
      }
    </Field>
  )
}
