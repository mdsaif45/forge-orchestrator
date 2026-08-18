import { useEffect, useState } from 'react'
import type { AppInfo, ProjectDetail } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  ScrollArea,
  Separator,
  Spinner,
  StatusDot,
} from '../ui'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'

const OVERVIEW = ROUTES[0]

/**
 * Overview — the bound repository as Forge currently sees it.
 *
 * Repository facts (branch, head SHA, whether the tree is dirty) come from a live
 * probe on every read rather than from what was stored at creation: the branch
 * moves and commits land between one open and the next, so a stored copy would be a
 * second truth that quietly goes stale (axiom A1).
 */
export function Overview(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const loading = useProjectStore((state) => state.loading)
  const error = useProjectStore((state) => state.error)

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">
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
          <div className="grid flex-1 place-content-center gap-6 p-6">
            <EmptyState
              title={OVERVIEW.empty.title}
              description={OVERVIEW.empty.description}
              action={<RuntimeCard />}
            />
          </div>
        ) : (
          <ProjectSummary detail={detail} />
        )}
      </div>
    </ScrollArea>
  )
}

function ProjectSummary({ detail }: { readonly detail: ProjectDetail }): React.JSX.Element {
  const { project, rules, probe } = detail

  return (
    <div className="grid gap-4 p-6">
      <Card tone="raised">
        <CardHeader>
          <div>
            <CardTitle>Repository</CardTitle>
            <CardDescription>Read from git on every load, never cached</CardDescription>
          </div>
          {probe === null ? (
            <StatusDot status="failed" label="Unavailable" />
          ) : (
            <StatusDot status={probe.dirty ? 'waiting' : 'passed'} label="Bound" />
          )}
        </CardHeader>

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
 * Runtime identity, shown while no project exists.
 *
 * Keeps the IPC boundary exercised by the app itself on first run, rather than only
 * by the checks — the first thing to break after a build change is usually the
 * bridge, and this makes that visible immediately.
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
  if (info === null) return <Spinner label="Connecting to the main process" />

  return (
    <Card tone="raised" className="text-left">
      <CardHeader>
        <div>
          <CardTitle>Runtime</CardTitle>
          <CardDescription>Reported over the IPC contract</CardDescription>
        </div>
        <StatusDot status="passed" label="Connected" />
      </CardHeader>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-(length:--text-xs)">
        {[
          ['version', info.version],
          ['platform', info.platform],
          ['electron', info.versions.electron],
          ['chrome', info.versions.chrome],
          ['node', info.versions.node],
        ].map(([label, value]) => (
          <Row key={label} label={label ?? ''}>
            <Code>{value}</Code>
          </Row>
        ))}
      </dl>
    </Card>
  )
}
