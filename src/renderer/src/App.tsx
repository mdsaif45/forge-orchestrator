import { APP_NAME } from '@shared/app'

/**
 * Placeholder shell. The real sidebar / routing / status strip arrives in #11,
 * built from the design-system primitives created in #10.
 */
export function App(): React.JSX.Element {
  const { electron, chrome, node } = window.forge.versions

  return (
    <main className="shell">
      <h1>{APP_NAME}</h1>
      <p className="tagline">AI engineering control plane</p>
      <dl className="versions">
        <dt>electron</dt>
        <dd>{electron}</dd>
        <dt>chrome</dt>
        <dd>{chrome}</dd>
        <dt>node</dt>
        <dd>{node}</dd>
      </dl>
    </main>
  )
}
