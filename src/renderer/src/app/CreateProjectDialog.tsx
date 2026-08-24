import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepositoryProbe } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Badge,
  Button,
  Code,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  StatusDot,
  Textarea,
  useToast,
} from '../ui'
import { useProjectStore } from './projectStore'

/**
 * Create a project and bind it to a repository.
 *
 * Built entirely from `@renderer/ui` primitives — no one-off controls — so the form
 * inherits the design system's focus, invalid, and disabled states rather than
 * restating them.
 *
 * The probe drives everything the user is told. A blocker disables Create with the
 * specific reason attached to the path field; a warning (dirty worktree, no commits,
 * detached HEAD) is shown but does not block, because binding a repository with work
 * in progress is normal and the refusal that matters happens when a workflow
 * captures its base SHA.
 */

/** Reasons a folder cannot be bound at all, as opposed to reasons worth knowing. */
const BLOCKING_CODES = new Set([
  'empty-path',
  'not-absolute',
  'missing',
  'not-a-directory',
  'not-a-repository',
  'inside-repository',
])

export interface CreateProjectDialogProps {
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * Remounts the form each time the dialog opens.
 *
 * Resetting eight fields by hand in an effect would fire a cascade of setState
 * calls on close; a changing `key` discards the state instead, which is React's own
 * mechanism for "this is a fresh instance".
 */
export function CreateProjectDialog({
  open,
  onClose,
}: CreateProjectDialogProps): React.JSX.Element {
  const [generation, setGeneration] = useState(0)

  return (
    <CreateProjectForm
      key={generation}
      open={open}
      onClose={() => {
        setGeneration((current) => current + 1)
        onClose()
      }}
    />
  )
}

function CreateProjectForm({ open, onClose }: CreateProjectDialogProps): React.JSX.Element {
  const createProject = useProjectStore((state) => state.createProject)
  const { show } = useToast()

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [branch, setBranch] = useState('')
  const [buildCommand, setBuildCommand] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [tech, setTech] = useState('')
  const [rules, setRules] = useState('')

  const [probe, setProbe] = useState<RepositoryProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  /**
   * Tracks the most recent probe, so a slow reply for an earlier path cannot
   * overwrite the result for what the user has since typed.
   */
  const probeToken = useRef(0)

  const runProbe = useCallback(async (candidate: string) => {
    const token = probeToken.current + 1
    probeToken.current = token

    if (candidate.trim() === '') {
      setProbe(null)
      setProbing(false)
      return
    }

    setProbing(true)

    try {
      const result = await window.forge.project.probeRepository(candidate).then(unwrap)
      if (probeToken.current !== token) return

      setProbe(result)

      // The repository's *default* branch, not whatever is checked out right now.
      // Those differ whenever the user is mid-feature, and taking the checkout was
      // the #100 defect: the value ends up as the diff base for every later scope
      // verdict. Left empty when git cannot determine one, so the user chooses
      // rather than inheriting a guess (A2).
      if (result.isRepository && result.defaultBranch !== null) {
        setBranch((current) => (current === '' ? (result.defaultBranch ?? '') : current))
      }
    } catch (cause) {
      if (probeToken.current !== token) return
      setProbe(null)
      setSubmitError(cause instanceof Error ? cause.message : 'Could not read that folder')
    } finally {
      if (probeToken.current === token) setProbing(false)
    }
  }, [])

  // Debounced so typing a path does not spawn a git process per keystroke.
  useEffect(() => {
    if (!open) return

    const timer = setTimeout(() => {
      void runProbe(path)
    }, 300)

    return () => {
      clearTimeout(timer)
    }
  }, [open, path, runProbe])

  const blocker = probe?.problems.find((problem) => BLOCKING_CODES.has(problem.code)) ?? null
  const warnings = probe?.problems.filter((problem) => !BLOCKING_CODES.has(problem.code)) ?? []

  const nameValid = name.trim() !== ''
  const branchValid = branch.trim() !== ''
  const repositoryValid = probe?.isRepository === true && blocker === null
  const canSubmit = nameValid && branchValid && repositoryValid && !probing && !submitting

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      const created = await createProject({
        name: name.trim(),
        repositoryPath: path.trim(),
        defaultBranch: branch.trim(),
        buildCommand: buildCommand.trim() === '' ? null : buildCommand.trim(),
        testCommand: testCommand.trim() === '' ? null : testCommand.trim(),
        tech: splitList(tech),
        rules: splitLines(rules),
      })

      show({ tone: 'success', title: `${created.name} created` })
      onClose()
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Could not create the project')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="Forge keeps the project state. Agents only do the work."
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {submitError !== null && <Badge tone="danger">{submitError}</Badge>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void handleSubmit()
              }}
              disabled={!canSubmit}
            >
              {submitting ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field
          label="Name"
          required
          {...(name !== '' && !nameValid ? { error: 'Enter a name' } : {})}
        >
          {(bind) => (
            <Input
              {...bind}
              value={name}
              placeholder="my-service"
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          )}
        </Field>

        <Field
          label="Repository"
          required
          hint="The repository root — the folder containing .git"
          {...(blocker === null ? {} : { error: blocker.detail })}
        >
          {(bind) => (
            <div className="flex gap-2">
              <Input
                {...bind}
                mono
                value={path}
                placeholder="D:/code/my-service"
                onChange={(event) => {
                  setPath(event.target.value)
                }}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  void (async () => {
                    const picked = await window.forge.dialog.pickDirectory().then(unwrap)
                    if (picked.path !== null) setPath(picked.path)
                  })()
                }}
              >
                Browse…
              </Button>
            </div>
          )}
        </Field>

        <RepositoryStatus probing={probing} probe={probe} warnings={warnings} />

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Default branch"
            required
            hint="The merge target changes are measured against"
          >
            {(bind) =>
              probe?.isRepository === true && probe.branches.length > 0 ? (
                <Select
                  {...bind}
                  // Every branch, not just the checkout: the default branch is
                  // frequently not the one currently checked out, and offering a
                  // single option made the correct answer unselectable (#100).
                  options={probe.branches.map((name) => ({ value: name, label: name }))}
                  value={branch}
                  onChange={(event) => {
                    setBranch(event.target.value)
                  }}
                />
              ) : (
                <Input
                  {...bind}
                  mono
                  value={branch}
                  placeholder="main"
                  onChange={(event) => {
                    setBranch(event.target.value)
                  }}
                />
              )
            }
          </Field>

          <Field label="Technology" hint="Comma separated">
            {(bind) => (
              <Input
                {...bind}
                value={tech}
                placeholder=".NET 9, React"
                onChange={(event) => {
                  setTech(event.target.value)
                }}
              />
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Build command" hint="Forge runs this to produce evidence">
            {(bind) => (
              <Input
                {...bind}
                mono
                value={buildCommand}
                placeholder="dotnet build"
                onChange={(event) => {
                  setBuildCommand(event.target.value)
                }}
              />
            )}
          </Field>

          <Field label="Test command" hint="Not guessed — an agent's claim is checked against it">
            {(bind) => (
              <Input
                {...bind}
                mono
                value={testCommand}
                placeholder="dotnet test"
                onChange={(event) => {
                  setTestCommand(event.target.value)
                }}
              />
            )}
          </Field>
        </div>

        <Field label="Rules" hint="One per line. Applied to every workflow in this project.">
          {(bind) => (
            <Textarea
              {...bind}
              rows={4}
              value={rules}
              placeholder={
                'never modify migrations without approval\nfollow the existing architecture'
              }
              onChange={(event) => {
                setRules(event.target.value)
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  )
}

/** What the probe found, once a path has been entered. */
function RepositoryStatus({
  probing,
  probe,
  warnings,
}: {
  readonly probing: boolean
  readonly probe: RepositoryProbe | null
  readonly warnings: readonly { readonly code: string; readonly detail: string }[]
}): React.JSX.Element | null {
  if (probing) return <Spinner label="Reading repository" />
  if (probe?.isRepository !== true) return null

  return (
    <div className="grid gap-2 rounded-(--radius-md) bg-(--color-surface-inset) p-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot status="passed" label="Git repository" />
        {probe.branch !== null && (
          <span className="text-(length:--text-xs) text-(--color-text-muted)">
            {/* Named "checked out" rather than "branch": the field below asks for the
                default branch, and one label reading "branch" next to another meaning
                a different branch is how #100 stayed invisible. */}
            checked out <Code>{probe.branch}</Code>
          </span>
        )}
        {probe.headSha !== null && (
          <span className="text-(length:--text-xs) text-(--color-text-muted)">
            head <Code>{probe.headSha.slice(0, 7)}</Code>
          </span>
        )}
      </div>

      {probe.dirty && (
        <p className="m-0 text-(length:--text-xs) text-(--color-text-muted)">
          {probe.dirtyCount} uncommitted change{probe.dirtyCount === 1 ? '' : 's'}:{' '}
          {probe.dirtyPaths.slice(0, 3).join(', ')}
          {probe.dirtyCount > 3 ? '…' : ''}. This does not block creation — a workflow will capture
          its own base commit before an agent runs.
        </p>
      )}

      {warnings.map((warning) => (
        <Badge key={warning.code} tone="warning">
          {warning.detail}
        </Badge>
      ))}
    </div>
  )
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function splitLines(value: string): readonly string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}
