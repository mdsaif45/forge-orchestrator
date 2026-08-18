import { useId, useState } from 'react'
import { cn } from '../cn'

export interface TooltipProps {
  readonly content: string
  readonly side?: 'top' | 'bottom' | 'left' | 'right'
  readonly children: React.ReactNode
  readonly className?: string
}

/**
 * A hover/focus tooltip.
 *
 * Focus triggers it as well as hover, so keyboard users get the same
 * information. Content is always supplementary — never the only place a critical
 * label appears, since a tooltip is unreachable on touch and easy to miss.
 */
export function Tooltip({
  content,
  side = 'top',
  children,
  className,
}: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const id = useId()

  const position = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[side]

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      aria-describedby={visible ? id : undefined}
    >
      {children}

      {visible ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'absolute z-(--z-tooltip) w-max max-w-64',
            'rounded-(--radius-md) border border-(--color-border-strong) bg-(--color-surface-overlay)',
            'px-2 py-1 text-(length:--text-xs) text-(--color-text) shadow-(--shadow-md)',
            'pointer-events-none',
            position,
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
