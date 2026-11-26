import type React from 'react'
import { cn } from '../lib/cn'
import { FORGE_ICON_REGISTRY, type ForgeIconName } from './registry'

export interface IconProps {
  /** Semantic icon identifier registered in `@forge/ui`. */
  readonly name: ForgeIconName
  /** Optional Tailwind utility classes (e.g. `size-4`, `text-(--color-accent)`). */
  readonly className?: string | undefined
  /** Stroke thickness aligned to a 16px/24px crisp grid (default 1.75). */
  readonly strokeWidth?: number | undefined
  /** Optional accessible label when used standalone without surrounding button/text label. */
  readonly label?: string | undefined
  /** Enables gentle continuous rotation for active spinners. */
  readonly spin?: boolean | undefined
}

/**
 * Standardized vector icon primitive backed by `lucide-react`.
 *
 * Defaults to `aria-hidden="true"` when rendered alongside text or inside a labelled
 * `IconButton`, or sets `role="img"` + `aria-label` when `label` is provided.
 */
export function Icon({
  name,
  className,
  strokeWidth = 1.75,
  label,
  spin = false,
}: IconProps): React.JSX.Element {
  const Component = FORGE_ICON_REGISTRY[name]

  return (
    <Component
      strokeWidth={strokeWidth}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : 'img'}
      className={cn('size-4 shrink-0', spin && 'animate-spin', className)}
    />
  )
}
