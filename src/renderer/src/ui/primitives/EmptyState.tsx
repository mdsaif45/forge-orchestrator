import { cn } from '../cn'

/**
 * The state most screens are in first.
 *
 * Forge has many lists that are empty until a workflow runs, so an empty state
 * says what would appear here and offers the action that fills it — never a bare
 * "No data".
 */
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly title: string
  readonly description?: string
  readonly icon?: React.ReactNode
  readonly action?: React.ReactNode
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  ...props
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      {icon !== undefined ? (
        <div className="text-(--color-text-subtle)" aria-hidden="true">
          {icon}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <p className="text-(length:--text-base) font-medium text-(--color-text)">{title}</p>
        {description !== undefined ? (
          <p className="max-w-prose text-(length:--text-xs) text-(--color-text-muted)">
            {description}
          </p>
        ) : null}
      </div>

      {action !== undefined ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
