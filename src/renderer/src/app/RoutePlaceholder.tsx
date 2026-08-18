import { EmptyState, ScrollArea } from '../ui'
import type { Route } from './routes'

/**
 * The placeholder every route renders until its feature is built.
 *
 * Each empty state names what will appear there and why, rather than saying "no
 * data" — these screens are empty for real users too, right up until a workflow
 * runs, so the copy has to earn its place.
 */
export function RoutePlaceholder({ route }: { readonly route: Route }): React.JSX.Element {
  return (
    <ScrollArea className="h-full">
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">
            {route.label}
          </h1>
        </div>

        <div className="grid flex-1 place-content-center">
          <EmptyState title={route.empty.title} description={route.empty.description} />
        </div>
      </div>
    </ScrollArea>
  )
}
