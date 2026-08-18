import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
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
  Spinner,
  StatusDot,
} from '../ui'
import { ROUTES } from './routes'

const OVERVIEW = ROUTES[0]

/**
 * Overview.
 *
 * The only route with real data at this stage: it reads app identity over the IPC
 * contract, which keeps the boundary exercised by the app itself rather than only
 * by the checks. Project state arrives in #18.
 */
export function Overview(): React.JSX.Element {
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

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">
            {OVERVIEW.label}
          </h1>
        </div>

        <div className="grid flex-1 place-content-center gap-6 p-6">
          <EmptyState
            title={OVERVIEW.empty.title}
            description={OVERVIEW.empty.description}
            action={<RuntimeCard info={info} error={error} />}
          />
        </div>
      </div>
    </ScrollArea>
  )
}

function RuntimeCard({
  info,
  error,
}: {
  readonly info: AppInfo | null
  readonly error: string | null
}): React.JSX.Element {
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
          <div key={label} className="contents">
            <dt className="text-(--color-text-muted)">{label}</dt>
            <dd className="m-0">
              <Code>{value}</Code>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
