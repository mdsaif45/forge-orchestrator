import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { unwrap } from './ipc'
import { KitchenSink } from './dev/KitchenSink'
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Code,
  EmptyState,
  Separator,
  Spinner,
  StatusDot,
  ToastProvider,
  useTheme,
} from './ui'

/**
 * Placeholder shell, built entirely from design-system primitives — no bespoke
 * styling for anything the system already covers. The real sidebar, routing, and
 * status strip arrive in #11.
 */
export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

function Shell(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSink, setShowSink] = useState(false)

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
    <div className="flex h-full flex-col bg-(--color-canvas)">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--color-surface) px-3">
        <span className="text-(length:--text-sm) font-semibold">{info?.name ?? 'Forge'}</span>
        <Separator orientation="vertical" className="h-4" />
        <span className="inline-flex items-center gap-1.5 text-(length:--text-xs) text-(--color-text-muted)">
          <StatusDot status="idle" label="idle" />
          idle
        </span>

        <div className="ml-auto flex items-center gap-2">
          <Badge tone="neutral" size="sm">
            pre-alpha
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setShowSink((current) => !current)}>
            {showSink ? 'Back' : 'Kitchen sink'}
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleTheme}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {showSink ? (
          <KitchenSink />
        ) : (
          <div className="grid h-full place-content-center gap-4">
            <EmptyState
              title="AI engineering control plane"
              description="Forge owns the project truth; agents perform the work. Milestone M0 in progress."
              action={
                error !== null ? (
                  <Badge tone="danger">{error}</Badge>
                ) : info === null ? (
                  <Spinner label="Connecting to main process" />
                ) : (
                  <Card tone="raised" className="text-left">
                    <CardHeader>
                      <div>
                        <CardTitle>Runtime</CardTitle>
                        <CardDescription>Reported over the IPC contract</CardDescription>
                      </div>
                      <StatusDot status="passed" label="connected" />
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
            />
          </div>
        )}
      </main>
    </div>
  )
}
