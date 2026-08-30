import { useEffect, useState } from 'react'
import type { AppInfo, ProjectDetail } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  ScrollArea,
  Separator,
  Spinner,
  StatusDot,
} from '../ui'
import { EditProjectDialog } from './EditProjectDialog'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'
import { useUiStore } from './uiStore'

const OVERVIEW = ROUTES[0]

/**
 * Overview — the bound repository as Forge currently sees it.
 *
 * When no project is selected, presents an inviting welcome launcher with quick
 * actions and streamlined system environment telemetry.
 */
export function Overview(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const loading = useProjectStore((state) => state.loading)
  const error = useProjectStore((state) => state.error)

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-[16px] font-semibold text-(--color-text)">
            {detail?.project.name ?? OVERVIEW.label}
          </h1>
        </div>

        {error !== null ? (
          <div className="grid flex-1 place-content-center gap-6 p-6">
            <Badge tone="danger">{error}</Badge>
          </div>
        ) : loading && detail === null ? (
          <div className="grid flex-1 place-content-center gap-6 p-6">
            <Spinner label="Loading projects" />
          </div>
        ) : detail === null ? (
          <WelcomeWorkspace />
        ) : (
          <ProjectSummary detail={detail} />
        )}
      </div>
    </ScrollArea>
  )
}

function WelcomeWorkspace(): React.JSX.Element {
  const openCreateProject = useUiStore((state) => state.openCreateProject)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 px-6 py-12 text-center animate-in fade-in duration-200">
      {/* Hero Welcome Banner */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-(--color-accent)/15 text-(--color-accent) text-2xl font-bold shadow-sm ring-1 ring-(--color-accent)/30">
          ⚡
        </div>
        <h2 className="text-[22px] font-bold tracking-tight text-(--color-text)">
          Welcome to Forge
        </h2>
        <p className="max-w-lg text-[13px] leading-relaxed text-(--color-text-muted)">
          An autonomous agent orchestrator with Git worktree isolation, decision locking,
          and verifiable automated milestones.
        </p>
      </div>

      {/* Primary Call to Action */}
      <div className="flex flex-col items-center gap-2">
        <Button
          size="lg"
          variant="primary"
          onClick={openCreateProject}
          className="rounded-xl px-6 py-2.5 text-[13px] font-semibold shadow-md"
        >
          <span className="mr-1.5 text-base font-bold">+</span> Open or Create Project
        </Button>
        <span className="text-[11px] text-(--color-text-subtle)">
          Bind any local git repository to start orchestrating workflows
        </span>
      </div>

      {/* Feature Highlights Grid */}
      <div className="grid w-full grid-cols-1 gap-4 text-left md:grid-cols-3">
        <div className="flex flex-col gap-1.5 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4 shadow-xs">
          <div className="flex items-center gap-2 font-semibold text-(--color-text) text-[13px]">
            <span>📁</span> Git Repository Binding
          </div>
          <p className="text-[12px] text-(--color-text-muted) leading-relaxed">
            Live branch detection, dirty file tracking, and automatic tech stack analysis from git metadata.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4 shadow-xs">
          <div className="flex items-center gap-2 font-semibold text-(--color-text) text-[13px]">
            <span>🔒</span> Decision Locking
          </div>
          <p className="text-[12px] text-(--color-text-muted) leading-relaxed">
            Every architectural decision must be explicitly approved and locked before agents can write code.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-4 shadow-xs">
          <div className="flex items-center gap-2 font-semibold text-(--color-text) text-[13px]">
            <span>🌳</span> Worktree Isolation
          </div>
          <p className="text-[12px] text-(--color-text-muted) leading-relaxed">
            Multi-agent execution runs in dedicated worktrees, protecting your active working tree and branch.
          </p>
        </div>
      </div>

      {/* Streamlined System Telemetry & Environment Bar */}
      <div className="w-full">
        <RuntimeCard />
      </div>
    </div>
  )
}

function ProjectSummary({ detail }: { readonly detail: ProjectDetail }): React.JSX.Element {
  const refresh = useProjectStore((state) => state.refresh)
  const [editing, setEditing] = useState(false)

  const { project, rules, probe } = detail

  return (
    <div className="grid gap-4 p-6">
      <Card tone="raised">
        <CardHeader>
          <div>
            <CardTitle>Repository</CardTitle>
            <CardDescription>Read from git on every load, never cached</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(true)
              }}
            >
              Edit settings
            </Button>
            {probe === null ? (
              <StatusDot status="failed" label="Unavailable" />
            ) : (
              <StatusDot status={probe.dirty ? 'waiting' : 'passed'} label="Bound" />
            )}
          </div>
        </CardHeader>

        {editing && (
          <EditProjectDialog
            open
            project={project}
            probe={probe}
            onClose={() => {
              setEditing(false)
            }}
            onSaved={refresh}
          />
        )}

        {probe === null ? (
          <p className="mt-3 mb-0 text-(length:--text-xs) text-(--color-text-muted)">
            The bound folder is no longer a readable git repository. It may have been moved,
            deleted, or had its <Code>.git</Code> directory removed.
          </p>
        ) : null}

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-(length:--text-xs)">
          <Row label="path">
            <Code>{project.repository.absolutePath}</Code>
          </Row>
          <Row label="default branch">
            <Code>{project.repository.defaultBranch}</Code>
          </Row>
          {probe !== null && (
            <>
              <Row label="current branch">
                {probe.branch === null ? (
                  <Badge tone="warning">detached</Badge>
                ) : (
                  <Code>{probe.branch}</Code>
                )}
              </Row>
              <Row label="head">
                {probe.headSha === null ? (
                  <Badge tone="warning">no commits</Badge>
                ) : (
                  <Code>{probe.headSha.slice(0, 12)}</Code>
                )}
              </Row>
              <Row label="worktree">
                {probe.dirty ? (
                  <span className="text-(--color-text-muted)">
                    {probe.dirtyCount} uncommitted change{probe.dirtyCount === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-(--color-text-muted)">clean</span>
                )}
              </Row>
            </>
          )}
        </dl>

        <Separator className="my-3" />

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-(length:--text-xs)">
          <Row label="build">
            {project.repository.buildCommand === null ? (
              <span className="text-(--color-text-muted)">not set</span>
            ) : (
              <Code>{project.repository.buildCommand}</Code>
            )}
          </Row>
          <Row label="test">
            {project.repository.testCommand === null ? (
              <span className="text-(--color-text-muted)">not set</span>
            ) : (
              <Code>{project.repository.testCommand}</Code>
            )}
          </Row>
        </dl>

        {project.repository.tech.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {project.repository.tech.map((tag) => (
              <Badge key={tag} tone="neutral" size="sm">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      <Card tone="raised">
        <CardHeader>
          <div>
            <CardTitle>Rules</CardTitle>
            <CardDescription>
              Applied to every workflow in this project. Most specific scope wins.
            </CardDescription>
          </div>
          <Badge tone="neutral" size="sm">
            {rules.length}
          </Badge>
        </CardHeader>

        {rules.length === 0 ? (
          <p className="mt-3 mb-0 text-(length:--text-xs) text-(--color-text-muted)">
            No project rules yet.
          </p>
        ) : (
          <ul className="mt-3 grid list-none gap-1.5 p-0">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-start gap-2 text-(length:--text-xs)">
                <Badge tone="neutral" size="sm">
                  {rule.scope}
                </Badge>
                <span className="text-(--color-text)">{rule.statement}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="contents">
      <dt className="text-(--color-text-muted)">{label}</dt>
      <dd className="m-0 min-w-0 break-all">{children}</dd>
    </div>
  )
}

/**
 * Clean, compact System Environment & Runtime telemetry bar.
 *
 * Verifies IPC bridge connectivity across the sandboxed renderer boundary
 * while presenting a polished, non-intrusive status layout.
 */
function RuntimeCard(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.forge.app
      .getInfo()
      .then(unwrap)
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unknown error')
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (error !== null) return <Badge tone="danger">{error}</Badge>
  if (info === null) return <Spinner label="Connecting to engine" />

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-surface-raised)/70 px-4 py-2.5 text-[11px] shadow-xs">
      <div className="flex items-center gap-2">
        <StatusDot status="passed" label="Engine Connected" />
        <span className="font-semibold text-(--color-text)">Forge Engine Active</span>
        <span className="font-mono text-(--color-text-muted)">v{info.version}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-(--color-text-muted)">
        <span className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 border border-(--color-border)">
          Electron {info.versions.electron}
        </span>
        <span className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 border border-(--color-border)">
          Node {info.versions.node}
        </span>
        <span className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 border border-(--color-border)">
          Chromium {info.versions.chrome.split('.')[0]}
        </span>
        <span className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 border border-(--color-border)">
          {info.platform}
        </span>
      </div>
    </div>
  )
}
