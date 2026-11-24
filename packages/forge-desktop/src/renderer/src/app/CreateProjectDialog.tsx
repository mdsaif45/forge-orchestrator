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
  Spinner,
  StatusDot,
  Textarea,
  useToast,
} from '../ui'
import { DefaultBranchField } from './DefaultBranchField'
import { useProjectStore } from './projectStore'

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
 * Clean and streamlined project creation dialog.
 * Remounts form state per open lifecycle.
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
  const [rules, setRules] = useState('')

  const [probe, setProbe] = useState<RepositoryProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

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

      if (result.isRepository && result.defaultBranch !== null) {
        setBranch((curr) => (curr === '' ? (result.defaultBranch ?? '') : curr))
      }

      // Auto-suggest project name from repository folder basename if name is empty
      if (result.isRepository) {
        setName((curr) => {
          if (curr.trim() !== '') return curr
          const cleanPath = candidate.replace(/[/\\]+$/, '')
          const parts = cleanPath.split(/[/\\]/)
          return parts[parts.length - 1] ?? ''
        })
      }
    } catch (cause) {
      if (probeToken.current !== token) return
      setProbe(null)
      setSubmitError(cause instanceof Error ? cause.message : 'Could not read that folder')
    } finally {
      if (probeToken.current === token) setProbing(false)
    }
  }, [])

  // Debounced directory probing
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
  const repositoryValid = probe?.isRepository === true && blocker === null
  const canSubmit = nameValid && repositoryValid && !probing && !submitting

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      const created = await createProject({
        name: name.trim(),
        repositoryPath: path.trim(),
        defaultBranch: branch.trim() !== '' ? branch.trim() : (probe.defaultBranch ?? 'main'),
        buildCommand: null,
        testCommand: null,
        tech: [],
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
      description="Connect a repository workspace. Agents will run tasks in isolated worktrees."
      size="md"
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
              variant="primary"
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
        {/* Project Name */}
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

        {/* Repository Path */}
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

        <DefaultBranchField probe={probe} value={branch} onChange={setBranch} />

        {/* Project Rules */}
        <Field
          label="Rules"
          hint="Project-specific guidelines injected into agent workflows (e.g. 'strictly type all code changes')."
        >
          {(bind) => (
            <Textarea
              {...bind}
              rows={3}
              value={rules}
              placeholder="never modify migrations without approval&#10;strictly type all code changes"
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
    <div className="grid gap-2 rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot status="passed" label="Git repository" />
        {probe.branch !== null && (
          <span className="text-[12px] text-(--color-text-muted)">
            branch <Code>{probe.branch}</Code>
          </span>
        )}
        {probe.defaultBranch !== null && (
          <span className="text-[12px] text-(--color-text-muted)">
            default <Code>{probe.defaultBranch}</Code>
          </span>
        )}
        {probe.headSha !== null && (
          <span className="text-[12px] text-(--color-text-muted)">
            head <Code>{probe.headSha.slice(0, 7)}</Code>
          </span>
        )}
      </div>

      {probe.dirty && (
        <p className="m-0 text-[11px] text-(--color-text-muted)">
          {probe.dirtyCount} uncommitted change{probe.dirtyCount === 1 ? '' : 's'}. This does not
          block creation — a workflow will capture its own base commit.
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

function splitLines(value: string): readonly string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}
