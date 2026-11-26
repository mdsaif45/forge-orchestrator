import { cn } from '../lib/cn'

export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  readonly tone?: 'surface' | 'canvas' | 'raised' | undefined
}

export function Panel({ tone = 'surface', className, ...props }: PanelProps): React.JSX.Element {
  return (
    <section
      data-slot="panel"
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-(--radius-xl) border border-(--color-edge)',
        tone === 'canvas' && 'bg-(--color-canvas)',
        tone === 'surface' && 'bg-(--color-surface)',
        tone === 'raised' && 'bg-(--color-surface-raised) shadow-(--elevation-raised)',
        className,
      )}
      {...props}
    />
  )
}

export interface PanelHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  readonly title?: React.ReactNode | undefined
  readonly subtitle?: React.ReactNode | undefined
  readonly actions?: React.ReactNode | undefined
}

export function PanelHeader({
  title,
  subtitle,
  actions,
  className,
  children,
  ...props
}: PanelHeaderProps): React.JSX.Element {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-(--color-edge-muted) px-3 py-2',
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <div className="flex min-w-0 flex-col">
            {title !== undefined ? (
              <div className="truncate typography-ui-header text-(--color-text)">{title}</div>
            ) : null}
            {subtitle !== undefined ? (
              <div className="truncate typography-meta text-(--color-text-muted)">{subtitle}</div>
            ) : null}
          </div>
          {actions !== undefined ? (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          ) : null}
        </>
      )}
    </header>
  )
}

export function PanelBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-slot="panel-body"
      className={cn('min-h-0 flex-1 overflow-y-auto p-3', className)}
      {...props}
    />
  )
}

export function PanelFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <footer
      data-slot="panel-footer"
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-t border-(--color-edge-muted) px-3 py-2',
        className,
      )}
      {...props}
    />
  )
}

export interface SplitPaneProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly primary: React.ReactNode
  readonly secondary?: React.ReactNode | undefined
  readonly showSecondary?: boolean | undefined
}

export function SplitPane({
  primary,
  secondary,
  showSecondary = true,
  className,
  ...props
}: SplitPaneProps): React.JSX.Element {
  return (
    <div
      data-slot="split-pane"
      className={cn('flex min-h-0 flex-1 overflow-hidden', className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{primary}</div>
      {showSecondary && secondary !== undefined ? (
        <aside className="flex min-h-0 w-96 shrink-0 flex-col border-l border-(--color-edge) bg-(--color-surface)">
          {secondary}
        </aside>
      ) : null}
    </div>
  )
}
