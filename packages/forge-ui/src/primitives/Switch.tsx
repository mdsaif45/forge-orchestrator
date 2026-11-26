import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { useId } from 'react'
import { cn } from '../lib/cn'

export interface SwitchProps {
  readonly checked?: boolean | undefined
  readonly defaultChecked?: boolean | undefined
  readonly onCheckedChange?: ((checked: boolean) => void) | undefined
  readonly disabled?: boolean | undefined
  readonly label?: string | undefined
  readonly hint?: string | undefined
  readonly className?: string | undefined
  readonly 'aria-label'?: string | undefined
}

export function Switch({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  label,
  hint,
  className,
  'aria-label': ariaLabel,
}: SwitchProps): React.JSX.Element {
  const id = useId()
  const root = (
    <BaseSwitch.Root
      id={label !== undefined ? id : undefined}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={
        onCheckedChange !== undefined
          ? (next) => {
              onCheckedChange(next)
            }
          : undefined
      }
      disabled={disabled}
      aria-label={label === undefined ? ariaLabel : undefined}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-(--color-edge)',
        'bg-(--color-surface-inset) transition-colors duration-(--duration-fast) ease-(--ease-out)',
        'data-[checked]:border-(--color-accent) data-[checked]:bg-(--color-accent)',
        'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-canvas)',
        'disabled:cursor-not-allowed disabled:opacity-50',
        label === undefined && className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block size-3.5 translate-x-0.5 rounded-full bg-white shadow-xs',
          'transition-transform duration-(--duration-fast) ease-(--ease-out) data-[checked]:translate-x-4.5',
        )}
      />
    </BaseSwitch.Root>
  )

  if (label === undefined) return root

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      {root}
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer typography-ui-label text-(--color-text)">
          {label}
        </label>
        {hint !== undefined ? (
          <span className="typography-meta text-(--color-text-subtle)">{hint}</span>
        ) : null}
      </div>
    </div>
  )
}
