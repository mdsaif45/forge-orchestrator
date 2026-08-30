import { useEffect, useRef, useState } from 'react'
import { cn } from '../cn'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectProps {
  readonly options: readonly SelectOption[]
  readonly value?: string
  readonly onChange?: (event: { target: { value: string; name?: string } }) => void
  readonly placeholder?: string
  readonly invalid?: boolean
  readonly disabled?: boolean
  readonly className?: string
  readonly name?: string
  readonly id?: string
  readonly 'aria-label'?: string
}

/**
 * A custom, accessible dropdown select designed with Claude Code Desktop aesthetic.
 *
 * Replaces unstyled native OS select elements with a clean, floating popover card,
 * smooth hover transitions, active checkmarks, and full keyboard navigation.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  invalid = false,
  disabled = false,
  className,
  name,
  id,
  'aria-label': ariaLabel,
}: SelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState<number>(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)

  const selectedOption = options.find((o) => o.value === value)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return

    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIsOpen(true)
        const activeIdx = options.findIndex((o) => o.value === value)
        setFocusedIndex(activeIdx >= 0 ? activeIdx : 0)
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        break
      case 'ArrowDown': {
        e.preventDefault()
        setFocusedIndex((prev) => {
          let next = prev + 1
          while (next < options.length && options[next]?.disabled) {
            next++
          }
          return next < options.length ? next : prev
        })
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        setFocusedIndex((prev) => {
          let next = prev - 1
          while (next >= 0 && options[next]?.disabled) {
            next--
          }
          return next >= 0 ? next : prev
        })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (focusedIndex >= 0 && focusedIndex < options.length) {
          const option = options[focusedIndex]
          if (option && !option.disabled) {
            if (name !== undefined) {
              onChange?.({ target: { value: option.value, name } })
            } else {
              onChange?.({ target: { value: option.value } })
            }
            setIsOpen(false)
          }
        }
        break
      }
      case 'Tab':
        setIsOpen(false)
        break
    }
  }

  const handleSelect = (option: SelectOption): void => {
    if (option.disabled || disabled) return
    if (name !== undefined) {
      onChange?.({ target: { value: option.value, name } })
    } else {
      onChange?.({ target: { value: option.value } })
    }
    setIsOpen(false)
  }

  return (
    <div ref={containerRef} className={cn('relative inline-block w-full', className)}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setIsOpen(!isOpen)
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-left text-[13px]',
          'bg-(--color-surface-raised) text-(--color-text) shadow-xs transition-all duration-(--duration-fast) cursor-pointer select-none',
          'outline-none focus-visible:border-(--color-border-focus) focus-visible:ring-2 focus-visible:ring-(--color-border-focus)/25',
          'hover:border-(--color-border-strong)',
          invalid && 'border-(--color-danger)',
          !invalid && 'border-(--color-border)',
          disabled && 'cursor-not-allowed opacity-50 bg-(--color-surface-inset)',
        )}
      >
        <span className="truncate">
          {selectedOption?.label ?? placeholder ?? 'Select an option'}
        </span>

        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-(--color-text-muted) transition-transform duration-(--duration-fast)',
            isOpen && 'rotate-180 text-(--color-text)',
          )}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute left-0 top-[calc(100%+4px)] z-50 min-w-full rounded-xl border border-(--color-border)',
            'bg-(--color-surface-raised) p-1 shadow-xl backdrop-blur-md',
            'animate-in fade-in zoom-in-95 duration-100',
          )}
        >
          <ul
            ref={listboxRef}
            role="listbox"
            tabIndex={-1}
            className="max-h-60 overflow-y-auto outline-none"
          >
            {placeholder !== undefined && (
              <li
                role="option"
                aria-selected={false}
                aria-disabled={true}
                className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle) select-none"
              >
                {placeholder}
              </li>
            )}

            {options.map((option, idx) => {
              const isSelected = option.value === value
              const isFocused = idx === focusedIndex

              return (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled}
                  onClick={() => {
                    handleSelect(option)
                  }}
                  onMouseEnter={() => {
                    setFocusedIndex(idx)
                  }}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors select-none cursor-pointer',
                    option.disabled && 'cursor-not-allowed opacity-40',
                    !option.disabled && isSelected && 'bg-(--color-accent-muted) font-semibold text-(--color-text)',
                    !option.disabled && !isSelected && isFocused && 'bg-(--color-surface) text-(--color-text)',
                    !option.disabled && !isSelected && !isFocused && 'text-(--color-text) hover:bg-(--color-surface)',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && (
                    <svg
                      viewBox="0 0 16 16"
                      className="size-3.5 shrink-0 text-(--color-accent)"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M3.5 8.5l3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
