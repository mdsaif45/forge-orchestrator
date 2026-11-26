import { cn } from '../lib/cn'

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
          <p className="max-w-prose typography-meta text-(--color-text-muted)">{description}</p>
        ) : null}
      </div>

      {action !== undefined ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
