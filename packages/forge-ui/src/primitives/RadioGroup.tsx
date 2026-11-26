import { Radio as BaseRadio } from '@base-ui/react/radio'
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group'
import { useId } from 'react'
import { cn } from '../lib/cn'

export interface RadioGroupOption<T extends string = string> {
  readonly value: T
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

export interface RadioGroupProps<T extends string = string> {
  readonly options: readonly RadioGroupOption<T>[]
  readonly value?: T | undefined
  readonly defaultValue?: T | undefined
  readonly onValueChange?: ((value: T) => void) | undefined
  readonly disabled?: boolean | undefined
  readonly orientation?: 'vertical' | 'horizontal'
  readonly className?: string | undefined
  readonly 'aria-label'?: string | undefined
}

export function RadioGroup<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  disabled,
  orientation = 'vertical',
  className,
  'aria-label': ariaLabel,
}: RadioGroupProps<T>): React.JSX.Element {
  const groupId = useId()

  return (
    <BaseRadioGroup
      value={value}
      defaultValue={defaultValue}
      onValueChange={
        onValueChange !== undefined
          ? (next) => {
              onValueChange(next)
            }
          : undefined
      }
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'flex gap-2.5',
        orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap items-center',
        className,
      )}
    >
      {options.map((opt) => {
        const itemId = `${groupId}-${opt.value}`
        return (
          <div key={opt.value} className="flex items-start gap-2.5">
            <BaseRadio.Root
              id={itemId}
              value={opt.value}
              disabled={opt.disabled}
              className={cn(
                'mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full',
                'border border-(--color-edge-strong) bg-(--color-surface-inset)',
                'transition-colors duration-(--duration-fast) ease-(--ease-out)',
                'data-[checked]:border-(--color-accent)',
                'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <BaseRadio.Indicator className="size-2 rounded-full bg-(--color-accent)" />
            </BaseRadio.Root>
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor={itemId}
                className="cursor-pointer typography-ui-label text-(--color-text) select-none"
              >
                {opt.label}
              </label>
              {opt.description !== undefined ? (
                <span className="typography-meta text-(--color-text-subtle)">
                  {opt.description}
                </span>
              ) : null}
            </div>
          </div>
        )
      })}
    </BaseRadioGroup>
  )
}
