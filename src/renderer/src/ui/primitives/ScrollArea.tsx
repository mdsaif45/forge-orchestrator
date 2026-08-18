import { cn } from '../cn'

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly orientation?: 'vertical' | 'horizontal' | 'both'
}

/**
 * A scroll container with a restrained scrollbar.
 *
 * Native overflow, not a virtualized or JS-driven scroller: Forge's long
 * surfaces are agent logs and diffs, where the browser's own scrolling and
 * find-in-page behaviour are worth keeping. Virtualization belongs in the
 * specific views that measure a need for it.
 */
export function ScrollArea({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaProps): React.JSX.Element {
  return (
    <div
      className={cn(
        orientation === 'vertical' && 'overflow-y-auto',
        orientation === 'horizontal' && 'overflow-x-auto',
        orientation === 'both' && 'overflow-auto',
        // Thin, low-contrast until hovered — a log view should not be dominated
        // by its own scrollbar.
        '[scrollbar-color:var(--color-border-strong)_transparent] [scrollbar-width:thin]',
        '[&::-webkit-scrollbar]:size-2.5',
        '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-(--color-border)',
        '[&::-webkit-scrollbar-thumb:hover]:bg-(--color-border-strong)',
        '[&::-webkit-scrollbar-track]:bg-transparent',
        className,
      )}
      {...props}
    />
  )
}
