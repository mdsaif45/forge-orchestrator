import { cn } from '../lib/cn'

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly orientation?: 'vertical' | 'horizontal' | 'both'
}

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
        '[scrollbar-color:var(--color-border-strong)_transparent] [scrollbar-width:thin]',
        '[&::-webkit-scrollbar]:size-2',
        '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-(--color-border)',
        '[&::-webkit-scrollbar-thumb:hover]:bg-(--color-border-strong)',
        '[&::-webkit-scrollbar-track]:bg-transparent',
        className,
      )}
      {...props}
    />
  )
}
