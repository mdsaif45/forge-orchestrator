import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { unwrap } from './ipc'

/**
 * Placeholder shell. The real sidebar / routing / status strip arrives in #11,
 * built from the design-system primitives created in #10.
 *
 * It calls across the IPC boundary so the wiring is exercised rather than
 * assumed.
 */
export function App(): React.JSX.Element {
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
    <main className="shell">
      <h1>{info?.name ?? 'Forge'}</h1>
      <p className="tagline">AI engineering control plane</p>

      {error !== null ? (
        <p className="error">{error}</p>
      ) : info === null ? (
        <p className="tagline">connecting…</p>
      ) : (
        <dl className="versions">
          <dt>version</dt>
          <dd>{info.version}</dd>
          <dt>platform</dt>
          <dd>{info.platform}</dd>
          <dt>electron</dt>
          <dd>{info.versions.electron}</dd>
          <dt>chrome</dt>
          <dd>{info.versions.chrome}</dd>
          <dt>node</dt>
          <dd>{info.versions.node}</dd>
        </dl>
      )}
    </main>
  )
}
